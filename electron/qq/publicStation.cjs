const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Public station metadata uses anonymous reads only, without the QQ account service.
const clean = value => String(value || '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
const cover = value => String(value || '').replace('http://', 'https://').replaceAll('{size}', '400');
const item = (source, kind, id, name, image, count, description) => ({ source, kind, id: String(id), name: clean(name), cover: cover(image), count: count === undefined ? undefined : Number(count), description: clean(description) });
async function publicJson(url, params) {
    const target = new URL(url);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, String(value));
    const response = await fetch(target, { headers: { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(18000) });
    if (!response.ok) throw new Error('Public catalog HTTP failure');
    const text = await response.text();
    if (text.length > 6 * 1024 ** 2) throw new Error('Catalog response too large');
    const data = JSON.parse(text);
    if (data.code !== 0 || (data.subcode !== undefined && data.subcode !== 0)) throw new Error('Public catalog unavailable');
    return data;
}

async function qqList(kind) {
    const base = path.dirname(require.resolve('@yakult-green-tea/qq-music-api/package.json'));
    const load = file => import(pathToFileURL(path.join(base, 'dist-esm/src/services/recommend', file)).href);
    if (kind === 'albums') {
        const { newAlbumsResult } = await load('catalog.js');
        const reply = await newAlbumsResult({ limit: 12 });
        if (reply.status !== 200) throw new Error('QQ public albums unavailable');
        return reply.body.albums.map(r => item('qq', 'album', r.mid, r.name,
            `https://y.gtimg.cn/music/photo_new/T002R300x300M000${r.mid}.jpg`, r.trackCount, r.singers.map(s => s.name).join('、')));
    }
    const { recommendPlaylistsResult } = await load('recommendPlaylists.js');
    const reply = await recommendPlaylistsResult(null, 12);
    if (reply.status !== 200) throw new Error('QQ public playlists unavailable');
    return reply.body.playlists.map(r => item('qq', 'playlist', r.tid, r.title, r.picurl, r.songnum, r.desc));
}

function qqSong(r) {
    const paid = Number(r.pay?.payplay || r.pay?.pay_play || 0) !== 0;
    return { source: 'qq', id: r.songmid || r.mid, title: clean(r.songname || r.title || r.name),
        singer: (r.singer || []).map(s => clean(s.name)).join('、'), album: clean(r.albumname || r.album?.name),
        duration_seconds: Number(r.interval || 0), playable: !paid, downloadable: !paid };
}

async function qqTracks({ kind, id, offset, limit }) {
    const album = kind === 'album';
    const data = await publicJson('https://c.y.qq.com/' + (album ? 'v8/fcg-bin/fcg_v8_album_info_cp.fcg' : 'qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg'),
        album ? { albummid: id, format: 'json' } : { disstid: id, format: 'json', type: 1, json: 1, utf8: 1, onlysong: 0, g_tk: 5381, loginUin: 0, hostUin: 0, platform: 'yqq', needNewCode: 0 });
    const rows = album ? data.data?.list : data.cdlist?.[0]?.songlist;
    if (!Array.isArray(rows)) throw new Error('QQ collection unavailable');
    return { songs: rows.slice(offset, offset + limit).map(qqSong), total: rows.length };
}

module.exports = { qqList, qqTracks, qqSong };
