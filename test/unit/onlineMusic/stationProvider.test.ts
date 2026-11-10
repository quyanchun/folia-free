import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createStationCatalog } from '../../../src/services/onlineMusic/musicstation/musicstationCatalog';
import { createStationProvider } from '../../../src/services/onlineMusic/stationBridge/stationProvider';
import { stationRequest } from '../../../src/services/onlineMusic/stationBridge/stationTransport';
import type { StationSong } from '../../../src/services/onlineMusic/stationBridge/stationTransport';
import { createRequire } from 'node:module';

// Exercise source identity, paging and the local IPC boundary without platform traffic.
vi.mock('../../../src/services/onlineMusic/stationBridge/stationTransport', () => ({
    getStationAvailability: () => ({ configured: true }), stationRequest: vi.fn(),
}));
vi.mock('../../../src/services/audioCache', () => ({ cacheLimitBytes: () => 1024 }));
const require = createRequire(import.meta.url);
const { validateRequest } = require('../../../electron/musicstation/bridge.cjs');
const request = vi.mocked(stationRequest);
const provider = createStationProvider('kuwo', 'Kuwo', '#abc', true);
const song = (number: number): StationSong => ({ id: number, source: 'kuwo', stationKey: number.toString(16).padStart(64, '0'),
    title: 'Song ' + number, singer: 'Artist', album: 'Album', duration: '03:20' });

beforeEach(() => { request.mockReset(); });

describe('music station provider', () => {
    it('searches all five public sources and retains distinct source-aware media identities', async () => {
        const sources = ['netease', 'qq', 'kugou', 'kuwo', 'migu'] as const;
        const builtIn = createStationProvider('musicstation', 'Built-in', '#abc', true, sources);
        request.mockImplementation(async (_id, _operation, params) => ({ songs: [
            { ...song(sources.indexOf(params.source as typeof sources[number]) + 1), source: params.source },
        ] }));
        const first = await builtIn.search!.searchSongs('test', 3, 0);
        const second = await builtIn.search!.searchSongs('test', 3, 3);
        expect([...first.items, ...second.items].map(item => item.sourceRef)).toEqual(sources.map((source, index) => ({
            kind: 'online', providerId: 'musicstation', mediaId: song(index + 1).stationKey,
            providerData: { source, restricted: false },
        })));
        expect(request).toHaveBeenCalledTimes(5);
        expect(second.hasMore).toBe(false);
    });
    it('keeps partial results if one source fails, and rejects when every source fails', async () => {
        const builtIn = createStationProvider('musicstation', 'Built-in', '#abc', true, ['kuwo', 'migu']);
        request.mockRejectedValueOnce(new Error('temporarily down')).mockResolvedValueOnce({ songs: [{ ...song(2), source: 'migu' }] });
        expect((await builtIn.search!.searchSongs('test', 30, 0)).items).toHaveLength(1);
        request.mockRejectedValue(new Error('all down'));
        await expect(builtIn.search!.searchSongs('other', 30, 0)).rejects.toThrow('all down');
    });
    it('distinguishes upstream failure envelopes from an actual empty search', async () => {
        const builtIn = createStationProvider('musicstation', 'Built-in', '#abc', true, ['kuwo', 'migu']);
        request.mockResolvedValue({ songs: [], failed: ['source'] });
        await expect(builtIn.search!.searchSongs('test', 30, 0)).rejects.toThrow();
        request.mockResolvedValueOnce({ songs: [], failed: ['kuwo'] }).mockResolvedValueOnce({ songs: [{ ...song(2), source: 'migu' }], failed: [] });
        expect((await builtIn.search!.searchSongs('partial', 30, 0)).items).toHaveLength(1);
        request.mockResolvedValue({ songs: [], failed: [] });
        expect((await builtIn.search!.searchSongs('empty', 30, 0)).items).toEqual([]);
    });
    it('exposes fifteen real charts and routes a card to its own source', async () => {
        const builtIn = createStationProvider('musicstation', 'Built-in', '#abc', true, ['netease', 'qq', 'kugou', 'kuwo', 'migu']);
        const feed = await builtIn.explore!.getFeed();
        expect(feed.sections).toHaveLength(5);
        expect(feed.sections.flatMap(section => section.items)).toHaveLength(15);
        request.mockResolvedValue({ songs: [{ ...song(1), source: 'qq' }], total: 1 });
        expect((await builtIn.catalog!.getPlaylistTracks!('qq:hot', 30, 0)).items).toHaveLength(1);
        expect(request).toHaveBeenLastCalledWith('musicstation', 'chart', { source: 'qq', chart: 'hot', page: 1 });
        await expect(builtIn.catalog!.getPlaylistTracks!('bilibili:hot', 30, 0)).rejects.toThrow('Unknown chart');
    });
    it('preserves provider identity and converts duration once', () => {
        const item = provider.normalizeSong(song(1));
        expect(item.sourceRef).toMatchObject({ kind: 'online', providerId: 'kuwo', mediaId: song(1).stationKey });
        expect(item.durationMs).toBe(200000);
        expect(provider.normalizeSong(item)).toBe(item);
    });
    it('rejects raw songs owned by another provider', () => {
        expect(() => provider.normalizeSong({ ...song(1), source: 'migu' })).toThrow();
    });
    it('keeps payment restrictions unknown rather than declaring a song taken down', () => {
        const item = provider.normalizeSong({ ...song(1), downloadable: false });
        expect(provider.playback!.getAvailability!(item)).toEqual({ state: 'unknown', reason: 'restricted' });
    });
    it('marks preview audio and rejects cross-provider playback', async () => {
        request.mockResolvedValueOnce({ url: 'folia-station://audio/key', preview_only: true });
        const item = provider.normalizeSong(song(1));
        expect(await provider.playback!.getAudioSource(item, 'standard')).toMatchObject({ preview: true, quality: 'standard' });
        const other = createStationProvider('migu', 'Migu', '#abc', true).normalizeSong({ ...song(1), source: 'migu' });
        await expect(provider.playback!.getAudioSource(other, 'standard')).rejects.toThrow();
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('pages across 30-row upstream pages without dropping an offset', async () => {
        request.mockImplementation(async (_id, _operation, params) => ({
            total: 100, songs: Array.from({ length: 30 }, (_, index) => song((Number(params.page) - 1) * 30 + index)),
        }));
        const page = await provider.catalog!.getPlaylistTracks!('hot', 35, 25);
        expect(page.items.map(item => item.name)).toEqual(Array.from({ length: 35 }, (_, index) => 'Song ' + (25 + index)));
        expect(page.nextOffset).toBe(60);
        expect(page.hasMore).toBe(true);
    });
    it('does not invent a music chart capability for Bilibili', () => {
        const video = createStationProvider('bilibili', 'Bilibili', '#abc', false);
        expect(video.capabilities.playlists).toBe(false);
        expect(video.catalog).toBeUndefined();
        expect(video.capabilities.auth).toBe(false);
    });
    it('continues beyond filtered rows and interprets offsets as valid songs', async () => {
        request.mockImplementation(async (_id, _operation, params) => {
            const page = Number(params.page);
            return { total: 90, songs: Array.from({ length: 30 }, (_, index) => song((page - 1) * 30 + index))
                .filter(item => item.id !== 4) };
        });
        const first = await provider.catalog!.getPlaylistTracks!('hot', 35, 0);
        expect(first.items).toHaveLength(35);
        expect(first.items.at(-1)!.name).toBe('Song 35');
        const next = await provider.catalog!.getPlaylistTracks!('hot', 35, first.nextOffset!);
        expect(next.items[0].name).toBe('Song 36');
        expect(next.items.at(-1)!.name).toBe('Song 70');
        expect(next.hasMore).toBe(true);
    });
    it('restricts IPC operations and never accepts a URL or file path from the page', () => {
        expect(validateRequest('search', { source: 'kuwo', query: 'test' })).toEqual({ source: 'kuwo', query: 'test' });
        expect(() => validateRequest('fetch', { url: 'https://example.com' })).toThrow();
        expect(() => validateRequest('media', { key: '../private' })).toThrow();
        expect(() => validateRequest('chart', { source: 'bilibili', chart: 'hot', page: 1 })).toThrow();
        expect(() => validateRequest('chart', { source: 'migu', chart: 'hot', page: -1 })).toThrow();
    });
});

describe('anonymous built-in public catalogs', () => {
    const sources = ['netease', 'qq', 'kugou', 'kuwo', 'migu'] as const;
    const builtIn = () => createStationProvider('musicstation', 'Built-in', '#abc', true, sources, normalize => {
        const result = createStationCatalog('musicstation', sources, ['qq', 'kugou', 'kuwo'], normalize);
        return { ...result.catalog, getPublicCollections: result.getPublicCollections };
    });
    it('enables only public catalog capabilities, without an account library or mutations', () => {
        const p = builtIn();
        expect(p.capabilities).toMatchObject({ publicCatalog: true, albums: true, recommendations: true, userLibrary: false, auth: false, mutations: false });
        expect(provider.capabilities.publicCatalog).toBe(false);
    });
    it('interleaves all five sources and keeps their collection identities distinct', async () => {
        request.mockImplementation(async (_provider, operation, params) => {
            expect(operation).toBe('catalog-list');
            return { collections: [1, 2].map(n => ({ source: params.source, kind: 'playlist', id: String(n), name: 'Playlist', cover: 'https://example.com/a.jpg' })) } as never;
        });
        const page = await builtIn().catalog!.getPublicCollections!('playlists', 5, 0);
        expect(page.items.map(c => c.id)).toEqual(sources.map(s => `public:${s}:playlist:1`));
        expect(new Set(page.items.map(c => c.id)).size).toBe(5);
        expect(page.hasMore).toBe(true);
    });
    it('keeps partial results and limits albums to the three verified sources', async () => {
        request.mockImplementation(async (_provider, _op, params) => {
            if (params.source === 'qq') throw Error('upstream offline');
            return { collections: [{ source: params.source, kind: 'album', id: '123', name: 'Album' }] } as never;
        });
        const page = await builtIn().catalog!.getPublicCollections!('albums', 50, 0);
        expect(request.mock.calls.map(c => c[2].source)).toEqual(['qq', 'kugou', 'kuwo']);
        expect(page.items).toHaveLength(2);
        expect(page.partial).toBe(true);
    });
    it('reports all-source failure, rather than an empty successful catalog', async () => {
        request.mockRejectedValue(Error('offline'));
        await expect(builtIn().catalog!.getPublicCollections!('playlists', 30, 0)).rejects.toThrow();
    });
    it('opens albums through catalog tracks, keeping stable song keys and page offsets', async () => {
        request.mockImplementation(async (_provider, operation, params) => {
            expect(operation).toBe('catalog-tracks');
            const start = Number(params.offset);
            return { songs: Array.from({ length: start === 0 ? 30 : 5 }, (_, n) => ({ ...song(start + n + 1), source: 'qq' })), total: 35 } as never;
        });
        const page = await builtIn().catalog!.getAlbumTracks!('public:qq:album:ABC123', 10, 25);
        expect(request.mock.calls.map(c => c[2].offset)).toEqual([0, 30]);
        expect(page.items).toHaveLength(10);
        expect(page.nextOffset).toBe(35);
        expect(page.hasMore).toBe(false);
        expect(page.items[0].sourceRef).toMatchObject({ kind: 'online', providerId: 'musicstation' });
    });
    it('continues past an empty filtered page when the upstream total includes later songs', async () => {
        request.mockImplementation(async (_provider, _operation, params) => ({
            songs: params.offset === 0 ? [] : [{ ...song(31), source: 'migu' }], total: 60,
        }) as never);
        const page = await builtIn().catalog!.getPlaylistTracks!('public:migu:playlist:123', 30, 0);
        expect(request.mock.calls.map(c => c[2].offset)).toEqual([0, 30]);
        expect(page.items).toHaveLength(1);
        expect(page.hasMore).toBe(false);
    });
    it('ends an empty page without an upstream total', async () => {
        request.mockResolvedValue({ songs: [] });
        const page = await builtIn().catalog!.getPlaylistTracks!('public:qq:playlist:123', 30, 0);
        expect(request).toHaveBeenCalledTimes(1);
        expect(page.items).toEqual([]);
        expect(page.hasMore).toBe(false);
    });
    it('rejects arbitrary URLs, disabled album platforms, and cross-provider identifiers', async () => {
        const catalog = builtIn().catalog!;
        for (const id of ['public:netease:album:12', 'public:bilibili:playlist:123', 'public:qq:playlist:https://bad', 'public:qq:playlist:123:extra']) {
            await expect(catalog.getPlaylistTracks!(id, 30, 0)).rejects.toThrow();
        }
        expect(request).not.toHaveBeenCalled();
    });
    it('retains the original chart path alongside public playlists', async () => {
        request.mockResolvedValue({ songs: [song(1)], total: 1 });
        const p = builtIn();
        await p.catalog!.getPlaylistTracks!('kuwo:hot', 30, 0);
        expect(request.mock.calls[0][1]).toBe('chart');
    });
    it('bounds IPC parameters and never accepts renderer-supplied song imports', () => {
        expect(validateRequest('catalog-list', { source: 'migu', kind: 'recommendations', cookie: 'ignored' })).toEqual({ source: 'migu', kind: 'recommendations' });
        expect(() => validateRequest('catalog-import', { songs: [] })).toThrow();
        expect(() => validateRequest('catalog-list', { source: 'netease', kind: 'albums' })).toThrow();
        expect(() => validateRequest('catalog-tracks', { source: 'qq', kind: 'playlist', id: '123', offset: 1, limit: 30 })).toThrow();
        expect(() => validateRequest('catalog-tracks', { source: 'qq', kind: 'playlist', id: '../secret', offset: 0, limit: 30 })).toThrow();
    });
});
