"""Windows portability: optional Unix services and Unicode data under an ANSI locale."""
from pathlib import Path
import importlib.util
import socketserver
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
from service import DesktopApp


class PortabilityTests(unittest.TestCase):
    def test_import_without_unix_socket_server(self):
        had_unix = hasattr(socketserver, 'ThreadingUnixStreamServer')
        unix_class = getattr(socketserver, 'ThreadingUnixStreamServer', None)
        try:
            if had_unix:
                del socketserver.ThreadingUnixStreamServer
            spec = importlib.util.spec_from_file_location('portable_server', ROOT / 'backend/core/server.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.assertIsNotNone(module.App)
            with self.assertRaisesRegex(ValueError, 'unavailable'):
                module.Gateway('unused', None)
        finally:
            if had_unix:
                socketserver.ThreadingUnixStreamServer = unix_class

    def test_chinese_emoji_catalog_survives_ansi_default_encoding(self):
        original_open = Path.open
        def ansi_open(file, mode='r', buffering=-1, encoding=None, errors=None, newline=None):
            if 'b' not in mode and encoding in (None, 'locale'):
                encoding = 'cp1252'
            return original_open(file, mode, buffering, encoding, errors, newline)
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, 'open', ansi_open):
            app = DesktopApp(directory)
            record = {'source': 'kuwo', 'id': '123456', 'title': '中文歌名🎵', 'singer': '歌手', 'album': '专辑'}
            try:
                remembered = app.remember([record])[0]
            finally:
                app.close()
            restored = DesktopApp(directory)
            try:
                self.assertEqual(restored.records[remembered['stationKey']]['song']['title'], '中文歌名🎵')
            finally:
                restored.close()


if __name__ == '__main__':
    unittest.main()
