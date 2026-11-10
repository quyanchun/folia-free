"""Durable, private export tasks; one audio worker and one ZIP per batch."""
import datetime
import json
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import zipfile

ACTIVE = {'preparing', 'downloading', 'tagging', 'saving'}
RETENTION = 24 * 3600


class DownloadQueue:
    def __init__(self, folder, database, prepare, legacy_folder=None):
        self.folder = Path(folder)
        self.legacy_folder = Path(legacy_folder) if legacy_folder else None
        self.folder.mkdir(parents=True, exist_ok=True)
        self.archives = Path(database).parent / 'archives'
        self.archives.mkdir(parents=True, exist_ok=True)
        for directory in (self.folder, self.archives):
            for partial in directory.glob('.music-dl-*.part'):
                partial.unlink(missing_ok=True)
        self.db = sqlite3.connect(database, check_same_thread=False)
        self.db.execute('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        self.condition = threading.Condition(threading.RLock())
        self.prepare = prepare
        self.stopping = False
        self.jobs = [json.loads(r[0]) for r in self.db.execute('SELECT data FROM jobs ORDER BY rowid')]
        self.batches = [json.loads(r[0]) for r in self.db.execute('SELECT data FROM batches ORDER BY rowid')]
        self.paused_owners = {r[0][6:] for r in self.db.execute("SELECT key FROM settings WHERE key LIKE 'pause:%' AND value='1'")}
        for job in self.jobs:
            # Preserve previous local downloads as reusable files, never delete them.
            if 'storage' not in job and self.legacy_folder and job.get('filename') and (self.legacy_folder / job['filename']).is_file():
                job['storage'] = 'legacy'
            if job['state'] in ACTIVE:
                job.update(state='pending', received=0, total=None, speed=0)
            self._save('jobs', job)
        for batch in self.batches:
            if batch['state'] == 'packing':
                batch['state'] = 'preparing'
                self._save('batches', batch)
        self.thread = threading.Thread(target=self._run, name='music-exports', daemon=True)
        self.thread.start()

    def _save(self, table, item):
        assert table in ('jobs', 'batches')
        with self.condition, self.db:
            self.db.execute(f'INSERT INTO {table} VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
                            (item['id'], json.dumps(item, ensure_ascii=False)))

    def song_path(self, job):
        folder = self.legacy_folder if job.get('storage') == 'legacy' else self.folder
        return folder / job['filename']

    def _batch_jobs(self, batch):
        by_id = {j['id']: j for j in self.jobs}
        return [by_id[i] for i in batch['ids'] if i in by_id]

    def _counts(self, jobs):
        counts = {state: sum(j['state'] == state for j in jobs) for state in ('pending', 'done', 'failed')}
        counts.update(total=len(jobs), active=sum(j['state'] in ACTIVE for j in jobs),
                      bytes=sum(j.get('size', 0) for j in jobs if j['state'] == 'done'))
        return counts

    def snapshot(self, owner):
        with self.condition:
            batches = [b for b in self.batches if b['owner'] == owner]
            ids = {i for b in batches for i in b['ids']}
            jobs = [j for j in self.jobs if j['id'] in ids]
            public_jobs = []
            for job in jobs:
                copy = {k: v for k, v in job.items() if k not in ('storage', 'key')}
                expired = any(b['state'] == 'expired' and job['id'] in b['ids'] for b in batches)
                if expired:
                    copy['state'] = 'expired'
                elif job['state'] == 'done' and self.song_path(job).is_file():
                    copy['url'] = '/api/downloads/items/' + job['id']
                public_jobs.append(copy)
            public_batches = []
            for batch in batches:
                copy = {k: v for k, v in batch.items() if k != 'owner'}
                copy['counts'] = self._counts(self._batch_jobs(batch))
                if batch['state'] == 'ready':
                    if len(batch['ids']) == 1:
                        copy['url'] = '/api/downloads/items/' + batch['ids'][0]
                    else:
                        copy['url'] = '/api/downloads/archives/' + batch['id']
                public_batches.append(copy)
            return {'jobs': public_jobs, 'batches': public_batches, 'paused': owner in self.paused_owners,
                    'counts': self._counts(jobs), 'retention_hours': RETENTION // 3600}

    def enqueue(self, songs, owner):
        unique = {f"{s['source']}:{s.get('hash') or s['id']}": s for s in songs
                  if s.get('downloadable') is not False and s.get('playable') is not False}
        if not unique:
            raise ValueError('没有可下载的歌曲')
        with self.condition:
            if sum(b['owner'] == owner for b in self.batches) >= 100:
                raise ValueError('任务较多，请先清除已完成记录')
            if len(self.jobs) + len(unique) > 10000:
                raise ValueError('任务较多，请稍后再试')
            for batch in self.batches:
                if batch['owner'] == owner and batch['state'] not in ('expired', 'failed'):
                    if {j['key'] for j in self._batch_jobs(batch)} == set(unique):
                        return {'added': 0, 'batch_id': batch['id'], **self.snapshot(owner)}
            batch = {'id': secrets.token_hex(16), 'owner': owner, 'ids': [], 'state': 'preparing',
                     'created': time.time(), 'expires': time.time() + RETENTION, 'error': ''}
            for key, song in unique.items():
                job = {'id': secrets.token_hex(16), 'key': key, 'song': song, 'state': 'pending',
                       'received': 0, 'total': None, 'speed': 0, 'error': '', 'created': time.time()}
                self.jobs.append(job)
                batch['ids'].append(job['id'])
                self._save('jobs', job)
            self.batches.append(batch)
            self._save('batches', batch)
            self.condition.notify_all()
        return {'added': len(unique), 'batch_id': batch['id'], **self.snapshot(owner)}

    def control(self, action, owner, job_id=None, batch_id=None):
        with self.condition:
            batches = [b for b in self.batches if b['owner'] == owner]
            if action in ('pause', 'resume'):
                if action == 'pause': self.paused_owners.add(owner)
                else: self.paused_owners.discard(owner)
                with self.db:
                    self.db.execute('INSERT OR REPLACE INTO settings VALUES (?, ?)', ('pause:' + owner, '1' if action == 'pause' else '0'))
            elif action == 'clear_done':
                for batch in list(batches):
                    if batch['state'] in ('ready', 'expired'):
                        self.batches.remove(batch)
                        removed = set(batch['ids'])
                        self.jobs = [j for j in self.jobs if j['id'] not in removed]
                        with self.db:
                            self.db.execute('DELETE FROM batches WHERE id=?', (batch['id'],))
                            self.db.executemany('DELETE FROM jobs WHERE id=?', [(identity,) for identity in removed])
            elif action == 'retry_batch':
                batch = next((b for b in batches if b['id'] == batch_id), None)
                if not batch or batch['state'] not in ('ready', 'failed', 'expired'):
                    raise ValueError('任务正在准备或不存在')
                for job in self._batch_jobs(batch):
                    if job['state'] != 'done' or not self.song_path(job).is_file():
                        self._update(job, state='pending', error='', received=0, total=None, speed=0)
                batch.update(state='preparing', error='', expires=time.time() + RETENTION)
                self._save('batches', batch)
            elif action in ('retry', 'remove'):
                batch = next((b for b in batches if job_id in b['ids']), None)
                job = next((j for j in self.jobs if j['id'] == job_id), None) if batch else None
                if not job or batch['state'] == 'packing' or job['state'] not in ('pending', 'failed'):
                    raise ValueError('任务正在处理或不存在')
                if action == 'remove':
                    batch['ids'].remove(job_id)
                else:
                    self._update(job, state='pending', error='', received=0, total=None, speed=0)
                batch.update(state='preparing', error='')
                self._save('batches', batch)
            else:
                raise ValueError('无效的下载操作')
            self.condition.notify_all()
        return self.snapshot(owner)

    def artifact(self, owner, kind, identity):
        with self.condition:
            batch = next((b for b in self.batches if b['owner'] == owner and
                          (b['id'] == identity if kind == 'archives' else identity in b['ids'])), None)
            if not batch or batch['expires'] <= time.time():
                return None
            if kind == 'archives':
                if batch['state'] != 'ready': return None
                path = self.archives / (batch['id'] + '.zip')
                date = datetime.datetime.fromtimestamp(batch['created']).strftime('%Y%m%d')
                name = f"music-dl-{date}-{batch.get('included', 0)}首.zip"
            else:
                job = next((j for j in self.jobs if j['id'] == identity), None)
                if not job or job['state'] != 'done': return None
                path, name = self.song_path(job), job['filename']
            return (path, name) if path.is_file() else None

    def _update(self, job, **values):
        with self.condition:
            job.update(values)
            self._save('jobs', job)

    def _reuse(self, job):
        with self.condition:
            cached = next((j for j in reversed(self.jobs) if j['id'] != job['id'] and j['key'] == job['key']
                           and j['state'] == 'done' and self.song_path(j).is_file()), None)
            if not cached: return False
            for field in ('filename', 'size', 'received', 'total', 'format', 'bitrate', 'metadata_notice', 'storage'):
                if field in cached: job[field] = cached[field]
            self._update(job, state='done', speed=0, finished=time.time())
            return True

    def _store(self, job, source, result):
        self._update(job, state='saving')
        descriptor, temporary = tempfile.mkstemp(prefix='.music-dl-', suffix='.part', dir=self.folder)
        os.close(descriptor)
        try:
            shutil.copy2(source, temporary)
            original = Path(result['filename'])
            for index in range(1, 10000):
                suffix = '' if index == 1 else f' ({index})'
                budget = 255 - len((suffix + original.suffix).encode('utf-8'))
                name = original.stem.encode('utf-8')[:budget].decode('utf-8', errors='ignore') + suffix + original.suffix
                try:
                    os.link(temporary, self.folder / name)
                    return name
                except FileExistsError:
                    continue
            raise ValueError('同名文件过多')
        finally:
            Path(temporary).unlink(missing_ok=True)

    def _pack(self, batch):
        with self.condition:
            jobs = self._batch_jobs(batch)
            good = [j for j in jobs if j['state'] == 'done' and self.song_path(j).is_file()]
            batch['state'] = 'packing'
            self._save('batches', batch)
        if not good:
            batch.update(state='failed', error='没有准备成功的歌曲，请重试')
            self._save('batches', batch)
            return
        if len(batch['ids']) > 1:
            batch['state'] = 'packing'
            self._save('batches', batch)
            temporary = self.archives / ('.music-dl-' + batch['id'] + '.part')
            try:
                with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
                    for job in good:
                        archive.write(self.song_path(job), job['filename'])
                    failed = [j for j in jobs if j['state'] != 'done']
                    if failed:
                        archive.writestr('未完成的歌曲.txt', '\n'.join(f"{j['song']['title']} - {j['song']['singer']}：{j.get('error') or '未完成'}" for j in failed))
                temporary.replace(self.archives / (batch['id'] + '.zip'))
            finally:
                temporary.unlink(missing_ok=True)
        with self.condition:
            batch.update(state='ready', included=len(good), expires=time.time() + RETENTION,
                         archive_size=(self.archives / (batch['id'] + '.zip')).stat().st_size if len(batch['ids']) > 1 else good[0]['size'])
            self._save('batches', batch)

    def _cleanup(self):
        now = time.time()
        for batch in self.batches:
            if batch['state'] in ('ready', 'failed') and batch['expires'] < now:
                batch['state'] = 'expired'
                self._save('batches', batch)
        retained = {i for b in self.batches if b['state'] != 'expired' for i in b['ids']}
        protected = {j.get('filename') for j in self.jobs if j['id'] in retained and j.get('storage') != 'legacy'}
        for path in self.folder.iterdir():
            if path.is_file() and path.name not in protected and path.stat().st_mtime < now - RETENTION:
                path.unlink(missing_ok=True)
        ready = {b['id'] + '.zip' for b in self.batches if b['state'] == 'ready'}
        for path in self.archives.glob('*.zip'):
            if path.name not in ready and path.stat().st_mtime < now - RETENTION:
                path.unlink(missing_ok=True)

    def _run(self):
        while True:
            with self.condition:
                self._cleanup()
                batch = next((b for b in self.batches if b['state'] == 'preparing' and b['owner'] not in self.paused_owners), None)
                if self.stopping: return
                if not batch:
                    self.condition.wait(timeout=30)
                    continue
                job = next((j for j in self._batch_jobs(batch) if j['state'] == 'pending'), None)
            try:
                if not job:
                    self._pack(batch)
                    continue
                if self._reuse(job): continue
                self._update(job, state='preparing', received=0, total=None, speed=0)
                source, result = self.prepare(job['song'], lambda progress: self._update(job, **progress))
                if result.get('preview_only'):
                    raise ValueError('仅支持试听片段，未作为完整歌曲下载')
                name = self._store(job, source, result)
                self._update(job, state='done', filename=name, size=result['size'], received=result['size'],
                             total=result['size'], speed=0, format=result['format'], bitrate=result.get('bitrate'),
                             metadata_notice=result.get('metadata_notice', ''), storage='cache', finished=time.time())
            except Exception as error:
                with self.condition:
                    if self.stopping:
                        if job: self._update(job, state='pending', received=0, total=None, speed=0)
                        return
                    message = '平台响应超时，请稍后重试' if isinstance(error, (TimeoutError, subprocess.TimeoutExpired)) else str(error)
                    if job:
                        self._update(job, state='failed', error=message or '准备失败，请重试', speed=0)
                        if '频繁' in message or '限流' in message:
                            self.control('pause', batch['owner'])
                    else:
                        batch.update(state='failed', error='打包失败，请重试')
                        self._save('batches', batch)

    def stop(self):
        with self.condition:
            self.stopping = True
            self.condition.notify_all()

    def close(self):
        self.thread.join(timeout=10)
        if not self.thread.is_alive(): self.db.close()
