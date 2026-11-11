"""Rules for preflight audio checks; no platform traffic in these unit tests."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend' / 'core'))
import availability as av  # noqa: E402


class AvailabilityTests(unittest.TestCase):
    def test_static_restriction_never_resolves_a_url(self):
        with patch.object(av, 'resolve', side_effect=AssertionError('unexpected network call')):
            state, _ = av.check_one({'source': 'kugou', 'id': 'a' * 32, 'playable': False})
            self.assertEqual(state, av.UNAVAILABLE)
            state, _ = av.check_one({'source': 'kuwo', 'id': '123', 'downloadable': False})
            self.assertEqual(state, av.UNAVAILABLE)

    def test_outages_stay_retryable_but_paid_songs_are_final(self):
        self.assertEqual(av.classify(ValueError('QQ 音乐解析服务暂时不可用（502 Server Error）')), av.UNKNOWN)
        self.assertEqual(av.classify(ValueError('平台请求频繁，请稍后再试')), av.UNKNOWN)
        self.assertEqual(av.classify(ValueError('HTTPSConnectionPool timeout')), av.UNKNOWN)
        self.assertEqual(av.classify(ValueError('这首歌需要会员或暂不可下载')), av.UNAVAILABLE)
        self.assertEqual(av.classify(ValueError('未取得可下载音频')), av.UNAVAILABLE)

    def test_stream_probe_requires_an_audio_signature(self):
        class Response:
            status_code = 206
            headers = {'Content-Type': 'audio/mpeg'}
            def iter_content(self, size):
                yield b'ID3\x04\x00\x00' + b'\x00' * 100
            def close(self):
                pass
        with patch.object(av.requests, 'get', return_value=Response()):
            self.assertEqual(av.probe_stream('https://example.com/a.mp3', {})[0], av.PLAYABLE)
        class Html(Response):
            def iter_content(self, size):
                yield b'<!DOCTYPE html><html>error</html>'
        with patch.object(av.requests, 'get', return_value=Html()):
            self.assertEqual(av.probe_stream('https://example.com/a.mp3', {})[0], av.UNAVAILABLE)
        class Forbidden(Response):
            status_code = 403
        with patch.object(av.requests, 'get', return_value=Forbidden()):
            self.assertEqual(av.probe_stream('https://example.com/a.mp3', {})[0], av.UNAVAILABLE)

    def test_prepared_file_is_strong_evidence_but_a_text_file_is_not(self):
        with tempfile.TemporaryDirectory() as temporary:
            good = Path(temporary) / 'song.mp3'
            good.write_bytes(b'ID3\x04\x00\x00' + b'\x00' * 5000)
            self.assertTrue(av.cached_audio_ok(good))
            bad = Path(temporary) / 'error.mp3'
            bad.write_bytes(b'{"code": 404}' + b' ' * 5000)
            self.assertFalse(av.cached_audio_ok(bad))
            self.assertFalse(av.cached_audio_ok(Path(temporary) / 'missing.mp3'))

    def test_verdicts_are_cached_and_a_broken_source_is_throttled(self):
        checker = av.AvailabilityChecker()
        first = [{'source': 'qq', 'id': f'first{i}'} for i in range(3)]
        with patch.object(av, 'check_one', return_value=(av.UNKNOWN, 'timeout')) as probe:
            self.assertEqual(checker.check_many(first), [av.UNKNOWN] * 3)
            later = [{'source': 'qq', 'id': f'later{i}'} for i in range(3)]
            self.assertEqual(checker.check_many(later), [av.UNKNOWN] * 3)
            self.assertEqual(probe.call_count, 3)  # source cooled down after 3 outages
        with patch.object(av, 'check_one', side_effect=AssertionError('cached verdict should be reused')):
            self.assertEqual(checker.check_many(first), [av.UNKNOWN] * 3)

    def test_successful_probe_resets_failure_counter(self):
        checker = av.AvailabilityChecker()
        # One outage is below the circuit breaker, so a recovery can clear it.
        with patch.object(av, 'check_one', return_value=(av.UNKNOWN, 'timeout')):
            checker.check_many([{'source': 'kugou', 'id': 'id0'}])
        self.assertEqual(checker.failures['kugou'], 1)
        with patch.object(av, 'check_one', return_value=(av.PLAYABLE, 'id1')):
            checker.check_many([{'source': 'kugou', 'id': 'recovered'}])
        self.assertEqual(checker.failures['kugou'], 0)


if __name__ == '__main__':
    unittest.main()
