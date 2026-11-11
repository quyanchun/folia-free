// Verify real audio while browsing. Platform metadata flags are not enough:
// some public playlists mark paid songs as playable, and only the URL API reveals
// the empty stream at playback time. Only rows with a confirmed audio stream are
// shown; 'unknown' (rate limit, timeout, relay outage) is hidden as well but
// stays on a short retry TTL, so a dead provider cannot fill the list with
// songs that all fail on click. Sampling is tiny and the service-side circuit
// breaker caps how many requests one home screen can send to a provider.
const PROBE_SAMPLE = 2;      // tracks sampled per collection on the home screen
const SAMPLE_ROUNDS = 2;     // one extra page when the whole first sample fails
const LIST_CONCURRENCY = 2;  // bounded so verification does not trigger rate limits
const SHORT_TTL = 30000;     // transient failures must stay retryable
const LONG_TTL = 300000;
const STATES = new Set(['playable', 'unavailable', 'unknown']);
const stateOf = value => STATES.has(value) ? value : 'unknown';

function createAvailableCatalog(read, probe = async () => { throw new Error('availability probe is required'); }) {
    const requests = new Map();
    const verdicts = new Map();

    async function verdictsFor(keys) {
        const now = Date.now();
        const states = keys.map(key => {
            const cached = verdicts.get(key);
            return cached && cached.expires > now ? cached.state : null;
        });
        const missing = [];
        keys.forEach((key, index) => { if (!states[index]) missing.push({ key, index }); });
        if (!missing.length) return states;
        const replies = {};
        const unique = [...new Set(missing.map(item => item.key))];
        for (let start = 0; start < unique.length; start += 30) {
            const chunk = unique.slice(start, start + 30);
            try {
                const answer = await probe(chunk);
                for (const key of chunk) replies[key] = answer?.results?.[key];
            } catch {
                for (const key of chunk) replies[key] = undefined;
            }
        }
        for (const { key, index } of missing) {
            const state = stateOf(replies[key]);
            states[index] = state;
            if (verdicts.size >= 2000) verdicts.delete(verdicts.keys().next().value);
            verdicts.set(key, { state, expires: now + (state === 'unknown' ? SHORT_TTL : LONG_TTL) });
        }
        return states;
    }

    async function verifySongs(songs) {
        if (!songs.length) return { songs: [], uncertain: false, verified: 0 };
        const states = await verdictsFor(songs.map(song => String(song.stationKey || song.id)));
        return { songs: songs.filter((_, index) => states[index] === 'playable'),
            uncertain: states.includes('unknown'),
            verified: states.filter(state => state === 'playable').length };
    }

    async function request(operation, params) {
        const key = JSON.stringify([operation, params]);
        const old = requests.get(key);
        if (old && Date.now() < old.expires) return old.promise;
        if (requests.size >= 200) requests.delete(requests.keys().next().value);
        const entry = { expires: Infinity };
        entry.promise = load(operation, params).then(result => {
            entry.expires = Date.now() + (result.partial ? SHORT_TTL : LONG_TTL);
            return result;
        }).catch(error => { if (requests.get(key) === entry) requests.delete(key); throw error; });
        requests.set(key, entry);
        return entry.promise;
    }

    async function load(operation, params) {
        const result = await read(operation, params);
        if (operation === 'catalog-tracks' || operation === 'chart' || operation === 'search') {
            const raw = Array.isArray(result.songs) ? result.songs : [];
            const { songs, uncertain, verified } = await verifySongs(raw);
            // Pagination counts upstream slots, not rows that survived filtering.
            const hasMore = operation === 'catalog-tracks'
                ? (result.total !== undefined
                    ? params.offset + params.limit < Number(result.total)
                    : raw.length >= params.limit)
                : result.hasMore;
            return { ...result, songs, verified,
                ...(hasMore === undefined ? {} : { hasMore }),
                partial: uncertain || result.partial === true };
        }
        if (operation === 'catalog-list') {
            const rows = Array.isArray(result.collections) ? result.collections : [];
            const accepted = new Array(rows.length).fill(false);
            let cursor = 0;
            let failed = 0;
            let uncertain = 0;
            await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, rows.length) }, async () => {
                while (cursor < rows.length) {
                    const index = cursor++;
                    const row = rows[index];
                    try {
                        for (let round = 0; round < SAMPLE_ROUNDS; round += 1) {
                            const page = await request('catalog-tracks', {
                                source: row.source, kind: row.kind, id: row.id,
                                offset: round * PROBE_SAMPLE, limit: PROBE_SAMPLE,
                            });
                            if (page.partial) uncertain += 1;
                            if (page.verified > 0) { accepted[index] = true; break; }
                            if (!page.hasMore) break;
                        }
                    } catch { failed += 1; } // A temporary read failure is retried after the short TTL.
                }
            }));
            console.info('[MusicStation] Verified catalog', { source: params.source, kind: params.kind,
                received: rows.length, shown: accepted.filter(Boolean).length, failed, uncertain });
            return { ...result, collections: rows.filter((_, index) => accepted[index]),
                partial: failed > 0 || uncertain > 0 || result.partial === true };
        }
        return result;
    }
    return request;
}
module.exports = { createAvailableCatalog };
