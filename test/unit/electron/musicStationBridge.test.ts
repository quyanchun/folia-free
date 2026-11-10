import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise service recovery and shared-cache integration without launching Electron.
const require = createRequire(import.meta.url);
const { createMusicStationBridge } = require('../../../electron/musicstation/bridge.cjs');
const child = () => Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null,
    kill: vi.fn(),
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('music station lifecycle', () => {
    it('starts a fresh service after a ready service exits', async () => {
        const first = child();
        const second = child();
        const spawnProcess = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
        const bridge = createMusicStationBridge({ app: { isPackaged: false }, dataRoot: '/tmp/fixture', spawnProcess });
        const initial = bridge.start();
        first.stdout.emit('data', Buffer.from('{"ready":true,"port":12345}\n'));
        await initial;
        first.emit('exit', 1);
        const restart = bridge.start();
        second.stdout.emit('data', Buffer.from('{"ready":true,"port":12346}\n'));
        await restart;
        expect(spawnProcess).toHaveBeenCalledTimes(2);
        second.emit('exit', 0);
    });
    it('pins the prepared file before invoking shared pruning and keeps internal cache operations off renderer IPC', async () => {
        const running = child();
        const onCacheWrite = vi.fn(async () => {
            expect(bridge.audioFiles.getPinnedNames()).toEqual(['tmpfixture']);
        });
        const bridge = createMusicStationBridge({ app: { isPackaged: false }, dataRoot: '/tmp/fixture',
            spawnProcess: () => running, onCacheWrite });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ url: '/files/key', cache_entry: 'tmpfixture' }))));
        const initial = bridge.start();
        running.stdout.emit('data', Buffer.from('{"ready":true,"port":12345}\n'));
        await initial;
        const result = await bridge.request('media', { key: 'a'.repeat(64), limitBytes: 1024 });
        expect(result).toMatchObject({ ok: true, data: { url: 'folia-station://audio/' + 'a'.repeat(64) } });
        expect(onCacheWrite).toHaveBeenCalledWith(1024);
        expect(await bridge.request('cache-clear', {})).toMatchObject({ ok: false });
        running.emit('exit', 0);
    });
    it('recreates evicted prefetched URLs and retains active streams when another song is prefetched', async () => {
        const running = child();
        let handle!: (request: Request) => Promise<Response>;
        const protocol = { handle: (_scheme: string, callback: typeof handle) => { handle = callback; } };
        const fetchMedia = vi.fn(async (_url: string, options: { body: string }) => {
            const { key } = JSON.parse(options.body);
            return new Response(JSON.stringify({ cache_entry: 'tmp' + key[0] }));
        });
        vi.stubGlobal('fetch', fetchMedia);
        const net = { fetch: vi.fn(async () => new Response('audio', { status: 206,
            headers: { 'Content-Range': 'bytes 0-4/5' } })) };
        const bridge = createMusicStationBridge({ app: { isPackaged: false }, dataRoot: '/tmp/fixture',
            spawnProcess: () => running, protocol, net });
        const initial = bridge.start();
        running.stdout.emit('data', Buffer.from('{"ready":true,"port":12345}\n'));
        await initial;
        bridge.registerProtocol();
        const audioRequest = () => new Request('folia-station://audio/' + 'a'.repeat(64), { headers: { Range: 'bytes=0-4' } });
        const first = await handle(audioRequest());
        await bridge.request('media', { key: 'b'.repeat(64) });
        expect(bridge.audioFiles.getPinnedNames()).toContain('tmpa');
        expect(bridge.audioFiles.getPinnedNames()).toContain('tmpb');
        expect(first.status).toBe(206);
        expect(await first.text()).toBe('audio');
        expect(bridge.audioFiles.getPinnedNames()).not.toContain('tmpa');
        const restored = await handle(audioRequest());
        expect(await restored.text()).toBe('audio');
        expect(fetchMedia).toHaveBeenCalledTimes(3);
        expect(net.fetch).toHaveBeenCalledWith('http://127.0.0.1:12345/files/' + 'a'.repeat(64) + '?preview=1',
            expect.objectContaining({ headers: { Range: 'bytes=0-4' } }));
        running.emit('exit', 0);
    });
});
