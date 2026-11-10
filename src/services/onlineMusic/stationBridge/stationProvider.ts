import i18n from 'i18next';
import type { SongResult, UnifiedSong } from '../../../types';
import type { OnlineMusicProvider, ProviderCollection, OnlineCatalogProvider } from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';
import { createProviderSongMetadata } from '../../../utils/songMetadata';
import { parseLRC } from '../../../utils/lrcParser';
import { cacheLimitBytes } from '../../audioCache';
import { getStationAvailability, stationRequest } from './stationTransport';
import type { StationSource, StationProviderId, StationSong, StationSongPage } from './stationTransport';

// The desktop adapters consume the same local contract; raw platform rules stay in Python.
export function createStationProvider(id: StationProviderId, displayName: string, color: string,
    hasCharts: boolean, sources: readonly StationSource[] = [id as StationSource], buildPublicCatalog?: (normalize: (raw: unknown) => UnifiedSong) => OnlineCatalogProvider): OnlineMusicProvider {
    const hasPublicCatalog = Boolean(buildPublicCatalog);
    const multiple = sources.length > 1;
    let searchCache: { query: string; at: number; songs: UnifiedSong[] } | undefined;
    const chartRef = (value: string) => {
        const [source, chart] = multiple ? value.split(':') : [sources[0], value];
        if (!sources.includes(source as StationSource) || !['hot', 'new', 'rising'].includes(chart)) {
            throw new OnlineProviderError('unsupported', 'Unknown chart', id);
        }
        return { source: source as StationSource, chart };
    };
    const normalizeSong = (raw: unknown): UnifiedSong => {
        if (!raw || typeof raw !== 'object') throw new OnlineProviderError('invalid-response', 'Missing song', id);
        const existingRef = (raw as Partial<UnifiedSong>).sourceRef;
        if (existingRef?.kind === 'online' && existingRef.providerId === id) return raw as UnifiedSong;
        const song = raw as StationSong;
        if (!sources.includes(song.source as StationSource) || !/^[a-f0-9]{64}$/.test(song.stationKey)) {
            throw new OnlineProviderError('invalid-response', 'Invalid music station identity', id);
        }
        const seconds = song.duration_seconds ?? String(song.duration || '').split(':')
            .reduce((total, part) => total * 60 + Number(part || 0), 0);
        return {
            id: song.stationKey, name: song.title, artists: [{ id: '', name: song.singer }],
            album: { id: '', name: song.album || '' },
            durationMs: Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : 0,
            sourceRef: { kind: 'online', providerId: id, mediaId: song.stationKey,
                providerData: { source: song.source, restricted: song.playable === false || song.downloadable === false } },
        };
    };
    const keyOf = (song: SongResult): string => {
        const ref = song.sourceRef;
        if (ref?.kind !== 'online' || ref.providerId !== id || !/^[a-f0-9]{64}$/.test(ref.mediaId)) {
            throw new OnlineProviderError('unsupported', 'Song belongs to another provider', id);
        }
        return ref.mediaId;
    };
    const collection = (source: StationSource, chart: string): ProviderCollection => ({
        providerId: id, id: multiple ? `${source}:${chart}` : chart, type: 'playlist',
        name: `${multiple ? i18n.t(`musicStation.${source}`) + ' · ' : ''}${i18n.t(`musicStation.${chart}`)}`,
        coverUrl: `folia-station://cover/${source}-${chart}.svg`,
    });
    const publicCatalog = buildPublicCatalog?.(normalizeSong);
    const provider: OnlineMusicProvider = {
        id, displayName, shortName: displayName, shortNameKey: `musicStation.${id}`,
        mark: { letter: displayName.slice(0, 1), color }, getAvailability: getStationAvailability,
        capabilities: {
            search: true, playback: true, lyrics: true, wordByWordLyrics: false, auth: false,
            userLibrary: false, playlists: hasCharts, albums: hasPublicCatalog, artists: false, publicCatalog: hasPublicCatalog,
            recommendations: hasPublicCatalog, mutations: false, explore: hasCharts,
        },
        normalizeSong, songMetadata: { getSongMetadata: createProviderSongMetadata },
        search: { async searchSongs(query, limit, offset) {
            if (!query.trim()) return { items: [], total: 0, hasMore: false, nextOffset: offset };
            if (offset > 0 && searchCache?.query === query && Date.now() - searchCache.at < 120000) {
                const items = searchCache.songs.slice(offset, offset + limit);
                return { items, total: searchCache.songs.length, hasMore: offset + items.length < searchCache.songs.length, nextOffset: offset + items.length };
            }
            const replies = await Promise.allSettled(sources.map(async source => {
                const result = await stationRequest<StationSongPage>(id, 'search', { source, query });
                if (result.failed?.length && !result.songs.length) {
                    throw new OnlineProviderError('unavailable', i18n.t('musicStation.searchUnavailable'), id);
                }
                return result;
            }));
            const successful = replies.filter(reply => reply.status === 'fulfilled');
            if (!successful.length) throw (replies[0] as PromiseRejectedResult).reason;
            // Preserve source identities and show results even when one public source is down.
            const songs = successful.flatMap(reply => reply.value.songs).map(normalizeSong);
            searchCache = { query, at: Date.now(), songs };
            const items = songs.slice(offset, offset + limit);
            return { items, total: songs.length, hasMore: offset + items.length < songs.length, nextOffset: offset + items.length };
        } },
        playback: {
            audioQualityLevels: ['standard'],
            async getSongDetail(key) {
                const result = await stationRequest<{ song: StationSong | null }>(id, 'song', { key: String(key) });
                return result.song ? normalizeSong(result.song) : null;
            },
            async getAudioSource(song) {
                const result = await stationRequest<{ url: string; preview_only?: boolean }>(id, 'media', { key: keyOf(song), limitBytes: cacheLimitBytes() });
                return { url: result.url, fetchedAt: Date.now(), quality: 'standard', preview: result.preview_only === true };
            },
            getAvailability(song) {
                const ref = song.sourceRef;
                return ref?.kind === 'online' && ref.providerData?.restricted === true
                    ? { state: 'unknown', reason: 'restricted' } : { state: 'unknown' };
            },
        },
        lyrics: { async getLyrics(song) {
            const result = await stationRequest<{ rawLrc?: string; translation?: string }>(id, 'details', { key: keyOf(song) });
            return { lyrics: result.rawLrc ? parseLRC(result.rawLrc, result.translation || '') : null,
                mainText: result.rawLrc || null, isPureMusic: false };
        } },
    };
    if (hasCharts) {
        provider.explore = { async getFeed() {
            return { sections: sources.map(source => ({ id: source, title: multiple ? i18n.t(`musicStation.${source}`) : i18n.t('musicStation.charts'),
                items: ['hot', 'new', 'rising'].map(chart => ({ kind: 'collection' as const, collection: collection(source, chart) })) })) };
        } };
        provider.catalog = {
            async getPlaylistDetail(value) {
                try { const { source, chart } = chartRef(String(value)); return collection(source, chart); }
                catch { return null; }
            },
            async getPlaylistTracks(value, limit, offset) {
                const { source, chart } = chartRef(String(value));
                const desired = Math.max(1, Math.min(limit, 200));
                const all: StationSong[] = [];
                let page = 1;
                let end = false;
                // Offset counts playable records, not upstream slots that may be filtered out.
                while (all.length < offset + desired && !end) {
                    const result = await stationRequest<StationSongPage>(id, 'chart', { source, chart, page });
                    all.push(...result.songs);
                    end = result.total !== undefined ? page * 30 >= result.total : result.songs.length < 30;
                    if (page >= 100) end = true;
                    page += 1;
                }
                const items = all.slice(offset, offset + desired).map(normalizeSong);
                const nextOffset = offset + items.length;
                return { items, total: end ? all.length : undefined, nextOffset, hasMore: !end || nextOffset < all.length };
            },
        };
    }
    if (publicCatalog) {
        const charts = provider.catalog!;
        provider.catalog = {
            ...publicCatalog,
            getPlaylistDetail: (value, given) => String(value).startsWith('public:')
                ? publicCatalog.getPlaylistDetail!(value, given) : charts.getPlaylistDetail!(value, given),
            getPlaylistTracks: (value, limit, offset, given) => String(value).startsWith('public:')
                ? publicCatalog.getPlaylistTracks!(value, limit, offset, given) : charts.getPlaylistTracks!(value, limit, offset, given),
        };
    }
    return provider;
}
