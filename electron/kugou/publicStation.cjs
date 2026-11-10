const path = require('node:path');
const crypto = require('node:crypto');

// This catalog owns a fresh anonymous device identity and never reads login credentials.
const clean = value => String(value || '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
const cover = value => String(value || '').replace('http://', 'https://').replaceAll('{size}', '400');
const item = (source, kind, id, name, image, count, description) => ({ source, kind, id: String(id), name: clean(name), cover: cover(image), count: count === undefined ? undefined : Number(count), description: clean(description) });
function kugouSong(r) {
    const audio = r.audio_info || r;
    const base = r.base || {};
    const hash = audio.hash_128 || audio.hash;
    const name = clean(base.audio_name || base.songname || r.name);
    const singers = r.singerinfo || base.singerinfo || [];
    const paid = Number(r.feetype || r.copyright?.sale_mode_128_download || 0) !== 0;
    return { source: 'kugou', id: hash, hash, title: base.audio_name || base.songname || name.split(' - ').slice(1).join(' - ') || name,
        singer: singers.map(s => s.name).join('、') || base.author_name || name.split(' - ')[0], album: r.albuminfo?.name || r.album_info?.album_name || base.album_name || '',
        duration_seconds: Math.round(Number(audio.duration || r.timelen || 0) / 1000), playable: !paid, downloadable: !paid };
}

function createKugouPublicCatalog() {
    const cookie = { KUGOU_API_MID: crypto.randomBytes(16).toString('hex') };
    async function kugou(method, params = {}) {
        const base = path.dirname(require.resolve('kugoumusicapi/package.json'));
        const { createRequest } = require(path.join(base, 'util/request.js'));
        let timer;
        let response;
        try {
            response = await Promise.race([
                require(path.join(base, 'module', method + '.js'))({ ...params, cookie }, createRequest),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Kugou catalog timed out')), 20000); timer.unref(); }),
            ]);
        } finally { clearTimeout(timer); }
        const body = response.body;
        if (response.status !== 200 || (body.error_code ?? body.errcode ?? 0) !== 0) throw new Error('Kugou public catalog unavailable');
        return body;
    }
    async function kugouList(kind) {
        const album = kind === 'albums';
        const body = await kugou(album ? 'top_album' : 'top_playlist', { pagesize: 12 });
        const rows = album ? body.data?.chn : body.data?.special_list;
        if (!Array.isArray(rows)) throw new Error('Kugou catalog unavailable');
        return rows.slice(0, 12).map(r => album ? item('kugou', 'album', r.albumid, r.albumname, r.imgurl, r.songcount, r.singername)
            : item('kugou', 'playlist', r.global_collection_id, r.specialname, r.imgurl || r.pic, r.songcount, r.intro));
    }
    async function kugouTracks({ kind, id, offset, limit }) {
        const album = kind === 'album';
        const body = await kugou(album ? 'album_songs' : 'playlist_track_all', { id, page: offset / limit + 1, pagesize: limit });
        const data = body.data || {};
        if (!Array.isArray(data.songs)) throw new Error('Kugou collection unavailable');
        const songs = data.songs.map(kugouSong).filter(r => /^[a-f0-9]{32}$/i.test(r.id || ''));
        return { songs, total: Number(data.total ?? data.count ?? body.total ?? songs.length) };
    }
    return { kugouList, kugouTracks };
}
module.exports = { createKugouPublicCatalog, kugouSong };
