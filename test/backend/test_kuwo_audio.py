"""A public standard stream may be AAC even when the request asks for MP3."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend/core'))
import kuwo
import audio_transfer


class KuwoAudioTests(unittest.TestCase):
    @patch.object(kuwo.requests, 'get')
    def test_accepts_standard_mp3_aac_and_m4a_without_transcoding(self, get):
        for format_name in ('mp3', 'aac', 'm4a'):
            with self.subTest(format_name=format_name):
                get.return_value = Mock(json=lambda: {'code': 200, 'data': {
                    'format': format_name, 'url': 'https://example.com/audio.' + format_name,
                }})
                with tempfile.TemporaryDirectory() as directory, patch.object(audio_transfer, 'download') as transfer:
                    kuwo.download({'id': '123', 'title': 'Song', 'singer': 'Artist'}, directory)
                    self.assertEqual(transfer.call_args.args[1].suffix, '.' + format_name)

    @patch.object(kuwo.requests, 'get')
    def test_rejects_missing_audio_and_unsupported_formats(self, get):
        for audio in ({'format': 'aac'}, {'format': 'html', 'url': 'https://example.com/error'}):
            get.return_value = Mock(json=lambda: {'code': 200, 'data': audio})
            with self.assertRaises(ValueError):
                kuwo.resolve_audio('123')

    @patch.object(kuwo.requests, 'get')
    def test_known_restricted_song_never_requests_a_stream(self, get):
        with self.assertRaises(ValueError):
            kuwo.download({'id': '123', 'playable': False}, '/unused')
        get.assert_not_called()


if __name__ == '__main__':
    unittest.main()
