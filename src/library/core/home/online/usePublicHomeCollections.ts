import { useEffect, useState } from 'react';
import type { HomeViewTab } from '../../../../types';
import type { ProviderCollection, PublicCatalogKind } from '../../../../types/onlineMusic';
import { omni } from '../../../../services/onlineMusic/omni';

// Anonymous browse data has its own lifecycle; it never writes an account's library snapshot.
export function usePublicHomeCollections(providerId: string, tab: HomeViewTab, enabled: boolean) {
    const kind: PublicCatalogKind | null = tab === 'playlist' ? 'playlists' : tab === 'radio' ? 'recommendations' : tab === 'albums' ? 'albums' : null;
    const key = `${providerId}:${kind}`;
    const [state, setState] = useState<{ key: string; items: ProviderCollection[]; loading: boolean; failed: boolean; partial: boolean }>({ key: '', items: [], loading: false, failed: false, partial: false });
    useEffect(() => {
        if (!enabled || !kind) return;
        let current = true;
        setState({ key, items: [], loading: true, failed: false, partial: false });
        void omni.getPublicCollections(kind, { limit: 200, offset: 0 }).then(page => {
            if (current) setState({ key, items: page.items, loading: false, failed: false, partial: page.partial === true });
        }).catch(error => {
            if (!current) return;
            console.warn('[LibraryHome] Public catalog failed', error);
            setState({ key, items: [], loading: false, failed: true, partial: false });
        });
        return () => { current = false; };
    }, [enabled, key, kind, providerId]);
    return enabled && kind && state.key === key ? state : { items: [], loading: enabled && Boolean(kind), failed: false, partial: false };
}
