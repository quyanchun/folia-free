import { createStationProvider } from '../stationBridge/stationProvider';
import { createStationCatalog } from './musicstationCatalog';
import type { StationSource } from '../stationBridge/stationTransport';
import i18n from '../../../i18n/config';

// The five public music sources form one account-free search and chart catalogue.
const memberships: { source: StationSource; albums: boolean }[] = [
    { source: 'netease', albums: false }, { source: 'qq', albums: true }, { source: 'kugou', albums: true }, { source: 'kuwo', albums: true }, { source: 'migu', albums: false },
];
const sources = memberships.map(entry => entry.source);
const albumSources = memberships.filter(entry => entry.albums).map(entry => entry.source);
const provider = createStationProvider('musicstation', 'Built-in sources', '#b18b52', true, sources, normalize => {
    const publicCatalog = createStationCatalog('musicstation', sources, albumSources, normalize);
    return { ...publicCatalog.catalog, getPublicCollections: publicCatalog.getPublicCollections };
});
export const musicstationProvider = {
    ...provider,
    get displayName() { return i18n.t('musicStation.musicstation'); },
    get shortName() { return i18n.t('musicStation.musicstation'); },
    defaultForGuests: true,
};
