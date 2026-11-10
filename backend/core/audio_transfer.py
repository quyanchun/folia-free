"""Stream one audio file, reporting real bytes without altering its encoding."""
import json
from pathlib import Path
import time

import requests


def report(path, **progress):
    if path:
        target = Path(path)
        temporary = target.with_suffix('.tmp')
        temporary.write_text(json.dumps(progress), encoding='utf-8')
        temporary.replace(target)


def download(url, path, headers, progress_path=None):
    with requests.get(url, stream=True, headers=headers, timeout=(8, 20)) as response:
        response.raise_for_status()
        length = response.headers.get('Content-Length', '')
        total = int(length) if length.isdigit() and int(length) > 0 else None
        if response.headers.get('Content-Encoding', 'identity') != 'identity':
            total = None
        received = 0
        started = last_report = time.monotonic()
        report(progress_path, state='downloading', received=0, total=total, speed=0)
        with Path(path).open('wb') as file:
            for chunk in response.iter_content(65536):
                received += len(chunk)
                if received > 80 * 1024 * 1024:
                    raise ValueError('音频文件过大')
                file.write(chunk)
                now = time.monotonic()
                if now - last_report >= .3:
                    report(progress_path, state='downloading', received=received, total=total,
                           speed=round(received / max(.01, now - started)))
                    last_report = now
        if total and received != total:
            raise ValueError('文件不完整，请重试')
        report(progress_path, state='tagging', received=received, total=total, speed=0)
