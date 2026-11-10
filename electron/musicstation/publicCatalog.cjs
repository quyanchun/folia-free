const { qqList, qqTracks } = require('../qq/publicStation.cjs');
const { createKugouPublicCatalog } = require('../kugou/publicStation.cjs');

// Aggregate only anonymous adapters; signed-in services are independent.
const ALBUM_SOURCES = new Set(['qq', 'kugou', 'kuwo']);
const PUBLIC_SOURCES = new Set(['netease', 'qq', 'kugou', 'kuwo', 'migu']);
function validateCatalogRequest(operation, params) {
    if (!PUBLIC_SOURCES.has(params.source)) throw new Error('Invalid catalog source');
    if (operation === 'catalog-list') {
        if (!['playlists', 'recommendations', 'albums'].includes(params.kind)
            || (params.kind === 'albums' && !ALBUM_SOURCES.has(params.source))) throw new Error('Invalid catalog kind');
        return { source: params.source, kind: params.kind };
    }
    if (operation === 'catalog-tracks') {
        if (!['playlist', 'album'].includes(params.kind) || (params.kind === 'album' && !ALBUM_SOURCES.has(params.source))
            || typeof params.id !== 'string' || !/^[A-Za-z0-9_]{1,90}$/.test(params.id)
            || !Number.isInteger(params.offset) || params.offset < 0 || params.offset > 10000
            || params.limit !== 30 || params.offset % 30) throw new Error('Invalid public collection');
        return { source: params.source, kind: params.kind, id: params.id, offset: params.offset, limit: 30 };
    }
    throw new Error('Invalid catalog operation');
}

function createPublicCatalog(call) {
    const cache = new Map();
    const { kugouList, kugouTracks } = createKugouPublicCatalog();
    async function read(operation, params) {
        const { source, kind } = params;
        if (source !== 'qq' && source !== 'kugou') return call(operation, params);
        if (operation === 'catalog-list') return { collections: await (source === 'qq' ? qqList(kind) : kugouList(kind)) };
        const result = await (source === 'qq' ? qqTracks(params) : kugouTracks(params));
        // Register only adapter-produced records; renderer-supplied song objects are never accepted.
        const registered = await call('catalog-import', { songs: result.songs });
        return { ...result, songs: registered.songs };
    }
    return async (operation, params) => {
        const key = JSON.stringify([operation, params]);
        const old = cache.get(key);
        if (old && Date.now() - old.at < 300000) return old.promise;
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        const entry = { at: Date.now() };
        entry.promise = read(operation, params).catch(error => { if (cache.get(key) === entry) cache.delete(key); throw error; });
        cache.set(key, entry);
        return entry.promise;
    };
}
module.exports = { createPublicCatalog, validateCatalogRequest };
