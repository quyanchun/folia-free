import i18n from 'i18next';
import type { UnifiedSong } from '../../../types';
import type { OnlineCatalogProvider, ProviderCollection, PublicCatalogKind } from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';
import { stationRequest } from '../stationBridge/stationTransport';
import type { StationProviderId, StationSource, StationSongPage } from '../stationBridge/stationTransport';

// Public collection identities stay separate from charts and from signed-in platform collections.
interface StationCollection {
    source: StationSource;
    kind: 'playlist' | 'album';
    id: string;
    name: string;
    cover?: string;
    count?: number;
    description?: string;
    limited?: boolean;
}

export function createStationCatalog(providerId: StationProviderId, sources: readonly StationSource[], albumSources: readonly StationSource[], normalizeSong: (raw: unknown) => UnifiedSong) {
    const collections = new Map<string, ProviderCollection>();
    const normalize = (raw: StationCollection): ProviderCollection => {
        if (!sources.includes(raw.source) || !['album', 'playlist'].includes(raw.kind) || !/^[A-Za-z0-9_]{1,90}$/.test(raw.id)) {
            throw new OnlineProviderError('invalid-response', 'Invalid public collection', providerId);
        }
        const sourceName = i18n.t(`musicStation.${raw.source}`);
        const result: ProviderCollection = {
            providerId, id: `public:${raw.source}:${raw.kind}:${raw.id}`, type: raw.kind, name: raw.name,
            coverUrl: raw.cover || `folia-station://cover/${raw.source}-hot.svg`,
            trackCount: Number.isFinite(Number(raw.count)) && raw.count !== null ? Number(raw.count) : undefined,
            creator: { id: raw.source, nickname: sourceName },
            description: [sourceName, raw.description, raw.limited ? i18n.t('publicCatalog.publicPlaylistLimited') : ''].filter(Boolean).join(' · '),
        };
        if (collections.size >= 1000) collections.delete(collections.keys().next().value!);
        collections.set(String(result.id), result);
        return result;
    };
    const parse = (value: string) => {
        const [prefix, source, kind, id, extra] = value.split(':');
        if (prefix !== 'public' || extra || !sources.includes(source as StationSource) || !['playlist', 'album'].includes(kind)
            || !/^[A-Za-z0-9_]{1,90}$/.test(id || '') || (kind === 'album' && !albumSources.includes(source as StationSource))) {
            throw new OnlineProviderError('unsupported', 'Unknown public collection', providerId);
        }
        return { source, kind, id };
    };
    const detail = async (id: string | number, given?: ProviderCollection) => {
        const ref = parse(String(id));
        return collections.get(String(id)) || given || normalize({ ...ref, source: ref.source as StationSource,
            kind: ref.kind as 'playlist' | 'album', name: ref.id });
    };
    const tracks = async (id: string | number, limit = 50, offset = 0) => {
        const ref = parse(String(id));
        const songs: StationSongPage['songs'] = [];
        let cursor = 0;
        let end = false;
        const desired = Math.max(1, Math.min(limit, 200));
        while (!end && songs.length < offset + desired) {
            const page = await stationRequest<StationSongPage>(providerId, 'catalog-tracks', { ...ref, offset: cursor, limit: 30 });
            songs.push(...page.songs);
            cursor += 30;
            end = page.total !== undefined ? cursor >= page.total : page.songs.length < 30;
            if (cursor >= 10020) end = true;
        }
        const items = songs.slice(offset, offset + desired).map(normalizeSong);
        const nextOffset = offset + items.length;
        return { items, total: end ? songs.length : undefined, nextOffset, hasMore: !end || nextOffset < songs.length };
    };
    const catalog: OnlineCatalogProvider = { getPlaylistDetail: detail, getPlaylistTracks: tracks, getAlbumDetail: detail, getAlbumTracks: tracks };
    return {
        catalog,
        async getPublicCollections(kind: PublicCatalogKind, limit: number, offset: number) {
            const selected = sources.filter(source => kind !== 'albums' || albumSources.includes(source));
            const replies = await Promise.allSettled(selected.map(async source => {
                const result = await stationRequest<{ collections: StationCollection[] }>(providerId, 'catalog-list', { source, kind });
                if (!result.collections.length) throw new OnlineProviderError('unavailable', 'Empty public source', providerId);
                return result.collections.map(normalize);
            }));
            const rows = replies.flatMap(reply => reply.status === 'fulfilled' ? [reply.value] : []);
            if (!rows.length) throw new OnlineProviderError('unavailable', i18n.t('publicCatalog.catalogUnavailable'), providerId);
            // Round-robin keeps all five sources represented even in a short first page.
            const items: ProviderCollection[] = [];
            for (let index = 0; index < Math.max(...rows.map(row => row.length)); index += 1) {
                for (const row of rows) if (row[index]) items.push(row[index]);
            }
            const failures = replies.filter(reply => reply.status === 'rejected');
            console.info('[MusicStation] Public catalog', { kind, sources: rows.length, failed: failures.length, count: items.length });
            const page = items.slice(offset, offset + limit);
            return { items: page, total: items.length, nextOffset: offset + page.length,
                hasMore: offset + page.length < items.length, partial: failures.length > 0 };
        },
    };
}
