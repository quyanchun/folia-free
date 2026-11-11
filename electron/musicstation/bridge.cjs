const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { createPublicCatalog, validateCatalogRequest } = require('./publicCatalog.cjs');

// Own one local provider process; only bounded operations and opaque media IDs cross IPC.
const STATION_SCHEME = 'folia-station';
const STATION_PRIVILEGED_SCHEME = {
    scheme: STATION_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
};
const SOURCES = new Set(['netease', 'qq', 'kugou', 'kuwo', 'migu', 'bilibili']);
const CHARTS = new Set(['hot', 'new', 'rising']);
const KEY = /^[a-f0-9]{64}$/;

function validateRequest(operation, params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid request');
    if (operation === 'catalog-list' || operation === 'catalog-tracks') return validateCatalogRequest(operation, params);
    if (operation === 'search') {
        if (!SOURCES.has(params.source) || typeof params.query !== 'string' || !params.query.trim() || params.query.length > 100) throw new Error('Invalid search');
        return { source: params.source, query: params.query };
    }
    if (operation === 'chart') {
        if (!SOURCES.has(params.source) || params.source === 'bilibili' || !CHARTS.has(params.chart)
            || !Number.isInteger(params.page) || params.page < 1 || params.page > 100) throw new Error('Invalid chart');
        return { source: params.source, chart: params.chart, page: params.page };
    }
    if (['media', 'details', 'song'].includes(operation) && typeof params.key === 'string' && KEY.test(params.key)) return { key: params.key };
    throw new Error('Unsupported music station operation');
}

function createMusicStationBridge({ app, protocol, net, dataRoot, onCacheWrite = async () => {}, spawnProcess = spawn }) {
    let child;
    let base;
    let ready;
    let stopPromise;
    let stopping = false;
    let pinnedCacheEntry;
    let mediaRequests = 0;
    const streamPins = new Map();
    let cacheLimit = 4 * 1024 ** 3;

    function start() {
        if (stopping) return Promise.reject(new Error('Music station is shutting down'));
        if (ready) return ready;
        const root = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../../.release-build/backend');
        const executable = path.join(root, 'music-station-service', process.platform === 'win32' ? 'music-station-service.exe' : 'music-station-service');
        child = spawnProcess(executable, [], { env: { ...process.env, MUSIC_STATION_DATA: dataRoot, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const running = child;
        child.stderr.on('data', chunk => console.warn('[MusicStation]', chunk.toString().trim()));
        ready = new Promise((resolve, reject) => {
            let buffer = '';
            const timer = setTimeout(() => { child.kill(); reject(new Error('Music station startup timed out')); }, 30000);
            const reset = () => {
                if (child === running) { child = null; base = null; ready = null; }
                clearTimeout(timer);
            };
            child.once('error', error => { reset(); reject(error); });
            child.once('exit', code => { reset(); reject(new Error(`Music station exited (${code})`)); });
            child.stdout.on('data', chunk => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    try {
                        const value = JSON.parse(line);
                        if (value.ready && Number.isInteger(value.port) && value.port > 0 && value.port < 65536) {
                            base = `http://127.0.0.1:${value.port}`;
                            clearTimeout(timer);
                            console.info('[MusicStation] Local provider service is ready');
                            resolve();
                        }
                    } catch { /* Readiness is the only stdout protocol. */ }
                }
            });
        });
        return ready;
    }

    async function call(operation, payload) {
        await start();
        if (!base) throw new Error('Local provider service stopped');
        const response = await fetch(`${base}/desktop/${operation}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(100000),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Local provider request failed');
        return data;
    }

    const publicCatalog = createPublicCatalog(call);

    async function request(operation, params = {}, pinForStream = false) {
        let acquiring = false;
        try {
            const payload = validateRequest(operation, params);
            if (operation === 'media') { mediaRequests += 1; acquiring = true; }
            // Browsing results (public catalogs, charts and searches) all pass
            // the same audio verification before any row reaches the renderer.
            const verified = operation.startsWith('catalog-') || operation === 'search' || operation === 'chart';
            const data = await (verified ? publicCatalog(operation, payload) : call(operation, payload));
            if (operation === 'media') {
                pinnedCacheEntry = data.cache_entry;
                if (pinForStream) streamPins.set(data.cache_entry, (streamPins.get(data.cache_entry) || 0) + 1);
                mediaRequests -= 1;
                acquiring = false;
                const limit = Number(params.limitBytes);
                cacheLimit = Number.isFinite(limit) && limit >= 0 ? limit : cacheLimit;
                await onCacheWrite(cacheLimit).catch(error => console.warn('[MusicStation] Cache pruning failed', error));
                data.url = `${STATION_SCHEME}://audio/${payload.key}`;
            }
            if (operation === 'details' && data.artwork) data.artwork = `${STATION_SCHEME}://cover/${payload.key}.jpg`;
            return { ok: true, data };
        } catch (error) {
            console.warn('[MusicStation] Provider request failed', error);
            return { ok: false, error: error instanceof Error ? error.message : 'Local provider request failed' };
        } finally {
            if (acquiring) mediaRequests -= 1;
        }
    }

    function registerProtocol() {
        protocol.handle(STATION_SCHEME, async incoming => {
            const url = new URL(incoming.url);
            const name = url.pathname.slice(1);
            if (url.hostname === 'cover' && /^(?:[a-f0-9]{64}\.jpg|(?:netease|qq|kugou|kuwo|migu|bilibili)-(?:hot|new|rising)\.svg)$/.test(name)) {
                try {
                    return new Response(await fs.promises.readFile(path.join(dataRoot, '封面', name)), {
                        headers: { 'Content-Type': name.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg', 'Access-Control-Allow-Origin': '*' },
                    });
                } catch { return new Response(null, { status: 404 }); }
            }
            if (url.hostname !== 'audio' || !KEY.test(name)) return new Response(null, { status: 404 });
            let leased;
            const release = () => {
                if (!leased) return;
                const remaining = (streamPins.get(leased) || 1) - 1;
                if (remaining) streamPins.set(leased, remaining);
                else streamPins.delete(leased);
                leased = null;
            };
            try {
                // A prefetched URL can outlive its evicted file; recreate it before every stream.
                const prepared = await request('media', { key: name, limitBytes: cacheLimit }, true);
                if (!prepared.ok) return new Response(null, { status: 502 });
                leased = prepared.data.cache_entry;
                const headers = {};
                for (const header of ['Range', 'If-Range']) if (incoming.headers.has(header)) headers[header] = incoming.headers.get(header);
                const response = await net.fetch(`${base}/files/${name}?preview=1`, { headers, credentials: 'omit' });
                const clean = new Headers({ 'Access-Control-Allow-Origin': '*' });
                for (const header of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
                    if (response.headers.has(header)) clean.set(header, response.headers.get(header));
                }
                if (!response.body) { release(); return new Response(null, { status: response.status, headers: clean }); }
                const reader = response.body.getReader();
                const body = new ReadableStream({
                    async pull(controller) {
                        try {
                            const part = await reader.read();
                            if (part.done) { release(); controller.close(); }
                            else controller.enqueue(part.value);
                        } catch (error) { release(); controller.error(error); }
                    },
                    async cancel(reason) { release(); await reader.cancel(reason); },
                });
                return new Response(body, { status: response.status, headers: clean });
            } catch (error) {
                release();
                console.warn('[MusicStation] Audio stream failed', error);
                return new Response(null, { status: 502 });
            }
        });
    }

    function stop() {
        stopping = true;
        if (stopPromise) return stopPromise;
        if (!child || child.exitCode !== null) return Promise.resolve();
        stopPromise = new Promise(resolve => {
            const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
            child.kill('SIGTERM');
        });
        return stopPromise;
    }
    const audioFiles = {
        async list() { return (await call('cache-list', {})).entries; },
        async remove(name) { await call('cache-remove', { name }); },
        async clear() { await call('cache-clear', {}); pinnedCacheEntry = null; },
        getPinnedNames() { return [...new Set([...(pinnedCacheEntry ? [pinnedCacheEntry] : []), ...streamPins.keys()])]; },
        isPreparing() { return mediaRequests > 0; },
    };
    return { start, request, registerProtocol, stop, audioFiles };
}

module.exports = { createMusicStationBridge, validateRequest, STATION_PRIVILEGED_SCHEME };
