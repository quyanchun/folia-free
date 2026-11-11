"""Check that a catalog row really has an audio stream before it is shown.

Platform metadata is not trustworthy for this: Kugou public playlists mark
paid tracks as playable and only ``playInfo`` reveals the empty URL at play
time. This module reuses each provider's own URL resolution and fetches only
the first bytes of the stream, so browsing stays fast and no song is fully
downloaded. Verdicts are cached; temporary provider outages stay retryable.
"""
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path
from urllib.parse import urlsplit

import requests

_CORE = str(Path(__file__).resolve().parent)
_VENDOR = str(Path(_CORE) / 'vendor')
for entry in (_CORE, _VENDOR):
    if entry not in sys.path:
        sys.path.insert(0, entry)

# The vendored addon reads config while its class body is imported.
from music_dl import config
config.init()
from music_dl.addons.netease import NeteaseApi  # noqa: E402

import kugou  # noqa: E402
import kuwo  # noqa: E402
import migu  # noqa: E402
import qq  # noqa: E402

PLAYABLE = 'playable'
UNAVAILABLE = 'unavailable'
UNKNOWN = 'unknown'

GOOD_TTL = 1800.0  # a verified stream stays trusted; do not re-probe on every browse
BAD_TTL = 600.0
UNKNOWN_TTL = 30.0
SOURCE_COOLDOWN = 300.0  # stop asking a broken/limiting provider for five minutes
SOURCE_FAILURE_LIMIT = 2
BATCH_DEADLINE = 12.0
MAX_WORKERS = 4  # small enough not to trip provider rate limits during a browse
MAX_KEYS = 30
KEY_PATTERN = re.compile(r'[a-f0-9]{64}')

# Provider outages, rate limits and network errors must not blacklist a song.
TRANSIENT_MARKERS = ('暂时不可用', '请求频繁', '解析服务', '超时', 'timed out',
                     'timeout', 'connection', 'max retries', '502', '503',
                     'bad gateway', 'server error', 'temporarily')
NETEASE_HEADERS = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com/'}


def audio_signature(data):
    if not data:
        return None
    if data.startswith(b'ID3'):
        return 'id3'
    if data.startswith((b'fLaC', b'OggS', b'MAC ')):
        return 'lossless'
    if data.startswith(b'RIFF') and data[8:12] == b'WAVE':
        return 'wav'
    if data[4:8] == b'ftyp':
        return 'm4a'
    for index in range(min(len(data) - 1, 4090)):
        if data[index] == 0xFF and data[index + 1] & 0xE0 == 0xE0:
            return 'mpeg/adts'
    return None


def cached_audio_ok(file):
    """An already prepared file is the strongest evidence a song can play."""
    try:
        if file.stat().st_size < 4096:
            return False
        with file.open('rb') as handle:
            return audio_signature(handle.read(4096)) is not None
    except (OSError, ValueError):
        return False


def classify(error):
    text = str(error).lower()
    return UNKNOWN if any(marker in text for marker in TRANSIENT_MARKERS) else UNAVAILABLE


def resolve(song):
    """Return (url, headers) using exactly the same resolution as playback."""
    source, sid = song.get('source'), str(song.get('id') or '')
    if source == 'kugou':
        audio = kugou.resolve_audio(song.get('hash') or sid)
        return audio['url'], dict(kugou.FETCH_HEADERS)
    if source == 'kuwo':
        audio = kuwo.resolve_audio(sid)
        return audio['url'], dict(kuwo.HEADERS)
    if source == 'qq':
        url, _ = qq.resolve_audio(sid)
        return url, dict(qq.HEADERS)
    if source == 'migu':
        return migu.resolve_audio(sid), dict(migu.LISTEN_HEADERS)
    if source == 'netease':
        payload = NeteaseApi.encrypted_request(dict(ids=[sid], br=32000))
        response = requests.post('http://music.163.com/weapi/song/enhance/player/url',
                                 data=payload, headers=NETEASE_HEADERS, timeout=8)
        response.raise_for_status()
        rows = response.json().get('data') or []
        if not rows or not rows[0].get('url'):
            raise ValueError('未取得可下载音频')
        return rows[0]['url'], dict(NETEASE_HEADERS)
    if source == 'bilibili':
        # Video audio tracks are fetched per view; there is no stable URL to
        # preflight cheaply, so keep the metadata verdict for this source.
        raise ValueError('B站音轨按需解析')
    raise ValueError('未知音源')


def probe_stream(url, headers):
    """Read only the first block and require an audio signature."""
    request_headers = dict(headers)
    request_headers.update({'Range': 'bytes=0-4095', 'Accept-Encoding': 'identity'})
    try:
        response = requests.get(url, headers=request_headers, stream=True, timeout=(4, 6))
    except requests.RequestException as error:
        return UNKNOWN, f'{type(error).__name__}: {error}'
    try:
        chunk = next(response.iter_content(4096), b'') or b''
        if response.status_code not in (200, 206):
            return UNAVAILABLE, f'HTTP {response.status_code}'
        signature = audio_signature(chunk)
        if not signature or chunk.lstrip().lower().startswith((b'<!doctype', b'<html', b'<?xml', b'{"')):
            return UNAVAILABLE, '响应不是音频'
        return PLAYABLE, signature
    finally:
        response.close()


def check_one(song):
    # The download worker rejects these before resolving a URL; match it so a
    # verified row can never fail playback for a known static restriction.
    if song.get('playable') is False or song.get('downloadable') is False:
        return UNAVAILABLE, '平台标记不可播'
    # Bilibili audio is resolved per video view in the worker; there is no
    # stable URL to preflight, so keep trusting its metadata like before.
    if song.get('source') == 'bilibili':
        return PLAYABLE, '视频音轨按需解析'
    try:
        url, headers = resolve(song)
        return probe_stream(url, headers)
    except Exception as error:  # provider adapters raise several error types
        return classify(error), str(error)


class AvailabilityChecker:
    def __init__(self):
        self.verdicts = {}
        self.failures = {}
        self.cooldown = {}
        self.lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix='availability')

    @staticmethod
    def identity(song):
        return f"{song.get('source')}:{song.get('hash') or song.get('id')}"

    def _get(self, key):
        with self.lock:
            entry = self.verdicts.get(key)
        return entry[0] if entry and time.monotonic() < entry[1] else None

    def _put(self, key, state, ttl=None):
        if ttl is None:
            ttl = GOOD_TTL if state == PLAYABLE else BAD_TTL if state == UNAVAILABLE else UNKNOWN_TTL
        with self.lock:
            if len(self.verdicts) > 5000:
                self.verdicts.clear()
            self.verdicts[key] = (state, time.monotonic() + ttl)

    def _cooling(self, source):
        with self.lock:
            return time.monotonic() < self.cooldown.get(source, 0)

    def _outcome(self, source, state):
        with self.lock:
            if state == UNKNOWN:
                count = self.failures.get(source, 0) + 1
                self.failures[source] = count
                if count >= SOURCE_FAILURE_LIMIT:
                    self.cooldown[source] = time.monotonic() + SOURCE_COOLDOWN
            elif state == PLAYABLE:
                self.failures[source] = 0

    def check_many(self, songs):
        """Return one verdict per song; never block the caller past BATCH_DEADLINE."""
        states = [None] * len(songs)
        pending = []
        for index, song in enumerate(songs):
            key = self.identity(song)
            known = self._get(key)
            if known:
                states[index] = known
            elif self._cooling(song.get('source')):
                states[index] = UNKNOWN
            else:
                pending.append((index, key, song))
        if not pending:
            return states

        def task(song):
            # Queued work must not keep hitting a provider after it cooled down.
            if self._cooling(song.get('source')):
                return UNKNOWN, 'provider temporarily unavailable'
            return check_one(song)

        futures = {self.pool.submit(task, song): (index, key, song.get('source'))
                   for index, key, song in pending}
        done, pending_futures = wait(futures, timeout=BATCH_DEADLINE)
        for future in done:
            index, key, source = futures[future]
            try:
                state, _ = future.result()
            except Exception as error:
                state = classify(error)
            states[index] = state
            self._put(key, state)
            self._outcome(source, state)
        for future in pending_futures:
            index, key, source = futures[future]
            states[index] = UNKNOWN
            self._put(key, UNKNOWN, UNKNOWN_TTL)
            self._outcome(source, UNKNOWN)
            # A late answer is still useful for the next browse request.
            future.add_done_callback(lambda f, k=key, s=source: self._late(f, k, s))
        return states

    def _late(self, future, key, source):
        try:
            state, _ = future.result()
        except Exception as error:
            state = classify(error)
        self._put(key, state)
        self._outcome(source, state)


checker = AvailabilityChecker()
