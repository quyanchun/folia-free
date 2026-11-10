// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useAccountReads } from '../../../src/hooks/useAccountReads';

// Check startup settlement and disposal without touching real cloud accounts.
const fake = vi.hoisted(() => ({ read: vi.fn(), select: vi.fn() }));
vi.mock('../../../src/i18n/config', () => ({ default: { t: (key: string) => key } }));
vi.mock('../../../src/stores/useAppViewStore', () => ({ useAppViewStore: (select: (state: unknown) => unknown) => select({ view: 'player' }) }));
vi.mock('../../../src/stores/useCollectionNavigationStore', () => ({ useCollectionNavigationStore: (select: (state: unknown) => unknown) => select({ snapshot: null }) }));
vi.mock('../../../src/stores/usePlaybackStore', () => ({ usePlaybackStore: {
    getState: () => ({ currentSong: null, playQueue: [] }), subscribe: () => () => {},
} }));
vi.mock('../../../src/services/onlineMusic/omni', () => ({ omni: {
    getActiveProviderSummary: () => ({ providerId: 'original' }),
    getProviderSummaries: () => [{ providerId: 'original', requiresAccount: true }, { providerId: 'second', requiresAccount: true }],
    readAccount: fake.read, selectGuestDefaultProvider: fake.select, songsInPlay: vi.fn(), accountMoment: vi.fn(),
} }));
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
    await act(async () => { roots.forEach(root => root.unmount()); });
    roots.length = 0;
    fake.read.mockReset(); fake.select.mockReset();
});
const mount = async () => {
    const root = createRoot(document.createElement('div'));
    roots.push(root);
    const App = () => { useAccountReads(); return null; };
    await act(async () => { root.render(createElement(App)); });
    return root;
};

it('waits for all startup reads, including failures, before resolving the original selection', async () => {
    let done!: () => void;
    fake.read.mockRejectedValueOnce(new Error('Cloud source offline')).mockImplementationOnce(() => new Promise<void>(resolve => { done = resolve; }));
    await mount();
    expect(fake.select).not.toHaveBeenCalled();
    await act(async () => { done(); });
    expect(fake.select).toHaveBeenCalledExactlyOnceWith('original');
});
it('does not change selection after the startup hook is disposed', async () => {
    let done!: () => void;
    fake.read.mockResolvedValueOnce('nobody').mockImplementationOnce(() => new Promise<void>(resolve => { done = resolve; }));
    const root = await mount();
    await act(async () => { root.unmount(); });
    roots.length = 0;
    await act(async () => { done(); });
    expect(fake.select).not.toHaveBeenCalled();
});
