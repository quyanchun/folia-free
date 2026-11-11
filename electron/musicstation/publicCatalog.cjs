const { qqList, qqTracks } = require('../qq/publicStation.cjs');
const { createKugouPublicCatalog } = require('../kugou/publicStation.cjs');
const { createAvailableCatalog } = require('./catalogAvailability.cjs');

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
        // Small pages let the home-screen preflight sample only a few tracks.
        if (!['playlist', 'album'].includes(params.kind) || (params.kind === 'album' && !ALBUM_SOURCES.has(params.source))
            || typeof params.id !== 'string' || !/^[A-Za-z0-9_]{1,90}$/.test(params.id)
            || !Number.isInteger(params.offset) || params.offset < 0 || params.offset > 10000
            || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > 30
            || params.offset % params.limit) throw new Error('Invalid public collection');
        return { source: params.source, kind: params.kind, id: params.id, offset: params.offset, limit: params.limit };
    }
    throw new Error('Invalid catalog operation');
}

function createPublicCatalog(call) {
    const { kugouList, kugouTracks } = createKugouPublicCatalog();
    async function read(operation, params) {
        const { source, kind } = params;
        // Only public playlists/albums use the local adapters. Searches and
        // charts for these same providers must keep going to the service API.
        if (operation !== 'catalog-list' && operation !== 'catalog-tracks') return call(operation, params);
        if (source !== 'qq' && source !== 'kugou') return call(operation, params);
        if (operation === 'catalog-list') return { collections: await (source === 'qq' ? qqList(kind) : kugouList(kind)) };
        const result = await (source === 'qq' ? qqTracks(params) : kugouTracks(params));
        // Register only adapter-produced records; renderer-supplied song objects are never accepted.
        const registered = await call('catalog-import', { songs: result.songs });
        return { ...result, songs: registered.songs };
    }
    return createAvailableCatalog(read, keys => call('availability', { keys }));
}
module.exports = { createPublicCatalog, validateCatalogRequest };
