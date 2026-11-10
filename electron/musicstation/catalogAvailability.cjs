// Preflight public cards with metadata only; never download audio while browsing.
function createAvailableCatalog(read) {
    const cache = new Map();
    async function request(operation, params) {
        const key = JSON.stringify([operation, params.source, params.kind, params.id, params.offset, params.limit]);
        const old = cache.get(key);
        if (old && Date.now() < old.expires) return old.promise;
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        const entry = { expires: Infinity };
        entry.promise = load(operation, params).then(result => {
            entry.expires = Date.now() + (result.partial ? 30000 : 300000);
            return result;
        }).catch(error => { if (cache.get(key) === entry) cache.delete(key); throw error; });
        cache.set(key, entry);
        return entry.promise;
    }
    async function load(operation, params) {
        const result = await read(operation, params);
        if (operation === 'catalog-tracks') {
            return { ...result, hasMore: result.total !== undefined
                ? params.offset + params.limit < result.total : result.songs.length >= params.limit,
            songs: result.songs.filter(song => song.playable !== false && song.downloadable !== false) };
        }
        const rows = result.collections;
        const accepted = new Array(rows.length).fill(false);
        let cursor = 0;
        let failed = 0;
        await Promise.all(Array.from({ length: Math.min(3, rows.length) }, async () => {
            while (cursor < rows.length) {
                const index = cursor++;
                const row = rows[index];
                try {
                    const page = await request('catalog-tracks', { source: row.source, kind: row.kind, id: row.id, offset: 0, limit: 30 });
                    // A restricted first page cannot prove later pages are also restricted.
                    accepted[index] = page.songs.length > 0 || page.hasMore;
                } catch {
                    failed += 1; // Temporary failures are retried after the short list TTL.
                }
            }
        }));
        console.info('[MusicStation] Public catalog preflight', { source: params.source, kind: params.kind,
            received: rows.length, shown: accepted.filter(Boolean).length, failed });
        return { ...result, collections: rows.filter((_, index) => accepted[index]), partial: failed > 0 };
    }
    return request;
}
module.exports = { createAvailableCatalog };
