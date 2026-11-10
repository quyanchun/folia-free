"""Local-only desktop bridge around the unchanged music-dl provider snapshot."""
import hashlib
import json
import os
import re
from pathlib import Path
import runpy
import signal
import shutil
import sys
import threading
import time
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
CORE = HERE / 'core'
sys.path.insert(0, str(CORE))
sys.path.insert(0, str(CORE / 'vendor'))
TOOLS = Path(getattr(sys, '_MEIPASS', HERE)) / 'tools'
os.environ['PATH'] = str(TOOLS) + os.pathsep + os.environ.get('PATH', '')

# The existing provider runner starts sys.executable worker.py. In the frozen
# app, that executable is this service, so dispatch the worker before startup.
if len(sys.argv) > 1 and sys.argv[1].endswith('worker.py'):
    runpy.run_path(str(CORE / 'worker.py'), run_name='__main__')
    sys.exit(0)

import requests
from server import App, Handler, SOURCES, CHART_SOURCES

LABELS = {'netease': ('网易云', '#eb4d5c'), 'kuwo': ('酷我', '#c98d26'),
          'qq': ('QQ音乐', '#3b9b76'), 'kugou': ('酷狗', '#4387c7'),
          'migu': ('咪咕', '#c74b8a'), 'bilibili': ('B站音频', '#d56e99')}
CHARTS = {'hot': '热歌榜', 'new': '新歌榜', 'rising': '飙升榜'}


def chart_cover(source, chart):
    label, color = LABELS[source]
    number = {'hot': '01', 'new': '02', 'rising': '03'}[chart]
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="{color}"/><stop offset="1" stop-color="#171b20"/></linearGradient></defs><rect width="600" height="600" rx="44" fill="url(#g)"/><circle cx="535" cy="110" r="190" fill="white" opacity=".07"/><circle cx="535" cy="110" r="130" fill="none" stroke="white" opacity=".15"/><text x="48" y="100" fill="white" font-family="sans-serif" font-size="30" opacity=".8">{label} / MUSIC STATION</text><text x="42" y="380" fill="white" font-family="sans-serif" font-size="150" font-weight="800">{number}</text><text x="48" y="510" fill="white" font-family="sans-serif" font-size="66" font-weight="600">{CHARTS[chart]}</text></svg>'''.encode()


class DesktopApp(App):
    def __init__(self, data):
        self.data = Path(data)
        for name in ('音频缓存', '封面', '歌词', '下载', '后台数据'):
            (self.data / name).mkdir(parents=True, exist_ok=True)
        for source in LABELS:
            for chart in CHARTS:
                (self.data / '封面' / f'{source}-{chart}.svg').write_bytes(chart_cover(source, chart))
        self.catalog_path = self.data / '后台数据/catalog.json'
        super().__init__(('127.0.0.1', 0), self.data / '音频缓存',
                         library=self.data / '下载', database=self.data / '后台数据/downloads.sqlite3')
        self.RequestHandlerClass = DesktopHandler
        try:
            catalog = json.loads(self.catalog_path.read_text())
        except (OSError, ValueError):
            catalog = {}
        for key, entry in catalog.items():
            entry['created'] = time.monotonic()
            if entry.get('file'):
                entry['file'] = Path(entry['file'])
            self.records[key] = entry

    def save_catalog(self):
        with self.lock:
            entries = {key: {**entry, **({'file': str(entry['file'])} if entry.get('file') else {})}
                       for key, entry in self.records.items()}
            temporary = self.catalog_path.with_suffix('.tmp')
            temporary.write_text(json.dumps(entries, ensure_ascii=False))
            temporary.replace(self.catalog_path)

    def remember(self, songs):
        output = []
        with self.lock:
            for song in songs:
                identity = str(song.get('hash') or song['id'])
                key = hashlib.sha256((song['source'] + ':' + identity).encode()).hexdigest()
                entry = self.records.setdefault(key, {})
                entry.update(song=song, created=time.monotonic())
                output.append(dict(song, stationKey=key))
        self.save_catalog()
        return output

    def details(self, key):
        with self.lock:
            entry = self.records.get(key)
            if not entry:
                raise ValueError('歌曲记录已过期，请重新搜索')
            if entry.get('details'):
                return entry['details']
            song = entry['song']
        result = {}
        if song['source'] == 'netease':
            try:
                detail = requests.get('https://music.163.com/api/song/detail/',
                                      params={'ids': json.dumps([song['id']])}, timeout=8).json()
                track = (detail.get('songs') or [{}])[0]
                picture = (track.get('album') or {}).get('picUrl')
                if picture and urlsplit(picture).hostname.endswith(('music.126.net', 'music.163.com')):
                    response = requests.get(picture.replace('http://', 'https://'), timeout=10)
                    response.raise_for_status()
                    if response.headers.get('Content-Type', '').startswith('image/') and len(response.content) < 8_000_000:
                        target = self.data / '封面' / (key + '.jpg')
                        target.write_bytes(response.content)
                        result['artwork'] = target.as_uri()
            except (requests.RequestException, ValueError, AttributeError, IndexError):
                pass
            try:
                lyrics = requests.get('https://music.163.com/api/song/lyric',
                                      params={'id': song['id'], 'lv': -1, 'tv': -1}, timeout=8).json()
                result['rawLrc'] = (lyrics.get('lrc') or {}).get('lyric', '')
                result['translation'] = (lyrics.get('tlyric') or {}).get('lyric', '')
                if result['rawLrc']:
                    (self.data / '歌词' / (key + '.lrc')).write_text(result['rawLrc'])
            except (requests.RequestException, ValueError):
                pass
        with self.lock:
            entry['details'] = result
        self.save_catalog()
        return result

    def cache_entries(self):
        # Statistics must not wait for a remote download holding the acquisition lock.
        entries = []
        for directory in self.cache.iterdir():
            try:
                if directory.is_dir() and not directory.is_symlink():
                    entries.append({'name': directory.name,
                                    'size': sum(file.stat().st_size for file in directory.rglob('*') if file.is_file()),
                                    'usedAt': directory.stat().st_mtime * 1000})
            except FileNotFoundError:
                pass  # A concurrent cache clear can remove a directory during this scan.
        return entries

    def remove_cache(self, name=None):
        # Only transient audio folders are removed; catalog, downloads and user files stay intact.
        if name is not None and not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', name):
            raise ValueError('Invalid cache entry')
        with self.audio_lock, self.lock:
            directories = [self.cache / name] if name else list(self.cache.iterdir())
            for directory in directories:
                if directory.is_dir() and not directory.is_symlink():
                    shutil.rmtree(directory)
            for entry in self.records.values():
                if entry.get('file') and not entry['file'].exists():
                    entry.pop('file', None)
                    entry.pop('download', None)
            self.save_catalog()


class DesktopHandler(Handler):
    def do_POST(self):
        if not self.path.startswith('/desktop/'):
            return super().do_POST()
        if not self.validate_request():
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 32768:
                raise ValueError('请求格式无效')
            payload = json.loads(self.rfile.read(length))
            if self.path == '/desktop/cache-list':
                return self.reply({'entries': self.server.cache_entries()})
            if self.path == '/desktop/cache-remove':
                self.server.remove_cache(payload['name'])
                return self.reply({'ok': True})
            if self.path == '/desktop/cache-clear':
                self.server.remove_cache()
                return self.reply({'ok': True})
            if self.path == '/desktop/catalog-list':
                from public_catalog import list_collections
                return self.reply({'collections': list_collections(payload['source'], payload['kind'])})
            if self.path == '/desktop/catalog-tracks':
                from public_catalog import get_tracks
                result = get_tracks(payload['source'], payload['kind'], payload['id'], payload['offset'], payload['limit'])
                result['songs'] = self.server.remember(result['songs'])
                return self.reply(result)
            if self.path == '/desktop/catalog-import':
                songs = payload.get('songs')
                if not isinstance(songs, list) or len(songs) > 30 or any(
                    not isinstance(song, dict) or song.get('source') not in ('qq', 'kugou')
                    or not re.fullmatch(r'[A-Za-z0-9]{6,40}', str(song.get('id') or ''))
                    for song in songs
                ):
                    raise ValueError('Invalid catalog songs')
                return self.reply({'songs': self.server.remember(songs)})
            if self.path == '/desktop/search':
                source = payload['source']
                query = payload['query']
                if source not in SOURCES or not isinstance(query, str) or not 0 < len(query.strip()) <= 100:
                    raise ValueError('请选择音源并输入歌名')
                result = self.server.worker({'operation': 'search', 'sources': [source], 'query': query}, 30)
                result['songs'] = self.server.remember(result['songs'])
                return self.reply(result)
            if self.path == '/desktop/chart':
                source, chart = payload['source'], payload['chart']
                page = payload.get('page', 1)
                if source not in CHART_SOURCES or chart not in CHARTS or type(page) is not int or not 1 <= page <= 100:
                    raise ValueError('请选择有效榜单')
                result = self.server.worker({'operation': 'chart', 'source': source, 'chart': chart, 'page': page}, 50)
                result['songs'] = self.server.remember(result['songs'])
                return self.reply(result)
            if self.path == '/desktop/media':
                key = payload['key']
                if key not in self.server.records:
                    raise ValueError('歌曲记录已过期，请重新搜索')
                result = self.server.prepare_audio(key)
                with self.server.lock:
                    directory = self.server.records[key]['file'].parent
                    directory.touch()
                    result = dict(result, cache_entry=directory.name)
                self.server.save_catalog()
                return self.reply(result)
            if self.path == '/desktop/song':
                key = payload['key']
                with self.server.lock:
                    entry = self.server.records.get(key)
                    song = dict(entry['song'], stationKey=key) if entry else None
                return self.reply({'song': song})
            if self.path == '/desktop/details':
                return self.reply(self.server.details(payload['key']))
            return self.reply({'error': '接口不存在'}, 404)
        except (ValueError, TypeError, KeyError) as error:
            self.reply({'error': str(error)}, 400)
        except Exception as error:
            print(f'Desktop bridge: {type(error).__name__}: {error}', file=sys.stderr, flush=True)
            self.reply({'error': '音源暂时没有响应，请稍后再试'}, 502)


def main():
    data = Path(os.environ.get('MUSIC_STATION_DATA', str(Path.home() / 'Music/Folia Free')))
    app = DesktopApp(data)
    print(json.dumps({'ready': True, 'port': app.server_port, 'sources': sorted(SOURCES)}, ensure_ascii=False), flush=True)
    def stop(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        app.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.save_catalog()
        app.close()


if __name__ == '__main__':
    main()
