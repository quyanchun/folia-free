"""Guard public metadata normalization and anonymous request behavior."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch, Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
import public_catalog as catalog


class PublicCatalogTests(unittest.TestCase):
    @patch.object(catalog, 'fetch')
    def test_migu_retains_content_id_and_standard_quality_restriction(self, fetch):
        fetch.return_value = {'data': {'totalCount': 31, 'songList': [
            {'contentId': '600902000006889366', 'songId': '3790007', 'songName': 'Song',
             'duration': 270, 'singerList': [{'name': 'Artist'}], 'album': 'Album',
             'audioFormats': [{'formatType': 'PQ', 'showTags': ['vip']}]}
        ]}}
        result = catalog.get_tracks('migu', 'playlist', '123', 30, 30)
        record = result['songs'][0]
        self.assertEqual(record['id'], '600902000006889366')
        self.assertEqual(record['singer'], 'Artist')
        self.assertEqual(record['duration_seconds'], 270)
        self.assertFalse(record['playable'])
        self.assertEqual(fetch.call_args.args[1]['pageNo'], 2)

    @patch.object(catalog, 'fetch')
    def test_netease_partial_response_ends_at_available_tracks(self, fetch):
        fetch.return_value = {'result': {'trackCount': 80, 'tracks': [
            {'id': 12, 'name': 'Song', 'artists': [{'name': 'Artist'}], 'duration': 123000}
        ]}}
        result = catalog.get_tracks('netease', 'playlist', '456', 0, 30)
        self.assertEqual(result['total'], 1)
        self.assertTrue(result['limited'])
        self.assertEqual(result['songs'][0]['duration_seconds'], 123)

    @patch.object(catalog, 'fetch')
    def test_netease_vip_and_paid_tracks_are_explicitly_restricted(self, fetch):
        fetch.return_value = {'result': {'tracks': [
            {'id': fee + 1, 'name': 'Song', 'fee': fee} for fee in (0, 1, 4, 8)
        ]}}
        tracks = catalog.get_tracks('netease', 'playlist', '456', 0, 30)['songs']
        self.assertEqual([s['playable'] for s in tracks], [True, False, False, True])

    def test_kuwo_standard_play_is_not_confused_with_vip_quality(self):
        self.assertTrue(catalog.kuwo_free({'payInfo': {'feeType': {'vip': '1'}, 'listen_fragment': '0'}}))
        self.assertFalse(catalog.kuwo_free({'payInfo': {'listen_fragment': '1'}}))
        self.assertFalse(catalog.kuwo_free({'payInfo': {'cannotOnlinePlay': '1'}}))
        self.assertFalse(catalog.kuwo_free({'online': '0'}))

    @patch.object(catalog, 'fetch')
    def test_kuwo_album_uses_numeric_playback_id_and_page_number(self, fetch):
        fetch.return_value = {'name': 'Album', 'songnum': 65, 'musiclist': [
            {'id': 'MUSIC_476991828', 'name': 'Title', 'artist': 'Artist', 'duration': '99'}
        ]}
        result = catalog.get_tracks('kuwo', 'album', '789', 30, 30)
        self.assertEqual(result['songs'][0]['id'], '476991828')
        self.assertEqual(result['songs'][0]['album'], 'Album')
        self.assertEqual(fetch.call_args.args[1]['pn'], 1)

    @patch.object(catalog.requests, 'get')
    def test_single_quoted_kuwo_response_is_parsed_without_eval(self, get):
        response = Mock(content=b'fixture', text="{'albumlist':[{'id':'123'}]}")
        response.json.side_effect = ValueError()
        get.return_value = response
        self.assertEqual(catalog.fetch('https://search.kuwo.cn/r.s', {}, 'kuwo')['albumlist'][0]['id'], '123')
        self.assertNotIn('Cookie', get.call_args.kwargs['headers'])
        response.text = "__import__('os').system('false')"
        with self.assertRaises(ValueError):
            catalog.fetch('https://search.kuwo.cn/r.s', {}, 'kuwo')

    @patch.object(catalog, 'fetch')
    def test_migu_plaza_deduplicates_only_playlist_items(self, fetch):
        rows = [{'resId': '123', 'resType': '2021', 'txt': 'Playlist'}, {'resId': '123', 'resType': '2021', 'txt': 'Duplicate'}, {'resId': '124', 'resType': '2003', 'txt': 'Not a playlist'}]
        fetch.return_value = {'data': {'contents': rows}}
        self.assertEqual([c['id'] for c in catalog.list_collections('migu', 'playlists')], ['123'])


if __name__ == '__main__':
    unittest.main()
