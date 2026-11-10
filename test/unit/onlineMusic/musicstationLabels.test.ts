import { expect, it } from 'vitest';
import i18n from '../../../src/i18n/config';
import { omni } from '../../../src/services/onlineMusic/omni';

// The public catalogue name follows runtime language changes in normal Omni consumers.
it('translates the built-in provider label after switching languages', async () => {
    const previous = i18n.language;
    try {
        await i18n.changeLanguage('en');
        expect(omni.getProviderLabel('musicstation')).toBe('Built-in sources');
        await i18n.changeLanguage('zh-CN');
        expect(omni.getProviderLabel('musicstation')).toBe('内置音源');
    } finally { await i18n.changeLanguage(previous); }
});
