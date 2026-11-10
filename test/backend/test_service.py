"""Check desktop cache cleanup and persistent identities without platform traffic."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
from service import DesktopApp


class CacheTests(unittest.TestCase):
    def test_clear_preserves_catalog_and_downloads(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = DesktopApp(temporary)
            try:
                song = app.remember([{'id': 'fixture', 'source': 'kuwo', 'title': 'Fixture', 'singer': 'Artist'}])[0]
                directory = app.cache / 'tmpfixture'
                directory.mkdir()
                audio = directory / 'song.mp3'
                audio.write_bytes(b'fixture')
                app.records[song['stationKey']].update(file=audio, download={'url': '/files/fixture'})
                download = app.data / '下载/keep.mp3'
                download.write_bytes(b'keep')
                self.assertEqual(app.cache_entries()[0]['size'], 7)
                with app.audio_lock:
                    self.assertEqual(app.cache_entries()[0]['size'], 7)
                with self.assertRaises(ValueError):
                    app.remove_cache('../下载')
                app.remove_cache('tmpfixture')
                self.assertEqual(app.cache_entries(), [])
                self.assertTrue(download.exists())
                self.assertEqual(app.records[song['stationKey']]['song']['id'], 'fixture')
                self.assertNotIn('file', app.records[song['stationKey']])
            finally:
                app.close()
            restored = DesktopApp(temporary)
            try:
                self.assertEqual(restored.records[song['stationKey']]['song']['id'], 'fixture')
            finally:
                restored.close()


if __name__ == '__main__':
    unittest.main()
