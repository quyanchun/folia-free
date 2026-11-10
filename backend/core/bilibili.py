"""Bilibili audio as a search/download source (video soundtracks, not a music catalog).

Verified end to end on 2026-11-08: keyword search -> view(cid) -> playurl
dash audio -> full download -> ffprobe (AAC) -> FFmpeg decode. Different bvids
return different files, and the decoded duration matches the view metadata.

Limitations, by design:
  - Titles come from video uploads, so there is no structured artist/album;
    the uploader name is used as the "singer" field.
  - Only the first part (page) of a video is used.
  - The dash stream is fragmented MP4, so it is remuxed to a normal .m4a
    before tagging. No video track is downloaded.
  - CDN links are short-lived and are resolved at download time, never cached.

Bilibili has a single music-area video ranking, not the hot/new/rising music
charts this app models, so it is registered as a search source only.
"""
import datetime
import html
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

import requests

HEADERS = {'User-Agent': ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                          'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'),
           'Referer': 'https://www.bilibili.com/', 'Origin': 'https://www.bilibili.com'}
SEARCH_APIS = ('https://api.bilibili.com/x/web-interface/wbi/search/type',
               'https://api.bilibili.com/x/web-interface/search/type')
VIEW_API = 'https://api.bilibili.com/x/web-interface/view'
PLAY_API = 'https://api.bilibili.com/x/player/playurl'
STREAM_HOSTS = ('bilivideo.com', 'bilivideo.cn', 'bilicdn.com')


def clean_text(value):
    return html.unescape(re.sub(r'<[^>]+>', '', str(value or ''))).replace('\xa0', ' ').strip()


def _seconds(value):
    parts = str(value or '').strip().split(':')
    if not 1 <= len(parts) <= 3 or not all(p.isdigit() for p in parts):
        return 0
    total = 0
    for part in parts:
        total = total * 60 + int(part)
    return total


def _valid_audio(url):
    if not isinstance(url, str) or not url.startswith(('http://', 'https://')):
        return False
    host = (urlsplit(url).hostname or '').lower()
    return any(host == allowed or host.endswith('.' + allowed) for allowed in STREAM_HOSTS)


def search(keyword):
    items, last_error = [], None
    for api in SEARCH_APIS:
        try:
            response = requests.get(api, params={'search_type': 'video',
                                                 'keyword': keyword, 'page': 1},
                                    headers=HEADERS, timeout=10)
            response.raise_for_status()
            if len(response.content) > 3 * 1024 * 1024:
                raise ValueError('搜索响应异常')
            data = response.json()
            if data.get('code') != 0:
                raise ValueError(str(data.get('message') or '搜索接口返回异常'))
            items = (data.get('data') or {}).get('result') or []
            if items:
                break
        except (requests.RequestException, ValueError) as error:
            last_error = error
    if not items and last_error:
        raise ValueError('B站搜索暂时不可用')
    songs = []
    for item in items:
        bvid = item.get('bvid') or ''
        if not re.fullmatch(r'BV[0-9A-Za-z]{8,14}', bvid):
            continue
        seconds = _seconds(item.get('duration'))
        songs.append({'source': 'bilibili', 'id': bvid,
                      'title': clean_text(item.get('title')),
                      'singer': clean_text(item.get('author')), 'album': '',
                      'duration': str(datetime.timedelta(seconds=seconds)),
                      'duration_seconds': seconds, 'hash': '',
                      'playable': True, 'downloadable': True, 'availability': ''})
        if len(songs) >= 8:
            break
    return songs


def resolve_audio(bvid):
    if not re.fullmatch(r'BV[0-9A-Za-z]{8,14}', str(bvid or '')):
        raise ValueError('视频标识无效')
    view = requests.get(VIEW_API, params={'bvid': bvid}, headers=HEADERS, timeout=10)
    view.raise_for_status()
    cid = (view.json().get('data') or {}).get('cid')
    if not cid:
        raise ValueError('未取得视频信息')
    play = requests.get(PLAY_API, params={'bvid': bvid, 'cid': cid, 'fnval': 16},
                        headers=HEADERS, timeout=10)
    play.raise_for_status()
    streams = ((play.json().get('data') or {}).get('dash') or {}).get('audio') or []
    if not streams:
        raise ValueError('这个视频没有可单独下载的音频轨')
    best = max(streams, key=lambda stream: int(stream.get('bandwidth') or 0))
    url = best.get('baseUrl') or best.get('base_url') or ''
    if not _valid_audio(url):
        raise ValueError('未取得有效的音频地址')
    return url, round(int(best.get('bandwidth') or 0) / 1000) or None


def download(record, directory, progress_path=None):
    url, bitrate = resolve_audio(record['id'])
    directory = Path(directory)
    fragment = directory / 'audio.m4s'
    target = directory / 'audio.m4a'
    from audio_transfer import download as transfer
    transfer(url, fragment, HEADERS, progress_path)
    if shutil.which('ffmpeg'):
        remux = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(fragment),
                                '-c', 'copy', str(target)],
                               capture_output=True, text=True, timeout=90)
        if remux.returncode != 0:
            raise ValueError('音频重封装失败，请重试')
        fragment.unlink()
    else:
        # Fragmented MP4 still plays and probes; tagging may be skipped.
        fragment.rename(target)
    return bitrate
