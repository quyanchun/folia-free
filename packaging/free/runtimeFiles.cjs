// Upstream ASAR headers retain entries for optional native builds of other targets.
function isForeignPrebuild(file, platform, arch) {
    const target = file.replaceAll('\\', '/').match(/\/prebuilds\/([^/]+)\//)?.[1];
    const current = `${platform}-${arch}`;
    return Boolean(target && target !== current && !target.startsWith(current + '-'));
}
module.exports = { isForeignPrebuild };
