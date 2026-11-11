import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// Browsing rows must be backed by real audio: metadata flags alone let paid
// Kugou tracks through, and the player then fails with an unknown error.
const require = createRequire(import.meta.url);
const { createAvailableCatalog } = require('../../../electron/musicstation/catalogAvailability.cjs');
const list = { source: 'kugou', kind: 'playlists' };
const card = (id: string) => ({ source: 'kugou', kind: 'playlist', id });
const track = (id: string, extra = {}) => ({ id, stationKey: `key-${id}`, ...extra });
const tracksParams = (id: string, offset = 0, limit = 30) => ({ source: 'kugou', kind: 'playlist', id, offset, limit });
const probeFrom = (states: Record<string, string>) => vi.fn(async (keys: string[]) => ({
    results: Object.fromEntries(keys.map(key => [key, states[key] ?? 'unavailable'])),
}));

describe('catalog audio verification', () => {
    it('hides collections without playable audio and drops confirmed-unplayable tracks', async () => {
        const read = vi.fn(async (operation: string, params: any) => {
            if (operation === 'catalog-list') return { collections: ['broken', 'mixed', 'empty', 'paid', 'later'].map(card) };
            if (params.id === 'broken') throw Error('read failed');
            if (params.id === 'empty') return { songs: [], total: 0 };
            if (params.id === 'paid') return { songs: [track('p1'), track('p2')], total: 2 };
            if (params.id === 'later') return params.offset === 0
                ? { songs: [track('l1')], total: 20 }
                : { songs: [track('l2')], total: 20 };
            return { songs: [track('m1'), track('m2'), track('m3')], total: 3 };
        });
        const probe = probeFrom({ 'key-m2': 'playable', 'key-l2': 'playable' });
        const request = createAvailableCatalog(read, probe);
        const page = await request('catalog-list', list);
        expect(page.collections).toEqual([card('mixed'), card('later')]);
        expect(page.partial).toBe(true); // one collection could not be read
        const tracks = await request('catalog-tracks', tracksParams('mixed'));
        expect(tracks.songs).toEqual([track('m2')]);
        expect(tracks.total).toBe(3);
        expect(tracks.hasMore).toBe(false);
        expect(probe).toHaveBeenCalled();
    });

    it('keeps upstream pagination when most rows are filtered out', async () => {
        const read = vi.fn(async () => ({ songs: Array.from({ length: 30 }, (_, n) => track(String(n))), total: 60 }));
        const states = Object.fromEntries(Array.from({ length: 30 }, (_, n) => [`key-${n}`, n === 3 ? 'playable' : 'unavailable']));
        const request = createAvailableCatalog(read, probeFrom(states));
        const page = await request('catalog-tracks', tracksParams('1'));
        expect(page.songs).toEqual([track('3')]);
        expect(page.total).toBe(60);
        expect(page.hasMore).toBe(true);
    });

    it('hides transient rows and rechecks them after 30 seconds', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
        try {
            let state = 'unknown';
            const read = vi.fn(async () => ({ songs: [track('g')], total: 1 }));
            const probe = vi.fn(async (keys: string[]) => ({
                results: Object.fromEntries(keys.map(key => [key, state])),
            }));
            const request = createAvailableCatalog(read, probe);
            const first = await request('catalog-tracks', tracksParams('1'));
            expect(first.songs).toEqual([]); // unconfirmed audio must not be offered for playback
            expect(first.partial).toBe(true);
            state = 'playable';
            clock.mockReturnValue(31001);
            const second = await request('catalog-tracks', tracksParams('1'));
            expect(second.songs).toEqual([track('g')]);
            expect(second.partial).toBe(false);
            expect(probe).toHaveBeenCalledTimes(2);
        } finally { clock.mockRestore(); }
    });

    it('limits simultaneous reads and shares in-flight list requests', async () => {
        let active = 0;
        let peak = 0;
        const read = vi.fn(async (operation: string) => {
            if (operation === 'catalog-list') return { collections: Array.from({ length: 12 }, (_, n) => card(String(n))) };
            active += 1; peak = Math.max(peak, active);
            await Promise.resolve();
            active -= 1;
            return { songs: [track('g')], total: 1 };
        });
        const request = createAvailableCatalog(read, probeFrom({ 'key-g': 'playable' }));
        const [a, b] = await Promise.all([request('catalog-list', list), request('catalog-list', list)]);
        expect(a).toBe(b);
        expect(a.collections).toHaveLength(12);
        expect(peak).toBeLessThanOrEqual(3);
        expect(read).toHaveBeenCalledTimes(13);
    });

    it('verifies chart and search rows with the same audio probe', async () => {
        const read = vi.fn(async (operation: string) => operation === 'search'
            ? { songs: [track('a'), track('b')], failed: [] }
            : { songs: [track('c'), track('d')], total: 30 });
        const request = createAvailableCatalog(read, probeFrom({ 'key-a': 'playable', 'key-d': 'playable' }));
        expect((await request('search', { source: 'kugou', query: 'x' })).songs).toEqual([track('a')]);
        const chart = await request('chart', { source: 'kugou', chart: 'hot', page: 1 });
        expect(chart.songs).toEqual([track('d')]);
        expect(chart.total).toBe(30);
    });

    it('hides rows and collections when the probe is unavailable', async () => {
        const read = async (operation: string) => operation === 'catalog-list'
            ? { collections: [card('1')] } : { songs: [track('g')], total: 1 };
        const request = createAvailableCatalog(read, async () => { throw Error('backend offline'); });
        const page = await request('catalog-list', list);
        expect(page.collections).toEqual([]);
        expect(page.partial).toBe(true);
    });
});
