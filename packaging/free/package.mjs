import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Repackage only the pinned upstream native runtime, always replacing its complete app sources.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const asar = require('@electron/asar');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'packaging/free/upstream.json')));
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const platform = process.platform;
const arch = process.arch;
const asset = manifest.assets[`${platform}-${arch}`];
if (!asset) throw new Error('Unsupported native release target');
const build = path.join(root, '.release-build');
const cache = path.join(root, '.release-cache');
const release = path.join(root, 'release');
for (const dir of [build, cache, release]) fs.mkdirSync(dir, { recursive: true });
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const archive = path.join(cache, asset.name);
if (!fs.existsSync(archive)) {
    const local = process.env.FOLIA_UPSTREAM_ARCHIVE;
    if (local) fs.copyFileSync(local, archive);
    else run(platform === 'win32' ? 'curl.exe' : 'curl', ['--fail', '--location', '--retry', '3', '--output', archive,
        `https://github.com/${manifest.repository}/releases/download/${manifest.tag}/${asset.name}`]);
}
if (digest(archive) !== asset.sha256) throw new Error('Upstream runtime checksum mismatch');
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { cwd: root,
    env: { ...process.env, ELECTRON: 'true', ELECTRON_DEV: 'false', APP_VERSION_LABEL: 'Folia Free', APP_RELEASE_CHANNEL: 'internal' } });
const extracted = path.join(build, 'upstream');
const staged = path.join(build, 'asar-source');
const app = path.join(build, platform === 'darwin' ? 'Folia Free.app' : 'Folia Free-win32-x64');
for (const dir of [extracted, staged, app]) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(extracted, { recursive: true });
const sevenZip = platform === 'win32' ? 'C:\\Program Files\\7-Zip\\7z.exe' : null;
function findFile(dir, predicate) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isFile() && predicate(entry.name)) return file;
        if (entry.isDirectory()) { const found = findFile(file, predicate); if (found) return found; }
    }
}
let original;
if (platform === 'darwin') {
    run('ditto', ['-x', '-k', archive, extracted]);
    original = path.join(extracted, 'Folia.app');
} else {
    run(sevenZip, ['x', '-y', `-o${extracted}`, archive]);
    const payload = findFile(extracted, name => /^app-64\.7z$/.test(name));
    if (!payload) throw new Error('Upstream Windows installer has no x64 application payload');
    original = path.join(build, 'windows-runtime');
    fs.rmSync(original, { recursive: true, force: true });
    run(sevenZip, ['x', '-y', `-o${original}`, payload]);
}
const resourcesRelative = platform === 'darwin' ? 'Contents/Resources' : 'resources';
const originalAsar = path.join(original, resourcesRelative, 'app.asar');
const originalMetadata = JSON.parse(asar.extractFile(originalAsar, 'package.json').toString());
if (originalMetadata.version !== manifest.tag.slice(1)) throw new Error('Upstream runtime version mismatch');
for (const file of asar.listPackage(originalAsar).map(file => file.slice(1))) {
    const stat = asar.statFile(originalAsar, file, false);
    const target = path.resolve(staged, file);
    if (path.relative(staged, target).startsWith('..')) throw new Error('Unsafe ASAR path');
    if (stat.files) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (stat.link) {
        const destination = path.resolve(staged, stat.link);
        if (path.relative(staged, destination).startsWith('..')) throw new Error('Unsafe ASAR link');
        fs.symlinkSync(path.relative(path.dirname(target), destination), target); continue;
    }
    if (stat.unpacked && !fs.existsSync(originalAsar + '.unpacked/' + file)) {
        const foreign = platform === 'darwin' ? /prebuilds\/(?:linux-|win32-)/ : /prebuilds\/(?:linux-|darwin-)/;
        if (foreign.test(file)) continue;
        throw new Error(`Missing upstream native file: ${file}`);
    }
    fs.writeFileSync(target, asar.extractFile(originalAsar, file));
    if (stat.executable) fs.chmodSync(target, 0o755);
}
for (const dir of ['dist', 'electron', 'shared']) {
    fs.rmSync(path.join(staged, dir), { recursive: true, force: true });
    fs.cpSync(path.join(root, dir), path.join(staged, dir), { recursive: true });
}
fs.writeFileSync(path.join(staged, 'package.json'), JSON.stringify({ ...originalMetadata,
    name: metadata.name, productName: metadata.productName, version: metadata.version,
    repository: metadata.repository, homepage: metadata.homepage, build: metadata.build, foliaReleaseChannel: 'internal' }, null, 2));
fs.cpSync(original, app, { recursive: true, verbatimSymlinks: true });
const resources = path.join(app, resourcesRelative);
const outputAsar = path.join(resources, 'app.asar');
fs.rmSync(outputAsar + '.unpacked', { recursive: true, force: true });
await asar.createPackageWithOptions(staged, outputAsar, {
    unpackDir: 'node_modules/{@koromix/koffi-*,@lox-audioserver/node-librespot}',
});
const service = path.join(build, 'backend/music-station-service');
if (!fs.existsSync(path.join(service, platform === 'win32' ? 'music-station-service.exe' : 'music-station-service'))) throw new Error('Build the native backend first');
fs.cpSync(service, path.join(resources, 'music-station-service'), { recursive: true, verbatimSymlinks: true });
for (const name of ['LICENSE', 'NOTICE.md', 'THIRD_PARTY.md']) fs.copyFileSync(path.join(root, name), path.join(resources, name));
fs.copyFileSync(path.join(root, 'backend/core/vendor/LICENSE'), path.join(resources, 'music-dl-LICENSE.txt'));
fs.writeFileSync(path.join(resources, 'app-update.yml'), 'provider: github\nowner: quyanchun\nrepo: folia-free\n');
const integrity = crypto.createHash('sha256').update(asar.getRawHeader(outputAsar).headerString).digest('hex');
let artifact;
if (platform === 'darwin') {
    const plist = path.join(app, 'Contents/Info.plist');
    for (const [key, value] of Object.entries({ CFBundleIdentifier: 'io.github.quyanchun.foliafree', CFBundleDisplayName: 'Folia Free',
        CFBundleShortVersionString: metadata.version, CFBundleVersion: metadata.version })) {
        run('plutil', ['-replace', key, '-string', value, plist]);
    }
    run('plutil', ['-replace', 'ElectronAsarIntegrity', '-json', JSON.stringify({ 'Resources/app.asar': { algorithm: 'SHA256', hash: integrity } }), plist]);
    run('codesign', ['--force', '--deep', '--sign', '-', app]);
    run('codesign', ['--verify', '--deep', '--strict', app]);
    artifact = path.join(release, `Folia-Free-${metadata.version}-macOS-${arch}.zip`);
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, artifact]);
} else {
    const executable = path.join(app, 'Folia Free.exe');
    fs.renameSync(path.join(app, 'Folia.exe'), executable);
    const { NtExecutable, NtExecutableResource, Resource } = require('resedit');
    const pe = NtExecutable.from(fs.readFileSync(executable), { ignoreCert: true });
    const resource = NtExecutableResource.from(pe);
    resource.entries = resource.entries.filter(entry => entry.type !== 'INTEGRITY');
    const versions = Resource.VersionInfo.fromEntries(resource.entries);
    for (const version of versions) {
        version.setFileVersion(metadata.version); version.setProductVersion(metadata.version);
        for (const language of version.getAllLanguagesForStringValues()) version.setStringValues(language, {
            ProductName: 'Folia Free', FileDescription: 'Folia Free', InternalName: 'Folia Free', OriginalFilename: 'Folia Free.exe',
        });
        version.outputToResourceEntries(resource.entries);
    }
    resource.outputResource(pe); fs.writeFileSync(executable, Buffer.from(pe.generate()));
    await require('app-builder-lib/out/electron/electronWin.js').addWinAsarIntegrity(executable, { 'resources/app.asar': { algorithm: 'SHA256', hash: integrity } });
    // The original updater feed must never point this fork back to Folia-major.
    run(process.execPath, ['node_modules/electron-builder/cli.js', '--win', 'nsis', 'zip', '--x64', '--prepackaged', app, '--publish', 'never', '--config', 'packaging/free/builder.cjs'],
        { cwd: root, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
    artifact = path.join(release, `Folia-Free-${metadata.version}-Windows-x64-Setup.exe`);
}
fs.writeFileSync(path.join(build, 'package-result.json'), JSON.stringify({ app, artifact, platform, arch, version: metadata.version, upstream: manifest.commit, asarHeaderSHA256: integrity }, null, 2));
console.info('[FoliaFree] Packaged', artifact);
