import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

// Missing optional foreign builds must be distinguished from missing native dependencies.
const require = createRequire(import.meta.url);
const { isForeignPrebuild } = require('../../../packaging/free/runtimeFiles.cjs');
describe('native release prebuild filtering', () => {
    it('skips ARM metadata in an Intel Mac runtime', () => {
        expect(isForeignPrebuild('node_modules/native/prebuilds/darwin-arm64/addon.node', 'darwin', 'x64')).toBe(true);
        expect(isForeignPrebuild('node_modules/native/prebuilds/darwin-x64/addon.node', 'darwin', 'x64')).toBe(false);
    });
    it('handles Windows separators and toolchain suffixes', () => {
        expect(isForeignPrebuild('node_modules\\native\\prebuilds\\darwin-arm64\\addon.node', 'win32', 'x64')).toBe(true);
        expect(isForeignPrebuild('node_modules\\native\\prebuilds\\win32-x64-msvc\\addon.node', 'win32', 'x64')).toBe(false);
    });
    it('never excuses an unrelated missing file', () => {
        expect(isForeignPrebuild('node_modules/required/addon.node', 'win32', 'x64')).toBe(false);
    });
});
