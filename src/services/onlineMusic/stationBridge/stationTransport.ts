import { OnlineProviderError } from '../../../types/onlineMusic';

// The preload is the only route from providers to the bundled local service.
export type StationSource = 'netease' | 'qq' | 'kugou' | 'kuwo' | 'migu' | 'bilibili';
export type StationProviderId = StationSource | 'musicstation';
export type StationOperation = 'search' | 'chart' | 'media' | 'details' | 'song' | 'catalog-list' | 'catalog-tracks';
export type StationBridgeResult = { ok: true; data: unknown } | { ok: false; error: string };
export interface StationSong {
    id: string | number;
    stationKey: string;
    source: string;
    title: string;
    singer: string;
    album?: string;
    duration?: string;
    duration_seconds?: number;
    playable?: boolean;
    downloadable?: boolean;
}
export interface StationSongPage { songs: StationSong[]; total?: number; hasMore?: boolean; failed?: string[] }

export const isFreeStationSong = (song: StationSong) => song.playable !== false && song.downloadable !== false;

export const getStationAvailability = () => typeof window !== 'undefined'
    && typeof window.electron?.musicStationRequest === 'function'
    ? { configured: true } as const
    : { configured: false, reason: 'runtime-unavailable' } as const;

export async function stationRequest<T>(providerId: StationProviderId, operation: StationOperation,
    params: Record<string, unknown>): Promise<T> {
    if (!getStationAvailability().configured) {
        throw new OnlineProviderError('unavailable', 'Music station needs the desktop app', providerId);
    }
    const reply = await window.electron!.musicStationRequest(operation, params);
    if (!reply.ok) throw new OnlineProviderError('unavailable', reply.error, providerId);
    return reply.data as T;
}
