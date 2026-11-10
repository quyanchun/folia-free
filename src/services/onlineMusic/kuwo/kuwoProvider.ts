import { createStationProvider } from '../stationBridge/stationProvider';

// The existing anonymous Kuwo adapter supplies this desktop-only provider.
export const kuwoProvider = createStationProvider('kuwo', '酷我', '#d89c36', true);
