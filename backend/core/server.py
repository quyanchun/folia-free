"""Local UI for music-dl. All provider activity runs in isolated workers."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import socketserver

ThreadingUnixStreamServer = getattr(socketserver, 'ThreadingUnixStreamServer', None)
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import SimpleCookie, CookieError
from urllib.parse import parse_qs, quote, urlsplit
from urllib.request import urlopen
import webbrowser

BASE = Path(__file__).resolve().parent
# Kugou's anonymous playInfo endpoint was re-verified on 2026-11-08 and is
# usable again. Migu uses the 2019 public listenSong.do endpoint (verified
# 2026-11-09). Bilibili is a search source only (it has no matching music charts).
SOURCES = {'netease', 'kuwo', 'qq', 'kugou', 'bilibili', 'migu'}
CHART_SOURCES = {'netease', 'kuwo', 'qq', 'kugou', 'migu'}


class App(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, cache, *, library=None, database=None, public_url=None):
        super().__init__(address, Handler)
        self.cache = Path(cache)
        self.records = {}
        self.lock = threading.RLock()
        self.audio_lock = threading.Lock()
        self.jobs = threading.BoundedSemaphore(3)
        self.processes = set()
        self.stopping = False
        self.gateway = None
        self.allowed_hosts = {f'127.0.0.1:{self.server_port}', f'localhost:{self.server_port}'}
        self.allowed_origins = {'http://' + host for host in self.allowed_hosts}
        public_urls = [public_url] if isinstance(public_url, str) else (public_url or [])
        self.secure_cookie = bool(public_urls)
        for address in public_urls:
            public = urlsplit(address)
            if public.scheme not in ('http', 'https') or not public.netloc or public.path not in ('', '/'):
                raise ValueError('public-url 必须是站点根地址')
            self.allowed_hosts.add(public.netloc)
            self.allowed_origins.add(public.scheme + '://' + public.netloc)
            self.secure_cookie = self.secure_cookie and public.scheme == 'https'
        from downloads import DownloadQueue
        self.downloads = DownloadQueue(library or BASE / 'data' / 'audio', database or BASE / 'data' / 'downloads.sqlite3', self.download_song,
                                       legacy_folder=None if library else BASE / '下载的歌曲')

    def close(self):
        if self.gateway:
            self.gateway.shutdown()
            self.gateway.server_close()
            Path(self.gateway.server_address).unlink(missing_ok=True)
        self.downloads.stop()
        with self.lock:
            self.stopping = True
            processes = list(self.processes)
        for process in processes:
            try:
                process.kill()
                process.wait(timeout=5)
            except ProcessLookupError:
                pass
        self.downloads.close()
        self.server_close()

    def start_gateway(self, path):
        self.gateway = Gateway(path, self)
        threading.Thread(target=self.gateway.serve_forever, daemon=True).start()

    def worker(self, payload, timeout, progress=None):
        with self.lock:
            if self.stopping:
                raise ValueError('服务正在关闭')
            process = subprocess.Popen([sys.executable, str(BASE / 'worker.py')],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, text=True, encoding='utf-8', cwd=BASE,
                                       env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))
            self.processes.add(process)
        try:
            started = time.monotonic()
            request = json.dumps(payload)
            previous = None
            while True:
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(process.args, timeout)
                try:
                    output, errors = process.communicate(request, timeout=min(.3, remaining) if progress else remaining)
                    break
                except subprocess.TimeoutExpired:
                    if not progress:
                        raise
                    request = None
                    try:
                        current = Path(payload['progress_path']).read_text(encoding='utf-8')
                        if current != previous:
                            progress(json.loads(current))
                            previous = current
                    except (OSError, ValueError):
                        pass
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise
        finally:
            with self.lock:
                self.processes.discard(process)
        if process.returncode:
            message = '榜单暂时不可用，请稍后再试' if payload['operation'] == 'chart' else '这首歌暂时无法下载，请试试另一条结果'
            if '平台请求频繁，请稍后再试' in errors:
                message = '平台请求频繁，请稍后再试'
            raise ValueError(message)
        return json.loads(output)

    def prepare_audio(self, token, progress=None):
        # Playback and download jobs share one remote audio acquisition lane.
        with self.audio_lock:
            with self.lock:
                entry = self.records.get(token)
                if not entry:
                    raise ValueError('结果已过期，请重新搜索')
                if entry.get('file') and entry['file'].exists():
                    return entry['download']
                song = entry['song']
                if song.get('playable') is False:
                    raise ValueError('这首歌暂不支持公开试听或下载')
            directory = Path(tempfile.mkdtemp(dir=self.cache))
            progress_path = directory.with_suffix('.progress.json')
            try:
                result = self.worker({'operation': 'download', 'song': song,
                                      'directory': str(directory), 'progress_path': str(progress_path)}, 75, progress)
                with self.lock:
                    entry['file'] = directory / result['filename']
                    result['url'] = '/files/' + token
                    entry['download'] = result
                return result
            except BaseException:
                shutil.rmtree(directory, ignore_errors=True)
                raise
            finally:
                progress_path.unlink(missing_ok=True)
                progress_path.with_suffix('.tmp').unlink(missing_ok=True)

    def download_song(self, song, progress):
        with self.lock:
            token = next((token for token, entry in self.records.items()
                          if entry['song']['source'] == song['source'] and str(entry['song']['id']) == str(song['id'])), None)
            if not token:
                token = secrets.token_urlsafe(18)
                self.records[token] = {'song': song, 'created': time.monotonic()}
            self.records[token]['created'] = time.monotonic()
        result = self.prepare_audio(token, progress)
        with self.lock:
            return self.records[token]['file'], result


class Gateway(ThreadingUnixStreamServer or object):
    daemon_threads = True
    prefix = '/app/music-dl'

    def __init__(self, path, app):
        if ThreadingUnixStreamServer is None:
            raise ValueError('Unix gateway is unavailable on this platform')
        self.app = app
        socket_path = Path(path)
        if socket_path.exists():
            if not socket_path.is_socket():
                raise ValueError('网关 Socket 路径已被普通文件占用')
            socket_path.unlink()
        super().__init__(str(path), Handler)
        os.chmod(path, 0o600)

    def __getattr__(self, name):
        return getattr(self.app, name)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def session(self):
        if hasattr(self, '_session'):
            return self._owner
        cookies = SimpleCookie()
        try:
            cookies.load(self.headers.get('Cookie', ''))
        except CookieError:
            pass
        gateway = isinstance(self.server, Gateway)
        candidate = cookies.get('music_dl_gateway_session' if gateway else 'music_dl_session')
        candidate = candidate.value if candidate else ''
        self._new_session = not re.fullmatch(r'[a-f0-9]{64}', candidate)
        self._session = secrets.token_hex(32) if self._new_session else candidate
        self._owner = self._session
        if gateway:
            self._owner = hashlib.sha256(('fnos:' + self.headers.get('X-Trim-Userid', '') + ':' + self._session).encode()).hexdigest()
        return self._owner

    def session_header(self):
        self.session()
        if self._new_session:
            gateway = isinstance(self.server, Gateway)
            name = 'music_dl_gateway_session' if gateway else 'music_dl_session'
            path = self.server.prefix + '/' if gateway else '/'
            cookie = f'{name}={self._session}; Path={path}; Max-Age=2592000; HttpOnly; SameSite=Strict'
            secure = self.headers.get('X-Forwarded-Proto') == 'https' if gateway else self.server.secure_cookie
            if secure:
                cookie += '; Secure'
            self.send_header('Set-Cookie', cookie)

    def reply(self, body, status=200):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.session_header()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def do_HEAD(self):
        self.do_GET()

    def validate_request(self):
        if isinstance(self.server, Gateway):
            if not re.fullmatch(r'[0-9]{1,10}', self.headers.get('X-Trim-Userid', '')):
                self.reply({'error': '请先登录飞牛'}, 401)
                return False
            prefix = self.server.prefix
            location = urlsplit(self.path)
            if location.path == prefix:
                self.send_response(308)
                self.send_header('Location', prefix + '/' + ('?' + location.query if location.query else ''))
                self.send_header('Content-Length', '0')
                self.end_headers()
                return False
            if not self.path.startswith(prefix + '/'):
                self.reply({'error': '页面不存在'}, 404)
                return False
            self.path = self.path[len(prefix):]
            if self.command == 'POST':
                try:
                    origin = urlsplit(self.headers.get('Origin', ''))
                except ValueError:
                    self.reply({'error': '请求来源无效'}, 403)
                    return False
                if (self.headers.get('Sec-Fetch-Site') == 'cross-site' or
                    self.headers.get('Origin') is not None and
                    (origin.scheme not in ('http', 'https') or origin.netloc != self.headers.get('Host'))):
                    self.reply({'error': '请求来源无效'}, 403)
                    return False
        else:
            if self.headers.get('Host') not in self.server.allowed_hosts:
                self.reply({'error': '请求地址无效'}, 403)
                return False
            if self.command == 'POST' and self.headers.get('Origin') is not None and self.headers.get('Origin') not in self.server.allowed_origins:
                self.reply({'error': '请求来源无效'}, 403)
                return False
        return True

    def do_GET(self):
        if not self.validate_request():
            return
        location = urlsplit(self.path)
        path = location.path
        if path == '/api/health':
            # Static files are read from disk on every request, but SOURCES is
            # loaded when the process starts. Publishing the live list lets the
            # page disable buttons that an old server process would reject.
            return self.reply({'app': 'music-dl-web', 'sources': sorted(SOURCES),
                               'chart_sources': sorted(CHART_SOURCES)})
        if path == '/api/downloads':
            return self.reply(self.server.downloads.snapshot(self.session()))
        artifact = re.fullmatch(r'/api/downloads/(archives|items)/([a-f0-9]{32})', path)
        if artifact:
            found = self.server.downloads.artifact(self.session(), *artifact.groups())
            if not found:
                return self.reply({'error': '文件不存在、未准备好或已过期'}, 404)
            return self.audio(found[0], False, found[1])
        if path.startswith('/files/'):
            token = path.removeprefix('/files/')
            with self.server.lock:
                entry = self.server.records.get(token)
                file = entry.get('file') if entry else None
            if not file or not file.exists():
                return self.reply({'error': '文件已过期，请重新下载'}, 404)
            inline = parse_qs(location.query).get('preview') == ['1']
            if not inline and (entry.get('song', {}).get('downloadable') is False
                               or entry.get('download', {}).get('preview_only')):
                return self.reply({'error': '这首歌仅支持试听片段'}, 403)
            return self.audio(file, inline)
        elif path in ('/', '/app.js', '/style.css'):
            name = 'index.html' if path == '/' else path[1:]
            data = (BASE / 'static' / name).read_bytes()
            self.send_response(200)
            mime = {'index.html': 'text/html', 'app.js': 'application/javascript', 'style.css': 'text/css'}[name]
            self.send_header('Content-Type', mime + '; charset=utf-8')
        else:
            return self.reply({'error': '页面不存在'}, 404)
        self.session_header()
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if self.command == 'HEAD':
            return
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def audio(self, file, inline, filename=None):
        try:
            handle = file.open('rb')
        except FileNotFoundError:
            return self.reply({'error': '文件已过期'}, 404)
        stat = os.fstat(handle.fileno())
        size = stat.st_size
        etag = f'"{stat.st_mtime_ns:x}-{size:x}"'
        modified = formatdate(stat.st_mtime, usegmt=True)
        start, end = 0, size - 1
        requested = self.headers.get('Range')
        if self.headers.get('If-Range') not in (None, etag, modified):
            requested = None
        if requested:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested)
            valid = bool(match and any(match.groups()))
            if valid:
                first, last = match.groups()
                if first:
                    start = int(first)
                    end = min(int(last), end) if last else end
                else:
                    start = max(0, size - int(last))
                    valid = int(last) > 0
                valid = valid and 0 <= start <= end < size
            if not valid:
                handle.close()
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
        self.send_response(206 if requested else 200)
        mime = {'.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
                '.ape': 'audio/ape', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.zip': 'application/zip'}
        self.session_header()
        self.send_header('Content-Type', mime.get(file.suffix.lower(), 'application/octet-stream'))
        disposition = 'inline' if inline else 'attachment'
        self.send_header('Content-Disposition', disposition + "; filename*=UTF-8''" + quote(filename or file.name))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('ETag', etag)
        self.send_header('Last-Modified', modified)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(end - start + 1))
        if requested:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.end_headers()
        if self.command == 'HEAD':
            handle.close()
            return
        try:
            with handle as audio:
                audio.seek(start)
                remaining = end - start + 1
                while remaining:
                    chunk = audio.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def worker(self, payload, timeout):
        return self.server.worker(payload, timeout)

    def register_songs(self, songs):
        with self.server.lock:
            now = time.monotonic()
            for token, entry in list(self.server.records.items()):
                if now - entry['created'] > 3600 or len(self.server.records) > 4096:
                    if entry.get('file'):
                        shutil.rmtree(entry['file'].parent, ignore_errors=True)
                    del self.server.records[token]
            registered = []
            for song in songs:
                token = secrets.token_urlsafe(18)
                self.server.records[token] = {'song': song, 'created': now}
                registered.append(dict(song, token=token))
            return registered

    def prepare_audio(self, token):
        return self.server.prepare_audio(token)

    def do_POST(self):
        if not self.validate_request():
            return
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.reply({'error': '请求格式无效'}, 415)
        if not self.server.jobs.acquire(blocking=False):
            return self.reply({'error': '正在处理，请稍后再试'}, 429)
        try:
            path = urlsplit(self.path).path
            length = int(self.headers.get('Content-Length', 0))
            limit = 262144 if path in ('/api/restore', '/api/downloads') else 8192
            if not 0 < length <= limit:
                raise ValueError('请求过长或为空')
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError('请求格式无效')
            if path == '/api/downloads':
                tokens = payload.get('tokens')
                if not isinstance(tokens, list) or not 1 <= len(tokens) <= 500 or not all(isinstance(t, str) for t in tokens):
                    raise ValueError('请选择 1 至 500 首歌曲')
                with self.server.lock:
                    if any(token not in self.server.records for token in tokens):
                        raise ValueError('结果已过期，请重新搜索')
                    songs = [dict(self.server.records[token]['song']) for token in tokens]
                return self.reply(self.server.downloads.enqueue(songs, self.session()))
            if path == '/api/downloads/control':
                action = payload.get('action')
                return self.reply(self.server.downloads.control(action, self.session(), payload.get('id'), payload.get('batch_id')))
            if path == '/api/restore':
                incoming = payload.get('songs')
                if not isinstance(incoming, list) or len(incoming) > 201:
                    raise ValueError('播放记录格式无效或队列过长')
                songs = []
                for saved in incoming:
                    if not isinstance(saved, dict):
                        raise ValueError('播放记录格式无效')
                    source = saved.get('source')
                    song_id = str(saved.get('id', ''))
                    # QQ songmids are alphanumeric (e.g. 003os5gx3zLAc5).
                    if not isinstance(source, str) or source not in SOURCES or not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', song_id):
                        continue
                    song = {'source': source, 'id': int(song_id) if source == 'netease' and song_id.isdigit() else song_id, 'hash': ''}
                    for field in ('title', 'singer', 'album', 'duration'):
                        value = saved.get(field, '')
                        if not isinstance(value, str) or len(value) > 500:
                            raise ValueError('播放记录字段无效')
                        song[field] = value
                    parts = song['duration'].split(':')
                    seconds = 0
                    if 1 <= len(parts) <= 3 and all(part.isdigit() for part in parts):
                        for part in parts:
                            seconds = seconds * 60 + int(part)
                    song['duration_seconds'] = min(seconds, 86400)
                    songs.append(song)
                return self.reply({'songs': self.register_songs(songs), 'skipped': len(incoming) - len(songs)})
            if path in ('/api/search', '/api/chart'):
                if path == '/api/chart':
                    chart = payload.get('chart', 'hot')
                    if chart not in ('hot', 'new', 'rising'):
                        raise ValueError('请选择有效榜单')
                    source = payload.get('source', 'netease')
                    page = payload.get('page', 1)
                    if not isinstance(source, str) or source not in CHART_SOURCES:
                        raise ValueError('请选择有效榜单平台')
                    if type(page) is not int or not 1 <= page <= 100:
                        raise ValueError('页码无效')
                    result = self.worker({'operation': 'chart', 'chart': chart,
                                          'source': source, 'page': page}, 45)
                else:
                    query = payload.get('query', '')
                    source = payload.get('source', 'all')
                    if not isinstance(query, str) or not 0 < len(query.strip()) <= 100:
                        raise ValueError('请输入歌名或歌手，最多 100 字')
                    if source not in SOURCES | {'all'}:
                        raise ValueError('请选择有效来源')
                    result = self.worker({'operation': 'search', 'query': query.strip(),
                                          'sources': sorted(SOURCES) if source == 'all' else [source]}, 25)
                songs = self.register_songs(result['songs'])
                return self.reply(dict(result, songs=songs))
            if path == '/api/download':
                token = payload.get('token')
                if not isinstance(token, str):
                    raise ValueError('请重新搜索后下载')
                return self.reply(self.prepare_audio(token))
            return self.reply({'error': '接口不存在'}, 404)
        except subprocess.TimeoutExpired:
            self.reply({'error': '平台响应超时，请稍后再试'}, 504)
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            status = 429 if str(error) == '平台请求频繁，请稍后再试' else 400
            self.reply({'error': str(error)}, status)
        except Exception:
            self.reply({'error': '暂时无法完成，请稍后再试'}, 502)
        finally:
            self.server.jobs.release()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--open', action='store_true')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--public-url', action='append', help='允许访问的站点根地址，可重复指定，例如 https://music.example.com')
    parser.add_argument('--gateway-socket', help='飞牛统一网关 Unix Socket 路径，入口为 /app/music-dl/')
    args = parser.parse_args()
    url = f'http://127.0.0.1:{args.port}'
    try:
        with urlopen(url + '/api/health', timeout=1) as response:
            existing = json.load(response).get('app') == 'music-dl-web'
    except Exception:
        existing = False
    if existing:
        if args.open:
            webbrowser.open(url)
        print(url, flush=True)
        return
    def interrupt(*_):
        raise KeyboardInterrupt
    for event in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(event, interrupt)
    with tempfile.TemporaryDirectory(prefix='music-dl-web-') as cache:
        try:
            app = App((args.host, args.port), cache, public_url=args.public_url)
            if args.gateway_socket:
                app.start_gateway(args.gateway_socket)
        except OSError:
            sys.exit(f'{args.port} 端口被占用，请关闭占用它的程序后重试。')
        print('music-dl  ' + url + '\n按 Ctrl+C 关闭', flush=True)
        if args.open:
            threading.Timer(0.5, lambda: webbrowser.open(url)).start()
        try:
            app.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            app.close()


if __name__ == '__main__':
    main()
