const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

// The music station keeps its own user data separate from stock Folia.
const isolatedProfile = app.commandLine.hasSwitch('user-data-dir');
const dataRoot = isolatedProfile
    ? path.join(app.getPath('userData'), 'musicstation')
    : path.join(app.getPath('music'), '音乐站');
for (const directory of ['设置', '日志', '临时文件', '音频缓存', '封面', '歌词', '下载', '后台数据']) {
    fs.mkdirSync(path.join(dataRoot, directory), { recursive: true });
}
if (!isolatedProfile) {
    app.setPath('userData', path.join(dataRoot, '设置'));
    app.setPath('sessionData', path.join(dataRoot, '设置'));
    app.setPath('logs', path.join(dataRoot, '日志'));
    app.setPath('temp', path.join(dataRoot, '临时文件'));
}
module.exports = { dataRoot };
