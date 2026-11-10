"""Supplement real provider metadata without transcoding or removing existing tags."""
import datetime
import re
import unicodedata

import requests
from mutagen import File
from mutagen.id3 import ID3, ID3NoHeaderError, TIT2, TPE1, TALB, TPE2, TDRC, TRCK, TPOS, TPUB, APIC, USLT


def enrich(song):
    result = dict(song)
    try:
        if song['source'] == 'netease':
            response = requests.get('https://music.163.com/api/song/detail/',
                                    params={'id': song['id'], 'ids': '[' + str(song['id']) + ']'}, timeout=6)
            response.raise_for_status()
            info = response.json()['songs'][0]
            album = info.get('album') or info.get('al') or {}
            artists = [a['name'] for a in info.get('artists', info.get('ar', [])) if a.get('name')]
            result.update(title=info['name'], artists=artists, singer='、'.join(artists),
                          album=album.get('name') or song.get('album', ''),
                          cover_url=album.get('picUrl', ''), publisher=album.get('company', ''),
                          album_artist=[a['name'] for a in album.get('artists', []) if a.get('name')],
                          track_number=info.get('no'), disc_number=info.get('disc'),
                          duration_seconds=int((info.get('duration') or info.get('dt') or 0) / 1000))
            published = info.get('publishTime') or album.get('publishTime')
            if published and published > 0:
                result['date'] = datetime.datetime.fromtimestamp(published / 1000, datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y-%m-%d')
        elif song['source'] == 'kuwo':
            from kuwo import clean_text
            response = requests.get('https://m.kuwo.cn/newh5/singles/songinfoandlrc',
                                    params={'musicId': song['id'], 'httpsStatus': 1}, timeout=6)
            response.raise_for_status()
            data = response.json()['data']
            info = data['songinfo']
            result.update(title=clean_text(info.get('songName') or song['title']),
                          singer=clean_text(info.get('artist') or song.get('singer', '')),
                          album=clean_text(info.get('album') or song.get('album', '')),
                          cover_url=info.get('pic', ''),
                          lyrics='\n'.join(line['lineLyric'] for line in data.get('lrclist', []) if line.get('lineLyric')),
                          duration_seconds=int(info.get('duration') or song.get('duration_seconds') or 0))
            # Kuwo also publishes these images on its canonical, TLS-valid CDN.
            result['cover_url'] = re.sub(r'^https?://img(\d+)\.kwcdn\.kuwo\.cn/',
                                         r'https://img\1.kuwo.cn/', result['cover_url'])
    except (requests.RequestException, ValueError, KeyError, IndexError, TypeError):
        result['metadata_notice'] = '部分平台信息未取得'
    return result


def filename(song, suffix):
    title = song.get('title') or str(song['id'])
    singer = song.get('singer', '')
    name = title + (' - ' + singer if singer else '')
    name = unicodedata.normalize('NFC', name)
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', name).strip(' .') or '歌曲'
    limit = 255 - len(suffix.encode('utf-8'))
    name = name.encode('utf-8')[:limit].decode('utf-8', errors='ignore').rstrip(' .')
    return name + suffix


def cover_image(url):
    if not url.startswith(('http://', 'https://')):
        return None
    try:
        with requests.get(url, stream=True, timeout=6) as response:
            response.raise_for_status()
            data = bytearray()
            for chunk in response.iter_content(65536):
                data.extend(chunk)
                if len(data) > 2 * 1024 * 1024:
                    return None
        raw = bytes(data)
        if raw.startswith(b'\xff\xd8\xff'):
            return 'image/jpeg', raw
        if raw.startswith(b'\x89PNG\r\n\x1a\n'):
            return 'image/png', raw
    except requests.RequestException:
        pass
    return None


def write_tags(path, song):
    artists = song.get('artists') or ([song['singer']] if song.get('singer') else [])
    values = {'title': [song['title']], 'artist': artists,
              'album': [song['album']] if song.get('album') else [],
              'albumartist': song.get('album_artist') or [],
              'date': [song['date']] if song.get('date') else [],
              'tracknumber': [str(song['track_number'])] if song.get('track_number') else [],
              'discnumber': [str(song['disc_number'])] if song.get('disc_number') else [],
              'publisher': [song['publisher']] if song.get('publisher') else []}
    written = []
    if path.suffix.lower() == '.mp3':
        try:
            tags = ID3(path)
        except ID3NoHeaderError:
            tags = ID3()
        frames = {'title': TIT2, 'artist': TPE1, 'album': TALB, 'albumartist': TPE2,
                  'date': TDRC, 'tracknumber': TRCK, 'discnumber': TPOS, 'publisher': TPUB}
        for key, texts in values.items():
            if texts:
                # Preserve supplied date, track number and other existing credits.
                if key in ('title', 'artist', 'album') or not tags.getall(frames[key].__name__):
                    tags.add(frames[key](encoding=3, text=texts))
                written.append(key)
        if song.get('lyrics') and not tags.getall('USLT'):
            tags.add(USLT(encoding=3, lang='zho', desc='', text=song['lyrics']))
            written.append('lyrics')
        if not tags.getall('APIC'):
            cover = cover_image(song.get('cover_url', ''))
            if cover:
                mime, data = cover
                tags.add(APIC(encoding=3, mime=mime, type=3, desc='Cover', data=data))
        if tags.getall('APIC'):
            written.append('cover')
        tags.save(path)
    else:
        audio = File(path, easy=True)
        if audio is None:
            return []
        if audio.tags is None:
            audio.add_tags()
        for key, texts in values.items():
            if texts:
                try:
                    if key in ('title', 'artist', 'album') or key not in audio:
                        audio[key] = texts
                    written.append(key)
                except (KeyError, ValueError):
                    continue
        audio.save()
    return written
