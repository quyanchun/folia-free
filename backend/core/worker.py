"""Run the original providers in a disposable process with a parent-enforced timeout."""
import contextlib
import importlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE / 'vendor'))


def run(payload):
    from music_dl import config
    config.init()
    config.set('number', 8)
    config.set('keyword', payload.get('query', ''))
    if payload['operation'] == 'chart':
        from charts import get_chart
        return get_chart(payload.get('source', 'netease'), payload['chart'], payload.get('page', 1))
    if payload['operation'] == 'search':
        from concurrent.futures import ThreadPoolExecutor

        def search(source):
            try:
                if source == 'kuwo':
                    from kuwo import search as kuwo_search
                    return kuwo_search(payload['query']), None
                if source == 'qq':
                    from qq import search as qq_search
                    return qq_search(payload['query']), None
                if source == 'kugou':
                    from kugou import search as kugou_search
                    return kugou_search(payload['query']), None
                if source == 'bilibili':
                    from bilibili import search as bilibili_search
                    return bilibili_search(payload['query']), None
                if source == 'migu':
                    from migu import search as migu_search
                    return migu_search(payload['query']), None
                songs = importlib.import_module('music_dl.addons.' + source).search(payload['query'])
                return [{'source': source, 'id': song.id, 'title': song.title,
                         'singer': song.singer, 'album': song.album,
                         'duration': song.duration, 'hash': getattr(song, 'hash', '')}
                        for song in songs], None
            except Exception:
                return [], source

        with ThreadPoolExecutor(max_workers=max(1, len(payload['sources']))) as pool:
            results = list(pool.map(search, payload['sources']))
        return {'songs': [s for songs, _ in results for s in songs],
                'failed': [error for _, error in results if error]}

    config.set('outdir', payload['directory'])
    from audio_transfer import download as transfer, report
    progress_path = payload.get('progress_path')
    report(progress_path, state='preparing', received=0, total=None, speed=0)
    from audio_metadata import enrich, filename, write_tags
    record = enrich(payload['song'])
    if record['source'] == 'kuwo':
        from kuwo import download as kuwo_download
        bitrate = kuwo_download(record, payload['directory'], progress_path)
    elif record['source'] == 'qq':
        from qq import download as qq_download
        bitrate = qq_download(record, payload['directory'], progress_path)
    elif record['source'] == 'kugou':
        from kugou import download as kugou_download
        bitrate = kugou_download(record, payload['directory'], progress_path)
    elif record['source'] == 'bilibili':
        from bilibili import download as bilibili_download
        bitrate = bilibili_download(record, payload['directory'], progress_path)
    elif record['source'] == 'migu':
        from migu import download as migu_download
        bitrate = migu_download(record, payload['directory'], progress_path)
    elif record['source'] == 'netease':
        from music_dl.addons.netease import NeteaseApi
        data = NeteaseApi.encrypted_request(dict(ids=[record['id']], br=32000))
        available = NeteaseApi.request('http://music.163.com/weapi/song/enhance/player/url',
                                      method='POST', data=data).get('data', [])
        if not available or not available[0].get('url'):
            raise ValueError('未取得可下载音频')
        bitrate = int(available[0].get('br', 0) / 1000) or None
        transfer(available[0]['url'], Path(payload['directory']) / 'audio.mp3',
                 config.get('wget_headers'), progress_path)
    else:
        module = importlib.import_module('music_dl.addons.' + record['source'])
        cls = module.NeteaseSong if record['source'] == 'netease' else module.KugouSong
        song = cls()
        for key in ('id', 'title', 'singer', 'album', 'source', 'hash'):
            setattr(song, key, record[key])
        song._duration = record['duration']
        song.download()
        bitrate = song.rate or None
    files = list(Path(payload['directory']).iterdir())
    if len(files) != 1 or files[0].stat().st_size < 4096:
        raise ValueError('这首歌暂时无法下载')
    path = files[0]
    with path.open('rb') as file:
        header = file.read(4096)
    known_header = (header.startswith((b'ID3', b'fLaC', b'MAC ', b'OggS'))
                    or header[4:8] == b'ftyp'
                    or (header[:4] == b'RIFF' and header[8:12] == b'WAVE'))
    if not known_header and not any(
            header[i] == 255 and header[i + 1] & 224 == 224
            for i in range(len(header) - 1)):
        raise ValueError('未取得有效音频，请试试另一来源')
    preview_only = record.get('downloadable') is False
    if shutil.which('ffprobe'):
        probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                                'stream=codec_type,codec_name,bit_rate:format=duration', '-of', 'json', str(path)],
                               capture_output=True, text=True, timeout=10, check=True)
        media = json.loads(probe.stdout)
        streams = media.get('streams', [])
        stream = next((s for s in streams if s.get('codec_type') == 'audio'), None)
        if not stream:
            raise ValueError('未取得有效音频，请试试另一来源')
        bitrate = round(int(stream['bit_rate']) / 1000) if stream.get('bit_rate') else bitrate
        actual_duration = float(media.get('format', {}).get('duration') or 0)
        if actual_duration and record.get('duration_seconds', 0) > actual_duration + 5:
            preview_only = True
    target = path.with_name(filename(record, path.suffix))
    if target != path:
        path.rename(target)
        path = target
    metadata_fields = []
    report(progress_path, state='tagging', received=path.stat().st_size, total=path.stat().st_size, speed=0)
    metadata_notice = record.get('metadata_notice', '')
    try:
        metadata_fields = write_tags(path, record)
    except Exception:
        metadata_notice = '部分标签未能写入'
    return {'filename': path.name, 'size': path.stat().st_size,
            'format': path.suffix[1:].upper(), 'bitrate': bitrate, 'preview_only': preview_only,
            'metadata_fields': metadata_fields, 'metadata_notice': metadata_notice}


if __name__ == '__main__':
    try:
        payload = json.load(sys.stdin)
        with contextlib.redirect_stdout(sys.stderr):
            result = run(payload)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
