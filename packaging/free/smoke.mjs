import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { _electron } from '@playwright/test';

// Exercise the final packaged runtime with an isolated, disposable profile and no cloud accounts.
const root = process.cwd();
const built = JSON.parse(fs.readFileSync(path.join(root, '.release-build/package-result.json')));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-free-smoke-'));
const executable = built.platform === 'darwin' ? path.join(built.app, 'Contents/MacOS/Folia') : path.join(built.app, 'Folia 音乐站.exe');
const runtime = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`], timeout: 60000 });
try {
    const identity = await runtime.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), userData: app.getPath('userData') }));
    assert.equal(identity.packaged, true);
    assert.equal(identity.version, built.version);
    assert.equal(fs.realpathSync(identity.userData), fs.realpathSync(profile));
    const page = await runtime.firstWindow({ timeout: 60000 });
    await page.waitForFunction(() => typeof window.electron?.musicStationRequest === 'function', { timeout: 60000 });
    const reply = await page.evaluate(() => window.electron.musicStationRequest('song', { key: '0'.repeat(64) }));
    assert.equal(reply.ok, true, 'The self-contained backend must start without system Python');
    assert.equal(reply.data.song, null);
    const resources = built.platform === 'darwin' ? path.join(built.app, 'Contents/Resources') : path.join(built.app, 'resources');
    const tools = path.join(resources, 'music-station-service/_internal/tools');
    assert.equal(fs.existsSync(path.join(tools, built.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')), true);
    assert.equal(fs.existsSync(path.join(tools, built.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')), true);
    for (const file of ['PYTHON-LICENSE.txt', 'FFMPEG-GPL-3.0.txt', 'ffmpeg-license.txt', 'ffmpeg-build.txt']) {
        assert.equal(fs.existsSync(path.join(resources, 'music-station-service/_internal/licenses', file)), true, `Missing ${file}`);
    }
    console.info('[MusicStation] Packaged smoke test passed', { platform: built.platform, arch: built.arch, version: built.version });
} finally {
    await runtime.close();
    fs.rmSync(profile, { recursive: true, force: true });
}
