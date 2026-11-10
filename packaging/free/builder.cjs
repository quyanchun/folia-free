// Wrap the already verified Windows directory in an installer and a portable ZIP.
module.exports = {
    appId: 'io.github.quyanchun.foliafree', productName: 'Folia Free',
    directories: { output: 'release' }, publish: null,
    beforePack: null, afterPack: null,
    win: { target: ['nsis', 'zip'], signAndEditExecutable: false,
        artifactName: 'Folia-Free-${version}-Windows-${arch}.${ext}' },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
        artifactName: 'Folia-Free-${version}-Windows-${arch}-Setup.${ext}', include: null },
};
