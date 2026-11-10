// Wrap the already verified Windows directory in an installer and a portable ZIP.
module.exports = {
    appId: 'io.github.quyanchun.musicstation', productName: 'Folia 音乐站',
    directories: { output: 'release' }, publish: null,
    beforePack: null, afterPack: null,
    win: { target: ['nsis', 'zip'], signAndEditExecutable: false,
        artifactName: 'Folia-Music-Station-${version}-Windows-${arch}.${ext}' },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
        artifactName: 'Folia-Music-Station-${version}-Windows-${arch}-Setup.${ext}', include: null },
};
