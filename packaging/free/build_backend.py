"""Freeze the local source service on the target OS, including its audio tools."""
from pathlib import Path
import os
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / '.release-build'
command = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean',
           '--name', 'music-station-service', '--distpath', str(BUILD / 'backend'),
           '--workpath', str(BUILD / 'pyinstaller'), '--specpath', str(BUILD),
           '--add-data', f'{ROOT / "backend/core"}{os.pathsep}core',
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
