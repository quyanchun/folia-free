import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

// Platform collection payloads differ from chart/search payloads; guard their playback identities.
const require = createRequire(import.meta.url);
const { qqSong } = require('../../../electron/qq/publicStation.cjs');
const { kugouSong } = require('../../../electron/kugou/publicStation.cjs');
const { createPublicCatalog } = require('../../../electron/musicstation/publicCatalog.cjs');

describe('anonymous catalog song mapping', () => {
    it('preserves legacy QQ mid, display metadata and paid playback limits', () => {
        expect(qqSong({ songmid: '0039MnYb0qxYhV', songname: '晴天', singer: [{ name: '周杰伦' }], albumname: '叶惠美', interval: 269, pay: { payplay: 1 } }))
            .toMatchObject({ source: 'qq', id: '0039MnYb0qxYhV', title: '晴天', singer: '周杰伦', duration_seconds: 269, playable: false });
    });
    it('reads Kugou album metadata from base/audio_info rather than playlist field names', () => {
        expect(kugouSong({ base: { audio_name: 'Reno My Color', author_name: '宋雨琦' }, audio_info: { hash_128: 'A'.repeat(32), duration: 181000 } }))
            .toMatchObject({ source: 'kugou', id: 'A'.repeat(32), hash: 'A'.repeat(32), title: 'Reno My Color', singer: '宋雨琦', duration_seconds: 181 });
    });
    it('preserves Kugou playlist titles containing the title separator', () => {
        expect(kugouSong({ hash: 'B'.repeat(32), name: 'Artist - Title - Live', timelen: 123000, singerinfo: [{ name: 'Artist' }] }))
            .toMatchObject({ title: 'Title - Live', singer: 'Artist', duration_seconds: 123 });
    });
    it('sends QQ/Kugou searches and charts to the service, not playlist adapters', async () => {
        const operations: string[] = [];
        const key = 'a'.repeat(64);
        const call = async (operation: string) => {
            operations.push(operation);
            if (operation === 'availability') return { results: { [key]: 'playable' } };
            return { songs: [{ source: 'qq', id: '0039MnYb0qxYhV', stationKey: key }] };
        };
        const catalog = createPublicCatalog(call);
        expect((await catalog('search', { source: 'qq', query: '初音' })).songs).toHaveLength(1);
        expect((await catalog('chart', { source: 'kugou', chart: 'hot', page: 1 })).songs).toHaveLength(1);
        expect(operations).toContain('search');
        expect(operations).toContain('chart');
        expect(operations).not.toContain('catalog-import');
    });
});
