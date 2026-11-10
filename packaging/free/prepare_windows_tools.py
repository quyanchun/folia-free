"""Fetch the pinned FFmpeg/ffprobe build and keep its redistribution files."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import requests
import zipfile

ROOT = Path(__file__).resolve().parents[2]
manifest = json.loads((ROOT / 'packaging/free/upstream.json').read_text())['windowsTools']
cache = ROOT / '.release-cache'
cache.mkdir(exist_ok=True)
archive = cache / 'windows-ffmpeg.zip'
if not archive.exists():
    with requests.get(manifest['url'], stream=True, timeout=60) as response:
        response.raise_for_status()
        with archive.open('wb') as target:
            for chunk in response.iter_content(1024 * 1024):
                target.write(chunk)
if hashlib.sha256(archive.read_bytes()).hexdigest() != manifest['sha256']:
    raise SystemExit('Windows audio tools checksum mismatch; update the manifest only after reviewing upstream')
output = cache / 'windows-tools'
output.mkdir(exist_ok=True)
with zipfile.ZipFile(archive) as package:
    for name in package.namelist():
        relative = Path(*Path(name).parts[1:])
        if not str(relative) or relative.is_absolute() or '..' in relative.parts:
            continue
        if name.endswith('/'):
            continue
        if relative.name not in ('ffmpeg.exe', 'ffprobe.exe', 'LICENSE.txt') and 'LICENSE' not in relative.name and 'README' not in relative.name:
            continue
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with package.open(name) as source, target.open('wb') as destination:
            shutil.copyfileobj(source, destination)
if not all((output / 'bin' / name).exists() for name in ('ffmpeg.exe', 'ffprobe.exe')):
    raise SystemExit('Audio tools missing from upstream archive')
if os.environ.get('GITHUB_PATH'):
    with open(os.environ['GITHUB_PATH'], 'a', encoding='utf-8') as handle:
        handle.write(str(output / 'bin') + '\n')
print('Verified Windows FFmpeg/ffprobe prepared')
