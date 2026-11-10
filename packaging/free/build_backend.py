"""Freeze the local source service on the target OS, including its audio tools."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import requests

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / '.release-build'
# Bundle the licenses next to the binaries instead of leaving them in a download cache.
licenses = BUILD / 'backend-licenses'
licenses.mkdir(parents=True, exist_ok=True)
python_version = '.'.join(map(str, sys.version_info[:3]))
for name, url in {
    'PYTHON-LICENSE.txt': f'https://raw.githubusercontent.com/python/cpython/v{python_version}/LICENSE',
    'FFMPEG-GPL-3.0.txt': 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/COPYING.GPLv3',
}.items():
    target = licenses / name
    if not target.exists():
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        target.write_bytes(response.content)
for flag, name in [('-L', 'ffmpeg-license.txt'), ('-version', 'ffmpeg-build.txt')]:
    info = subprocess.run(['ffmpeg', flag], capture_output=True, check=True)
    (licenses / name).write_bytes(info.stdout + info.stderr)
windows_licenses = ROOT / '.release-cache/windows-tools'
if os.name == 'nt':
    for source in windows_licenses.rglob('*'):
        if source.is_file() and source.suffix.lower() != '.exe':
            destination = licenses / 'ffmpeg-distribution' / source.relative_to(windows_licenses)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
command = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean',
           '--name', 'music-station-service', '--distpath', str(BUILD / 'backend'),
           '--workpath', str(BUILD / 'pyinstaller'), '--specpath', str(BUILD),
           '--add-data', f'{ROOT / "backend/core"}{os.pathsep}core',
           '--add-data', f'{licenses}{os.pathsep}licenses',
           '--paths', str(ROOT / 'backend'), '--paths', str(ROOT / 'backend/core'),
           '--paths', str(ROOT / 'backend/core/vendor')]
for module in ('requests', 'Crypto', 'mutagen', 'click', 'prettytable'):
    command.extend(['--collect-all', module])
for name in ('ffmpeg', 'ffprobe'):
    binary = shutil.which(name)
    if not binary:
        raise SystemExit(f'{name} is required to build the self-contained service')
    command.extend(['--add-binary', binary + os.pathsep + 'tools'])
command.append(str(ROOT / 'backend/service.py'))
subprocess.run(command, cwd=ROOT, env={**os.environ, 'PYINSTALLER_CONFIG_DIR': str(BUILD / 'pyinstaller-cache')}, check=True)
