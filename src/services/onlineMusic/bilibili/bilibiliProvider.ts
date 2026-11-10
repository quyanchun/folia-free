import { createStationProvider } from '../stationBridge/stationProvider';

// Bilibili is audio search, with no matching music chart catalog.
export const bilibiliProvider = createStationProvider('bilibili', 'B站音频', '#d56e99', false);
