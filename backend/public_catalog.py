"""Anonymous public metadata for the bundled station, independent of cloud accounts."""
import ast
import datetime
import html
import re
import requests

LABELS = {'netease': '网易云', 'qq': 'QQ音乐', 'kugou': '酷狗', 'kuwo': '酷我', 'migu': '咪咕'}


def clean(value):
    return html.unescape(str(value or '')).strip()


def fetch(url, params, source):
    referer = 'https://www.kuwo.cn/' if source == 'kuwo' else 'https://m.music.migu.cn/' if source == 'migu' else 'https://music.163.com/'
    response = requests.get(url, params=params, headers={'User-Agent': 'Mozilla/5.0', 'Referer': referer}, timeout=15)
    response.raise_for_status()
    if len(response.content) > 6 * 1024 * 1024:
        raise ValueError('Catalog response too large')
    try:
        body = response.json()
    except ValueError:
        body = ast.literal_eval(response.text)
    if not isinstance(body, dict):
        raise ValueError('Invalid catalog response')
    if body.get('code') not in (None, 200, '000000'):
        raise ValueError('Public catalog is unavailable')
    return body


def collection(source, kind, identifier, name, cover='', count=None, description=''):
    return {'source': source, 'kind': kind, 'id': str(identifier), 'name': clean(name),
            'cover': str(cover or '').replace('http://', 'https://'), 'count': count,
            'description': clean(description), 'limited': source == 'netease'}


def list_collections(source, kind):
    if source == 'netease':
        if kind == 'albums':
            raise ValueError('Album catalog is not enabled')
        recommended = kind == 'recommendations'
        body = fetch('https://music.163.com/api/' + ('personalized/playlist' if recommended else 'playlist/list'),
                     {'limit': 12, 'offset': 0, 'cat': '全部', 'order': 'hot'}, source)
        rows = body.get('result' if recommended else 'playlists') or []
        return [collection(source, 'playlist', r['id'], r['name'], r.get('picUrl') or r.get('coverImgUrl'),
                           r.get('trackCount'), r.get('description')) for r in rows]
    if source == 'kuwo':
        if kind == 'albums':
            # The anonymous public album search is verified; no paid web API or login is used.
            body = fetch('https://search.kuwo.cn/r.s', {'all': '周杰伦', 'pn': 0, 'rn': 12, 'rformat': 'json',
                         'encoding': 'utf8', 'ft': 'album'}, source)
            return [collection(source, 'album', r['albumid'], r['name'], r.get('hts_img') or r.get('img'), r.get('musiccnt'), r.get('artist'))
                    for r in body.get('albumlist') or []]
        body = fetch('https://wapi.kuwo.cn/api/pc/classify/playlist/getRcmPlayList',
                     {'loginUid': 0, 'loginSid': 0, 'appUid': 76039576, 'pn': 1, 'rn': 12,
                      'order': 'hot' if kind == 'playlists' else 'new'}, source)
        return [collection(source, 'playlist', r['id'], r['name'], r.get('img'), r.get('total'), r.get('uname'))
                for r in (body.get('data') or {}).get('data') or []]
    if source == 'migu':
        if kind == 'albums':
            raise ValueError('Album catalog is not enabled')
        body = fetch('https://app.c.nf.migu.cn/pc/bmw/page-data/playlist-square-recommend/v1.0',
                     {'templateVersion': 2, 'pageNo': 1}, source)
        rows, seen = [], set()
        def visit(node):
            if isinstance(node, dict):
                identifier = str(node.get('resId') or '')
                if str(node.get('resType')) == '2021' and identifier.isdigit() and identifier not in seen:
                    seen.add(identifier)
                    rows.append(collection(source, 'playlist', identifier, node.get('txt'), node.get('img'), description=node.get('txt2')))
                for item in node.values():
                    visit(item)
            elif isinstance(node, list):
                for item in node:
                    visit(item)
        visit(body.get('data'))
        # The same public plaza supplies browse and editorial recommendations.
        return rows[:12] if kind == 'playlists' else rows[12:24] or rows[:12]
    raise ValueError('Unsupported public catalog source')


def song(source, identifier, title, singer, album='', seconds=0, **extra):
    seconds = max(0, int(seconds or 0))
    return {'source': source, 'id': identifier, 'title': clean(title), 'singer': clean(singer),
            'album': clean(album), 'duration_seconds': seconds,
            'duration': str(datetime.timedelta(seconds=seconds)), 'hash': '', **extra}


def get_tracks(source, kind, identifier, offset, limit):
    if source == 'netease' and kind == 'playlist':
        body = fetch('https://music.163.com/api/playlist/detail', {'id': identifier}, source)
        listing = body.get('result') or body.get('playlist') or {}
        tracks = listing.get('tracks') or []
        # This public API may expose only a prefix. Never invent later pages or bypass login.
        songs = [song(source, r['id'], r['name'], '、'.join(a['name'] for a in r.get('artists', r.get('ar', []))),
                      (r.get('album') or r.get('al') or {}).get('name'), (r.get('duration') or r.get('dt') or 0) // 1000,
                      playable=r.get('fee') not in (1, 4), downloadable=r.get('fee') not in (1, 4))
                 for r in tracks[offset:offset + limit]]
        return {'songs': songs, 'total': len(tracks), 'limited': int(listing.get('trackCount') or 0) > len(tracks)}
    if source == 'kuwo':
        if kind == 'album':
            body = fetch('https://search.kuwo.cn/r.s', {'pn': offset // limit, 'rn': limit, 'stype': 'albuminfo',
                         'albumid': identifier, 'show_copyright_off': 0, 'encoding': 'utf', 'vipver': 'MUSIC_9.1.0'}, source)
            total = int(body.get('songnum') or 0)
        else:
            body = fetch('https://nplserver.kuwo.cn/pl.svc', {'op': 'getlistinfo', 'pid': identifier,
                         'pn': offset // limit, 'rn': limit, 'encode': 'utf8', 'keyset': 'pl2012', 'identity': 'kuwo',
                         'pcmp4': 1, 'vipver': 'MUSIC_9.0.5.0_W1', 'newver': 1}, source)
            total = int(body.get('total') or 0)
        rows = body.get('musiclist') or []
        songs = [song(source, re.sub(r'^MUSIC_', '', str(r.get('id') or r.get('rid') or r.get('musicrid'))),
                      r.get('name') or r.get('songname'), r.get('artist'), r.get('album') or (body.get('name') if kind == 'album' else ''),
                      r.get('duration') or r.get('song_duration') or 0,
                      playable=kuwo_free(r), downloadable=kuwo_free(r)) for r in rows]
        return {'songs': songs, 'total': total or len(songs)}
    if source == 'migu' and kind == 'playlist':
        body = fetch('https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0',
                     {'playlistId': identifier, 'pageNo': offset // limit + 1, 'pageSize': limit}, source)
        data = body.get('data') or {}
        songs = []
        for r in data.get('songList') or []:
            if not r.get('contentId'):
                continue
            r = dict(r)
            r['singer'] = r.get('singer') or '、'.join(a.get('name', '') for a in r.get('singerList') or [])
            pq = next((a for a in r.get('audioFormats') or [] if a.get('formatType') == 'PQ'), {})
            vip = 'vip' in (pq.get('showTags') or r.get('showTags') or [])
            songs.append(song(source, str(r['contentId']), r.get('songName'), r['singer'], r.get('album'),
                              r.get('duration'), playable=not vip, downloadable=not vip))
        return {'songs': songs, 'total': int(data.get('totalCount') or len(songs))}
    raise ValueError('Unsupported public collection')


def kuwo_free(record):
    """Only explicit full-play restrictions exclude a track; VIP quality alone does not."""
    pay = record.get('payInfo') or {}
    return str(record.get('online', '1')) != '0' and not any(
        str(pay.get(field, '0')) == '1' for field in ('cannotOnlinePlay', 'listen_fragment'))
