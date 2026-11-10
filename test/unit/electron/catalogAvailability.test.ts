import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// Browsing preflight must hide unusable cards without audio downloads or permanent blacklists.
const require = createRequire(import.meta.url);
const { createAvailableCatalog } = require('../../../electron/musicstation/catalogAvailability.cjs');
const list = { source: 'migu', kind: 'playlists' };
const card = (id: string) => ({ source: 'migu', kind: 'playlist', id });
const track = (id: string, extra = {}) => ({ id, ...extra });

describe('public catalog availability preflight', () => {
    it('hides unreadable, empty and entirely restricted collections, preserving order', async () => {
        const read = vi.fn(async (operation, params) => {
            if (operation === 'catalog-list') return { collections: ['bad', 'free', 'empty', 'paid', 'later'].map(card) };
            if (params.id === 'bad') throw Error('check privacy error');
            if (params.id === 'empty') return { songs: [], total: 0 };
            if (params.id === 'paid' || params.id === 'later') return { songs: [track('1', { playable: false })], total: params.id === 'later' ? 60 : 1 };
            return { songs: [track('2'), track('3', { downloadable: false })], total: 2 };
        });
        const request = createAvailableCatalog(read);
        expect(await request('catalog-list', list)).toMatchObject({ collections: [card('free'), card('later')], partial: true });
        const page = await request('catalog-tracks', { source: 'migu', kind: 'playlist', id: 'free', offset: 0, limit: 30 });
        expect(page.songs).toEqual([track('2')]);
        expect(page.total).toBe(2);
        expect(read).toHaveBeenCalledTimes(6); // The inspected first page is reused on click.
        expect(read.mock.calls.every(([op]) => op === 'catalog-list' || op === 'catalog-tracks')).toBe(true);
    });
    it('keeps upstream pagination when filtering a full page with no total', async () => {
        const request = createAvailableCatalog(async () => ({ songs: Array.from({ length: 30 }, (_, n) => track(String(n), { playable: false })) }));
        const page = await request('catalog-tracks', { source: 'migu', kind: 'playlist', id: '1', offset: 0, limit: 30 });
        expect(page).toMatchObject({ songs: [], hasMore: true });
    });
    it('retries transient failures after 30 seconds rather than blacklisting the card', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
        try {
            let down = true;
            const read = vi.fn(async (operation) => {
                if (operation === 'catalog-list') return { collections: [card('1')] };
                if (down) throw Error('timeout');
                return { songs: [track('free')], total: 1 };
            });
            const request = createAvailableCatalog(read);
            expect((await request('catalog-list', list)).collections).toEqual([]);
            down = false;
            clock.mockReturnValue(31001);
            expect((await request('catalog-list', list)).collections).toEqual([card('1')]);
            expect(read).toHaveBeenCalledTimes(4);
        } finally { clock.mockRestore(); }
    });
    it('limits simultaneous metadata reads and shares in-flight list reads', async () => {
        let active = 0;
        let peak = 0;
        const read = vi.fn(async (operation) => {
            if (operation === 'catalog-list') return { collections: Array.from({ length: 12 }, (_, n) => card(String(n))) };
            active += 1; peak = Math.max(peak, active);
            await Promise.resolve();
            active -= 1;
            return { songs: [track('free')], total: 1 };
        });
        const request = createAvailableCatalog(read);
        const [a, b] = await Promise.all([request('catalog-list', list), request('catalog-list', list)]);
        expect(a).toBe(b);
        expect(a.collections).toHaveLength(12);
        expect(peak).toBeLessThanOrEqual(3);
        expect(read).toHaveBeenCalledTimes(13);
    });
});
