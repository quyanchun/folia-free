const $ = selector => document.querySelector(selector);
const appURL = path => new URL(path.replace(/^\//, ''), document.baseURI).href;
const names = {netease: '网易云', kugou: '酷狗', kuwo: '酷我', qq: 'QQ音乐', bilibili: 'B站', migu: '咪咕'};
const downloadIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v10m-4-4 4 4 4-4M3 13v4h14v-4"/></svg>';
const spinnerIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M17 10a7 7 0 1 1-7-7"/></svg>';
const playIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 9 6-9 6Z"/></svg>';
const pauseIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4v12M13 4v12"/></svg>';
const queueIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h11M3 10h7M3 15h7M15 9v8m-4-4h8"/></svg>';
const audio = $('#player-audio');
const preparedFiles = new Map();
const queue = [];
let activeTrack = null;
let playRequest = 0;
let preparing = false;
let source = 'all';
let searching = false;
let lastQuery = '';
let view = 'hot';
let lastChartView = 'hot';
let resultTotal = 0;
let resultFilter = 'all';
let chartSource = 'netease';
let chartPage = 0;
let chartTotal = 0;
let hasMore = false;
let chartGeneration = 0;
let loadingMore = false;
let loadFailed = false;
const selectedSongs = new Map();
const previewOnlyTracks = new Set();
const downloadJobs = [];
const downloadBatches = [];
let downloadSnapshot = '';
let downloadsPaused = false;
let downloadRevision = 0;
let downloadPoll;

const playbackStorageKey = 'music-dl:playback:v1';
let restoringPlayback = false;
let lastProgressSave = 0;

// The page is served from disk on every request, but the enabled sources are
// loaded into the server process at startup. After a code update, an old
// process can show a new button while rejecting its requests, so ask the
// running backend which sources it actually supports before enabling them.
let backendSources = null;
let backendChartSources = null;

function sourceControls() {
  return [...document.querySelectorAll('[data-platform], #source-select option')];
}

function unsupportedControl(control) {
  if (control.dataset.platform) {
    return backendChartSources !== null && !backendChartSources.has(control.dataset.platform);
  }
  if (control.matches('#source-select option')) {
    return backendSources !== null && control.value !== 'all' && !backendSources.has(control.value);
  }
  return false;
}

function applyBackendSources() {
  sourceControls().forEach(control => {
    const unsupported = unsupportedControl(control);
    control.disabled = unsupported;
    control.title = unsupported ? '后端服务需要重启后才能使用这个来源' : '';
  });
  const select = $('#source-select');
  select.disabled = false;
  if (select.selectedOptions[0]?.disabled) {
    select.value = 'all';
    source = 'all';
  }
}

async function syncBackendSources() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(appURL('/api/health'), {signal: controller.signal});
    if (!response.ok) return;
    const health = await response.json();
    backendSources = new Set(health.sources || []);
    backendChartSources = new Set(health.chart_sources || []);
  } catch (_) {
    // Older servers simply lack these fields; leave every button enabled.
  } finally {
    clearTimeout(timer);
    applyBackendSources();
    if (sourceControls().some(unsupportedControl)) {
      notice('页面已更新，但服务仍是旧进程；请完全退出后重新启动服务', true);
    }
  }
}

function savedSong(song) {
  return Object.fromEntries(['source', 'id', 'title', 'singer', 'album', 'duration', 'hash']
    .filter(key => song[key] != null).map(key => [key, song[key]]));
}

function savePlayback() {
  if (restoringPlayback) return;
  try {
    if (!activeTrack && !queue.length) return localStorage.removeItem(playbackStorageKey);
    const position = activeTrack ? (audio.readyState ? audio.currentTime : activeTrack.resumePosition || 0) : 0;
    localStorage.setItem(playbackStorageKey, JSON.stringify({version: 1,
      current: activeTrack ? savedSong(activeTrack.song) : null,
      position: Number.isFinite(position) ? position : 0, queue: queue.map(savedSong)}));
  } catch {
    playerStatus('播放记录暂未能保存', true);
  }
}

async function restorePlayback() {
  const request = playRequest;
  try {
    const raw = localStorage.getItem(playbackStorageKey);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || !Array.isArray(saved.queue)) return;
    restoringPlayback = true;
    const records = [...(saved.current ? [saved.current] : []), ...saved.queue];
    const restored = [];
    for (let index = 0; index < records.length; index += 30) {
      const result = await api('/api/restore', {songs: records.slice(index, index + 30)});
      restored.push(...result.songs);
    }
    if (request !== playRequest || activeTrack) return;
    const byKey = new Map(restored.map(song => [trackKey(song), song]));
    queue.push(...saved.queue.map(song => byKey.get(trackKey(song))).filter(Boolean));
    const previous = saved.current ? byKey.get(trackKey(saved.current)) : null;
    const current = previous || queue.shift();
    renderQueue();
    if (current) await playTrack(current, {autoplay: false, position: previous ? Math.max(0, Number(saved.position) || 0) : 0});
  } catch {
    notice('上次播放记录暂时未能恢复，请稍后重试', true);
  } finally {
    restoringPlayback = false;
    // A failed restore should keep the original saved record for a later retry.
    if (activeTrack) savePlayback();
  }
}

function trackKey(song) {
  return `${song.source}:${song.hash || song.id}`;
}

function prepareFile(song) {
  const key = trackKey(song);
  if (!preparedFiles.has(key)) {
    preparedFiles.set(key, api('/api/download', {token: song.token}).catch(async error => {
      if (error.status === 400 && error.message.includes('过期')) {
        const restored = await api('/api/restore', {songs: [savedSong(song)]});
        if (restored.songs.length) {
          Object.assign(song, restored.songs[0]);
          return api('/api/download', {token: song.token});
        }
      }
      throw error;
    }).then(file => {
      if (file.preview_only) {
        previewOnlyTracks.add(key);
        selectedSongs.delete(key);
        renderDownloadQueue();
      }
      return file;
    }).catch(error => {
      preparedFiles.delete(key);
      throw error;
    }));
  }
  return preparedFiles.get(key);
}

function quality(file) {
  return `${file.format}${file.bitrate ? ` · ${file.bitrate} kbps` : ''}${file.preview_only ? ' · 试听片段' : ''}`;
}

function playerStatus(message, failed = false) {
  $('#player-status').textContent = message;
  $('#player-status').classList.toggle('failed', failed);
}

function syncPlaybackButtons() {
  document.querySelectorAll('.song').forEach(item => {
    const current = item.dataset.trackKey === activeTrack?.key;
    const button = item.querySelector('.preview-button');
    const playing = current && !audio.paused;
    item.classList.toggle('is-previewing', current);
    button.disabled = item.dataset.unplayable === 'true' || (current && preparing);
    button.classList.toggle('pending', current && preparing);
    button.innerHTML = current && preparing ? spinnerIcon : playing ? pauseIcon : playIcon;
    button.title = playing ? '暂停' : '播放';
    button.setAttribute('aria-label', `${playing ? '暂停' : '播放'} ${item.dataset.trackLabel}`);
    const add = item.querySelector('.queue-add');
    const queued = queue.some(song => trackKey(song) === item.dataset.trackKey);
    add.disabled = item.dataset.unplayable === 'true' || current || queued;
    add.title = current ? '正在播放' : queued ? '已在队列' : '加入队列';
    add.classList.toggle('queued', queued);
    if (current && activeTrack.file?.preview_only) item.querySelector('.download').disabled = true;
  });
}

function renderQueue() {
  $('#queue-count').textContent = queue.length;
  $('#player-next').disabled = !queue.length;
  $('#queue-empty').hidden = !!queue.length;
  $('#queue-clear').disabled = !queue.length;
  $('#queue-list').replaceChildren(...queue.map((song, index) => {
    const item = document.createElement('li');
    const copy = textElement('div', 'queued-copy', '');
    copy.append(textElement('strong', '', song.title), textElement('span', '', song.singer));
    const remove = textElement('button', 'queue-remove', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `从队列移除 ${song.title} · ${song.singer}`);
    remove.addEventListener('click', () => { queue.splice(index, 1); renderQueue(); });
    item.append(copy, remove);
    return item;
  }));
  syncPlaybackButtons();
  savePlayback();
}

function trackError(song, message) {
  document.querySelectorAll('.song').forEach(item => {
    if (item.dataset.trackKey !== trackKey(song)) return;
    const status = item.querySelector('.track-status');
    status.textContent = message;
    status.classList.add('failed');
  });
}

async function playTrack(song, {autoplay = true, position = 0} = {}) {
  const key = trackKey(song);
  const queuedIndex = queue.findIndex(item => trackKey(item) === key);
  if (queuedIndex >= 0) { queue.splice(queuedIndex, 1); renderQueue(); }
  if (activeTrack?.key === key && audio.getAttribute('src') && !audio.error) {
    if (!audio.paused) return audio.pause();
    try { await audio.play(); } catch { playerStatus('点击播放器开始播放'); }
    return;
  }
  const request = ++playRequest;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  activeTrack = {song, key, file: null, resumePosition: position};
  preparing = true;
  $('#player').hidden = false;
  document.body.classList.add('has-player');
  $('#player-title').textContent = song.title;
  $('#player-artist').textContent = `${song.singer} · ${names[song.source]}`;
  audio.setAttribute('aria-label', `正在播放 ${song.title}`);
  playerStatus('正在获取音频…');
  renderQueue();
  try {
    const file = await prepareFile(song);
    if (request !== playRequest) return;
    activeTrack.file = file;
    playerStatus(quality(file));
    audio.onloadedmetadata = () => {
      if (request !== playRequest) return;
      if (position > 0 && Number.isFinite(audio.duration)) audio.currentTime = Math.min(position, Math.max(0, audio.duration - 0.2));
      activeTrack.resumePosition = 0;
      savePlayback();
    };
    audio.src = appURL(file.url) + '?preview=1';
    try {
      if (autoplay) await audio.play();
      else audio.load();
    } catch (error) {
      if (request !== playRequest) return;
      if (error.name === 'NotAllowedError') playerStatus('点击播放器开始播放');
      else throw new Error('暂时无法播放，请试试下一首');
    }
  } catch (error) {
    if (request !== playRequest) return;
    const message = error.message === 'Failed to fetch' ? '连接中断，请重新启动' : error.message;
    playerStatus(message, true);
    trackError(song, message);
  } finally {
    if (request === playRequest) {
      preparing = false;
      syncPlaybackButtons();
    }
  }
}

function enqueue(song) {
  const key = trackKey(song);
  if (activeTrack?.key === key || queue.some(item => trackKey(item) === key)) return;
  if (!activeTrack) { playTrack(song); return; }
  queue.push(song);
  renderQueue();
}

function playNext() {
  if (!queue.length) return;
  const song = queue.shift();
  renderQueue();
  playTrack(song);
}

function selectedSongsInOrder() {
  return [...document.querySelectorAll('#songs > .song:not([hidden]) .row-select:checked:not(:disabled)')]
    .map(check => check.song)
    .filter(song => song && song.playable !== false);
}

async function playSelected() {
  const songs = selectedSongsInOrder();
  if (!songs.length) return notice('请先勾选可播放的歌曲', true);
  const [first, ...rest] = songs;
  // Replace the old pending queue so "播放所选" plays exactly the checked rows,
  // in the order they appear on the page, instead of mixing in earlier picks.
  queue.length = 0;
  const seen = new Set([trackKey(first)]);
  rest.forEach(song => {
    const key = trackKey(song);
    if (seen.has(key)) return;
    seen.add(key);
    queue.push(song);
  });
  renderQueue();
  if (activeTrack?.key === trackKey(first) && audio.getAttribute('src') && !audio.error) {
    // Already on the first song: keep the current audio instead of toggling pause.
    if (audio.paused) {
      try { await audio.play(); } catch { playerStatus('点击播放器开始播放'); }
    }
  } else {
    playTrack(first);
  }
  notice(queue.length ? `正在播放所选第一首，其余 ${queue.length} 首已加入队列` : '已开始播放所选歌曲');
}

function closePlayer() {
  playRequest++;
  activeTrack = null;
  preparing = false;
  queue.length = 0;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  $('#player').hidden = true;
  $('#player-queue').hidden = true;
  $('#queue-toggle').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('has-player');
  renderQueue();
}

['play', 'pause'].forEach(event => audio.addEventListener(event, () => { syncPlaybackButtons(); savePlayback(); }));
audio.addEventListener('timeupdate', () => {
  if (Date.now() - lastProgressSave < 1000) return;
  lastProgressSave = Date.now();
  savePlayback();
});
audio.addEventListener('seeked', savePlayback);
window.addEventListener('pagehide', savePlayback);
document.addEventListener('visibilitychange', () => { if (document.hidden) savePlayback(); });
audio.addEventListener('ended', () => {
  syncPlaybackButtons();
  if (queue.length) playNext();
  else playerStatus('播放结束');
});
audio.addEventListener('error', () => {
  if (!activeTrack || !audio.getAttribute('src')) return;
  preparedFiles.delete(activeTrack.key);
  preparing = false;
  playerStatus('暂时无法播放，请试试下一首', true);
  syncPlaybackButtons();
});
$('#player-next').addEventListener('click', playNext);
$('#player-close').addEventListener('click', closePlayer);
$('#queue-toggle').addEventListener('click', () => {
  const panel = $('#player-queue');
  panel.hidden = !panel.hidden;
  $('#queue-toggle').setAttribute('aria-expanded', String(!panel.hidden));
});
$('#queue-clear').addEventListener('click', () => { queue.length = 0; renderQueue(); });

function updateChartCount() {
  $('#count').textContent = `${$('#songs').children.length} / ${chartTotal} 首`;
  if (!loadFailed) setLoadStatus(hasMore ? 'idle' : 'done');
}

function setLoadStatus(state, message = '') {
  const box = $('#load-status');
  box.hidden = state === 'idle';
  box.classList.toggle('failed', state === 'error');
  box.classList.toggle('loading', state === 'loading');
  $('#load-status-text').textContent = state === 'loading' ? '正在加载更多…'
    : state === 'error' ? `加载失败：${message}`
    : state === 'done' ? `已加载全部 ${chartTotal} 首` : '';
  $('#load-retry').hidden = state !== 'error';
}

async function api(path, payload) {
  const response = await fetch(appURL(path), {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || '连接暂时不可用，请重试');
    error.status = response.status;
    throw error;
  }
  return data;
}

function notice(message = '', error = false) {
  $('#notice').textContent = message;
  $('#notice').hidden = !message;
  $('#notice').classList.toggle('error', error);
}

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function updateSelection() {
  const checks = [...document.querySelectorAll('.song:not([hidden]) .row-select')];
  checks.forEach(check => {
    if (previewOnlyTracks.has(check.dataset.trackKey)) check.disabled = true;
    check.checked = !check.disabled && selectedSongs.has(check.dataset.trackKey);
  });
  const enabled = checks.filter(check => !check.disabled);
  const checked = enabled.filter(check => check.checked).length;
  $('#select-all').disabled = !enabled.length;
  $('#select-all').checked = !!enabled.length && checked === enabled.length;
  $('#select-all').indeterminate = checked > 0 && checked < enabled.length;
  $('#selected-count').textContent = `已选 ${selectedSongs.size} 首`;
  $('#batch-play').disabled = !selectedSongs.size;
  $('#batch-download').disabled = !selectedSongs.size;
}

function requestedSources() {
  return source === 'all'
    ? [...$('#source-select').options].filter(option => option.value !== 'all' && !option.disabled).map(option => option.value)
    : [source];
}

function renderSourceFilter(result) {
  const counts = new Map();
  result.songs.forEach(song => counts.set(song.source, (counts.get(song.source) || 0) + 1));
  const failed = new Set(result.failed || []);
  const makeButton = (value, label, quiet = false) => {
    const button = textElement('button', '', label);
    button.type = 'button';
    button.dataset.filter = value;
    button.setAttribute('aria-pressed', String(value === resultFilter));
    if (quiet) {
      button.classList.add('quiet');
      button.disabled = true;
      button.title = failed.has(value) ? '该来源暂时不可用' : '该来源本次没有匹配结果';
    }
    button.addEventListener('click', () => {
      resultFilter = value;
      selectedSongs.clear();
      applyResultFilter();
    });
    return button;
  };
  const all = makeButton('all', `全部 ${resultTotal}`);
  const items = requestedSources().map(src => {
    const count = counts.get(src) || 0;
    return makeButton(src, `${names[src]} ${failed.has(src) ? '不可用' : count || '无结果'}`, !count);
  });
  const hint = source === 'all' ? [] : [textElement('span', 'hint', '切到「全部」可一次查看所有来源')];
  $('#source-filter').replaceChildren(all, ...items, ...hint);
}

function applyResultFilter() {
  let shown = 0;
  document.querySelectorAll('#songs > li').forEach(item => {
    const visible = resultFilter === 'all' || item.dataset.source === resultFilter;
    item.hidden = !visible;
    if (visible) shown++;
  });
  $('#source-filter').querySelectorAll('button').forEach(button =>
    button.setAttribute('aria-pressed', String(button.dataset.filter === resultFilter)));
  $('#count').textContent = resultFilter === 'all' ? `${resultTotal} 首` : `${shown} / ${resultTotal} 首`;
  updateSelection();
}

function bytes(value) {
  if (!value) return '0 MB';
  return value < 1048576 ? `${Math.round(value / 1024)} KB` : `${(value / 1048576).toFixed(1)} MB`;
}

const activeDownloadStates = ['preparing', 'downloading', 'tagging', 'saving'];

function downloadState(job) {
  const state = {pending: '等待中', preparing: '获取音频中', downloading: '下载中', tagging: '整理歌曲信息',
    saving: '保存中', done: '已就绪', expired: '已过期', failed: job.error || '准备失败'}[job.state];
  if (job.state === 'downloading') {
    const amount = job.total ? `${bytes(job.received)} / ${bytes(job.total)} · ${Math.min(100, Math.floor(job.received / job.total * 100))}%` : bytes(job.received);
    return `${state} · ${amount}${job.speed ? ` · ${bytes(job.speed)}/s` : ''}`;
  }
  if (job.state === 'done') return `${state} · ${bytes(job.size)}${job.metadata_notice ? ' · 部分信息未补全' : ''}`;
  return state;
}

function renderDownloadQueue() {
  const waiting = downloadJobs.filter(job => job.state === 'pending').length;
  const active = downloadJobs.filter(job => activeDownloadStates.includes(job.state)).length;
  const done = downloadJobs.filter(job => job.state === 'done');
  const failed = downloadJobs.filter(job => job.state === 'failed').length;
  $('#downloads-count').textContent = `${done.length}/${downloadJobs.length}`;
  $('#downloads-pause').textContent = downloadsPaused ? '继续' : '暂停';
  $('#downloads-pause').disabled = !waiting && !active;
  $('#downloads-clear').disabled = !downloadBatches.some(batch => ['ready', 'expired'].includes(batch.state));
  $('#downloads-summary').textContent = `已就绪 ${done.length} · 等待 ${waiting} · 失败 ${failed}${active ? ' · 1 首处理中' : ''}${downloadsPaused ? active ? ' · 当前歌曲完成后暂停' : ' · 已暂停' : ''}`;
  $('#downloads-progress').max = Math.max(1, downloadJobs.length);
  $('#downloads-progress').value = done.length;
  $('#downloads-size').textContent = `已就绪 ${bytes(done.reduce((sum, job) => sum + job.size, 0))}`;
  $('#downloads-empty').hidden = !!downloadBatches.length;
  const expanded = new Set([...document.querySelectorAll('.download-batch details[open]')].map(element => element.dataset.batchId));
  $('#download-jobs').replaceChildren(...downloadBatches.map(batch => {
    const item = textElement('li', 'download-batch', '');
    const jobs = batch.ids.map(id => downloadJobs.find(job => job.id === id)).filter(Boolean);
    const count = batch.counts;
    const heading = textElement('div', 'batch-heading', '');
    heading.append(textElement('strong', '', jobs.length === 1 ? jobs[0].song.title : `批量下载 · ${jobs.length} 首`));
    const states = {preparing: downloadsPaused ? '已暂停' : '准备中', packing: '打包中', ready: '可下载', failed: batch.error || '准备失败', expired: '文件已过期'};
    heading.append(textElement('span', batch.state === 'failed' ? 'failed' : '', states[batch.state]));
    item.append(heading, textElement('p', 'batch-status', `就绪 ${count.done}/${count.total}${count.failed ? ` · 失败 ${count.failed}` : ''}`));
    const progress = document.createElement('progress');
    progress.setAttribute('aria-label', '批量任务准备进度');
    progress.max = Math.max(1, count.total);
    progress.value = count.done + count.failed;
    item.append(progress);
    const actions = textElement('div', 'batch-actions', '');
    if (batch.url) {
      const link = textElement('a', 'batch-download', jobs.length === 1 ? '下载歌曲' : `下载 ZIP · ${batch.included} 首`);
      link.href = appURL(batch.url);
      link.setAttribute('download', '');
      actions.append(link);
    }
    if (['failed', 'expired'].includes(batch.state) || batch.state === 'ready' && count.failed) {
      const retry = textElement('button', '', batch.state === 'expired' ? '重新准备' : '重试未完成');
      retry.type = 'button';
      retry.addEventListener('click', () => downloadControl('retry_batch', null, batch.id));
      actions.append(retry);
    }
    item.append(actions);
    const details = document.createElement('details');
    details.dataset.batchId = batch.id;
    details.open = expanded.has(batch.id);
    details.append(textElement('summary', '', `查看 ${jobs.length} 首`));
    const list = document.createElement('ul');
    list.append(...jobs.map(job => {
      const row = document.createElement('li');
      const copy = textElement('div', 'download-copy', '');
      copy.append(textElement('strong', '', job.filename || job.song.title),
        textElement('span', job.state === 'failed' ? 'failed' : '', `${job.song.singer} · ${downloadState(job)}`));
      if (job.state === 'downloading') {
        const meter = document.createElement('progress');
        meter.setAttribute('aria-label', `${job.song.title} 下载进度`);
        if (job.total) { meter.max = job.total; meter.value = job.received; }
        copy.append(meter);
      }
      row.append(copy);
      if (['pending', 'failed'].includes(job.state) && batch.state !== 'packing') {
        const remove = textElement('button', 'download-remove', '×');
        remove.type = 'button';
        remove.setAttribute('aria-label', `移除下载 ${job.song.title}`);
        remove.addEventListener('click', () => downloadControl('remove', job.id));
        row.append(remove);
      }
      return row;
    }));
    details.append(list);
    item.append(details);
    return item;
  }));
  document.querySelectorAll('.song').forEach(item => {
    const key = item.dataset.trackKey;
    const job = downloadJobs.filter(entry => trackKey(entry.song) === key).at(-1);
    const button = item.querySelector('.download');
    const busy = job && ['pending', ...activeDownloadStates].includes(job.state);
    button.disabled = item.dataset.undownloadable === 'true' || !!busy || previewOnlyTracks.has(key);
    button.classList.toggle('pending', !!busy);
    button.innerHTML = `${busy ? spinnerIcon : downloadIcon}<span>${busy ? job.state === 'pending' ? '等待中' : '准备中' : job?.url ? '下载文件' : job?.state === 'failed' ? '重试' : '下载'}</span>`;
    if (job) {
      const status = item.querySelector('.track-status');
      status.textContent = job.state === 'done' ? `${quality(job)} · ${bytes(job.size)}` : downloadState(job);
      status.classList.toggle('failed', job.state === 'failed');
    }
  });
  updateSelection();
}

function applyDownloads(data) {
  const fingerprint = JSON.stringify(data);
  if (fingerprint === downloadSnapshot) return;
  downloadSnapshot = fingerprint;
  downloadJobs.splice(0, downloadJobs.length, ...data.jobs);
  downloadBatches.splice(0, downloadBatches.length, ...data.batches);
  downloadsPaused = data.paused;
  renderDownloadQueue();
}

async function loadDownloads() {
  const revision = ++downloadRevision;
  try {
    const response = await fetch(appURL('/api/downloads'));
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (revision === downloadRevision) applyDownloads(data);
  } catch {
    $('#downloads-summary').textContent = '下载状态连接中断，正在重连…';
  } finally {
    clearTimeout(downloadPoll);
    const busy = downloadJobs.some(job => activeDownloadStates.includes(job.state) || !downloadsPaused && job.state === 'pending') || downloadBatches.some(batch => batch.state === 'packing');
    downloadPoll = setTimeout(loadDownloads, document.hidden ? 4000 : busy ? 700 : 2500);
  }
}

async function downloadControl(action, id, batchId) {
  const revision = ++downloadRevision;
  try {
    const data = await api('/api/downloads/control', {action, id, batch_id: batchId});
    if (revision === downloadRevision && data.jobs) applyDownloads(data);
  } catch (error) { notice(error.message, true); }
}

async function addDownloads(songs) {
  const available = songs.filter(song => song.downloadable !== false && song.playable !== false && !previewOnlyTracks.has(trackKey(song)));
  if (!available.length) return false;
  ++downloadRevision;
  try {
    let data;
    try {
      data = await api('/api/downloads', {tokens: available.map(song => song.token)});
    } catch (error) {
      if (error.status !== 400 || !error.message.includes('过期')) throw error;
      for (let index = 0; index < available.length; index += 30) {
        const batch = available.slice(index, index + 30);
        const restored = await api('/api/restore', {songs: batch.map(savedSong)});
        const byKey = new Map(restored.songs.map(song => [trackKey(song), song]));
        batch.forEach(song => { if (byKey.has(trackKey(song))) Object.assign(song, byKey.get(trackKey(song))); });
      }
      data = await api('/api/downloads', {tokens: available.map(song => song.token)});
    }
    ++downloadRevision;
    applyDownloads(data);
    $('#downloads-panel').hidden = false;
    $('#downloads-toggle').setAttribute('aria-expanded', 'true');
    notice(data.added ? '' : '任务已在下载管理中');
    return true;
  } catch (error) { notice(error.message, true); return false; }
}

$('#select-all').addEventListener('change', event => {
  document.querySelectorAll('.song:not([hidden]) .row-select:not(:disabled)').forEach(check => {
    check.checked = event.target.checked;
    if (check.checked) selectedSongs.set(check.dataset.trackKey, check.song);
    else selectedSongs.delete(check.dataset.trackKey);
  });
  updateSelection();
});
$('#batch-play').addEventListener('click', playSelected);
$('#batch-download').addEventListener('click', async () => {
  $('#batch-download').disabled = true;
  if (await addDownloads([...selectedSongs.values()])) selectedSongs.clear();
  updateSelection();
});
$('#downloads-toggle').addEventListener('click', () => {
  const panel = $('#downloads-panel');
  panel.hidden = !panel.hidden;
  $('#downloads-toggle').setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) loadDownloads();
});
$('#downloads-close').addEventListener('click', () => {
  $('#downloads-panel').hidden = true;
  $('#downloads-toggle').setAttribute('aria-expanded', 'false');
});
$('#downloads-pause').addEventListener('click', () => downloadControl(downloadsPaused ? 'resume' : 'pause'));
$('#downloads-clear').addEventListener('click', () => downloadControl('clear_done'));

function row(song, index) {
  const item = document.createElement('li');
  item.className = 'song';
  item.dataset.trackKey = trackKey(song);
  item.dataset.source = song.source;
  item.dataset.trackLabel = `${song.title} · ${song.singer}`;
  item.dataset.unplayable = String(song.playable === false);
  item.dataset.undownloadable = String(song.downloadable === false || song.playable === false);
  item.classList.toggle('ranked', song.rank != null);
  item.style.animationDelay = `${Math.min(index, 7) * 30}ms`;
  const info = textElement('div', 'track-info', '');
  const select = document.createElement('input');
  select.type = 'checkbox';
  select.className = 'row-select';
  select.dataset.trackKey = trackKey(song);
  select.song = song;
  select.disabled = song.downloadable === false || song.playable === false || previewOnlyTracks.has(trackKey(song));
  select.setAttribute('aria-label', `选择 ${song.title} · ${song.singer}`);
  select.addEventListener('change', () => {
    if (select.checked) selectedSongs.set(trackKey(song), song);
    else selectedSongs.delete(trackKey(song));
    updateSelection();
  });
  info.append(select, textElement('span', 'track-number', String(song.rank || index + 1).padStart(2, '0')));
  const copy = textElement('div', 'track-copy', '');
  copy.append(textElement('h3', 'track-title', song.title), textElement('div', 'track-singer', song.singer || '未知歌手'));
  info.append(copy);
  item.append(info, textElement('span', `song-source ${song.source}`, names[song.source]), textElement('span', 'duration', song.duration.replace(/^0:/, '') || '—'));
  const action = textElement('div', 'song-action', '');
  const buttons = textElement('div', 'track-buttons', '');
  const preview = document.createElement('button');
  preview.className = 'preview-button';
  preview.type = 'button';
  preview.title = '播放';
  preview.setAttribute('aria-label', `播放 ${song.title} · ${song.singer}`);
  preview.innerHTML = playIcon;
  preview.disabled = song.playable === false;
  preview.addEventListener('click', () => playTrack(song));
  const add = document.createElement('button');
  add.className = 'queue-add';
  add.type = 'button';
  add.title = '加入队列';
  add.setAttribute('aria-label', `加入队列 ${song.title} · ${song.singer}`);
  add.innerHTML = queueIcon;
  add.disabled = song.playable === false;
  add.addEventListener('click', () => enqueue(song));
  const button = document.createElement('button');
  button.className = 'download';
  button.type = 'button';
  button.setAttribute('aria-label', `下载 ${song.title} · ${song.singer}`);
  button.innerHTML = `${downloadIcon}<span>下载</span>`;
  button.disabled = song.downloadable === false;
  const status = textElement('span', 'track-status', song.availability || '');
  status.setAttribute('role', 'status');
  button.addEventListener('click', () => {
    const ready = downloadJobs.filter(job => trackKey(job.song) === trackKey(song) && job.url).at(-1);
    if (!ready) return addDownloads([song]);
    const link = document.createElement('a');
    link.href = appURL(ready.url);
    link.setAttribute('download', '');
    document.body.append(link);
    link.click();
    link.remove();
  });
  buttons.append(preview, add, button);
  action.append(buttons, status);
  item.append(action);
  return item;
}

async function loadResults(kind = view) {
  const query = $('#query').value.trim();
  if (searching) return;
  const generation = ++chartGeneration;
  selectedSongs.clear();
  resultFilter = 'all';
  if (kind === 'search' && !query) { lastQuery = ''; kind = 'hot'; }
  view = kind;
  const charts = view !== 'search';
  if (charts) lastChartView = view;
  $('.library').classList.toggle('search-view', !charts);
  $('#search-tools').hidden = charts;
  $('#source-filter').replaceChildren();
  $('#chart-browser').setAttribute('aria-labelledby', charts ? 'platform-' + chartSource : 'results-title');
  document.querySelectorAll('[data-platform]').forEach(button => {
    const active = button.dataset.platform === chartSource;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  $('#tab-hot').textContent = chartSource === 'kugou' ? 'TOP500' : '热歌榜';
  if (!charts) lastQuery = query;
  $('#tab-search').hidden = !lastQuery;
  $('#music-panel').setAttribute('aria-labelledby', charts ? 'tab-' + view : 'results-title');
  document.querySelectorAll('[data-view]').forEach(button => {
    const active = button.dataset.view === view;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  $('#results-label').textContent = charts ? '排行榜' : '搜索结果';
  searching = true;
  notice();
  $('#count').textContent = '';
  $('#search-term').textContent = charts ? names[chartSource] : `“${query}”`;
  setLoadStatus('idle');
  hasMore = false;
  loadFailed = false;
  $('#empty').hidden = true;
  $('#results').hidden = true;
  $('#loading').hidden = false;
  $('#loading').setAttribute('aria-label', charts ? '正在加载榜单' : '正在搜索');
  $('.library').setAttribute('aria-busy', 'true');
  $('#search-button').disabled = true;
  $('#search-button span').textContent = '搜索中';
  $('#search-button').classList.add('busy');
  document.querySelectorAll('#source-select, [data-view], [data-platform]').forEach(control => control.disabled = true);
  try {
    const result = charts ? await api('/api/chart', {chart: view, source: chartSource, page: 1}) : await api('/api/search', {query, source});
    if (generation !== chartGeneration) return;
    $('#songs').replaceChildren(...result.songs.map(row));
    syncPlaybackButtons();
    renderDownloadQueue();
    $('#count').textContent = `${result.songs.length} 首`;
    $('#results').hidden = !result.songs.length;
    if (charts) {
      chartPage = result.page;
      chartTotal = result.total;
      hasMore = result.has_more;
      $('#results-label').textContent = result.name;
      $('#search-term').textContent = `${names[result.source]}${result.updated ? ' · ' + result.updated + ' 更新' : ''}`;
      updateChartCount();
    } else {
      resultTotal = result.songs.length;
      renderSourceFilter(result);
      applyResultFilter();
    }
    if (!result.songs.length) {
      $('#empty-title').textContent = result.failed.length ? '暂时没能取得结果' : '没有找到这首歌';
      $('#empty-subtitle').textContent = result.failed.length ? '稍后再试，或切换音乐来源' : '换个关键词，或试试歌名 + 歌手';
      $('#empty').hidden = false;
    }
    if (result.failed.length) notice(`${result.failed.map(s => names[s]).join('、')}暂时不可用`);
  } catch (error) {
    if (generation !== chartGeneration) return;
    notice(error.message === 'Failed to fetch' ? '连接中断，请重新启动页面' : error.message, true);
    $('#empty-title').textContent = '稍后，再试一次';
    $('#empty-subtitle').textContent = charts ? '切换榜单，或稍后重试' : '也可以切换音乐来源';
    $('#empty').hidden = false;
  } finally {
    if (generation === chartGeneration) {
      searching = false;
      $('#loading').hidden = true;
      $('.library').setAttribute('aria-busy', 'false');
      $('#search-button').disabled = false;
      $('#search-button span').textContent = '搜索';
      $('#search-button').classList.remove('busy');
      document.querySelectorAll('[data-view]').forEach(button => button.disabled = false);
      applyBackendSources();
      requestAnimationFrame(maybeLoadMore);
    }
  }
}

async function loadMore() {
  if (view === 'search' || !hasMore || loadingMore) return;
  const generation = chartGeneration;
  const chart = view;
  const platform = chartSource;
  const page = chartPage + 1;
  loadingMore = true;
  loadFailed = false;
  notice();
  setLoadStatus('loading');
  $('.library').setAttribute('aria-busy', 'true');
  try {
    const result = await api('/api/chart', {chart, source: platform, page});
    // The user may have switched charts or started a search while this page was loading.
    if (generation !== chartGeneration || view !== chart || chartSource !== platform) return;
    if (!result.songs.length) { hasMore = false; setLoadStatus('done'); return; }
    const offset = $('#songs').children.length;
    $('#songs').append(...result.songs.map((song, index) => row(song, offset + index)));
    syncPlaybackButtons();
    renderDownloadQueue();
    chartPage = result.page;
    chartTotal = result.total;
    hasMore = result.has_more;
    updateChartCount();
  } catch (error) {
    if (generation !== chartGeneration) return;
    loadFailed = true;
    const message = error.message === 'Failed to fetch' ? '连接中断，请稍后再试' : error.message;
    notice(message, true);
    setLoadStatus('error', message);
  } finally {
    loadingMore = false;
    if (generation === chartGeneration) $('.library').setAttribute('aria-busy', 'false');
    // Keep filling while the list is still short (e.g. on a very tall screen).
    requestAnimationFrame(maybeLoadMore);
  }
}

// Infinite scroll: fetch the next chart page once the list bottom is close to the viewport.
function maybeLoadMore() {
  if (document.hidden || searching || loadingMore || loadFailed ||
      view === 'search' || !hasMore || $('#results').hidden) return;
  const rect = $('#load-sentinel').getBoundingClientRect();
  if (rect.top <= window.innerHeight + 300) loadMore();
}

let scrollScheduled = false;
function scheduleAutoLoad() {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => { scrollScheduled = false; maybeLoadMore(); });
}

window.addEventListener('scroll', scheduleAutoLoad, {passive: true});
window.addEventListener('resize', scheduleAutoLoad);
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleAutoLoad(); });
$('#load-retry').addEventListener('click', () => { loadFailed = false; loadMore(); });
$('#search-form').addEventListener('submit', event => {event.preventDefault(); loadResults('search');});
document.querySelectorAll('[data-platform]').forEach(button => button.addEventListener('click', () => {
  if (searching) return;
  chartSource = button.dataset.platform;
  loadResults(view === 'search' ? 'hot' : view);
}));
$('.platform-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || searching) return;
  const tabs = [...document.querySelectorAll('[data-platform]')];
  const current = tabs.indexOf(document.activeElement);
  if (current < 0) return;
  event.preventDefault();
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
    (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  if (unsupportedControl(tabs[index])) return;
  tabs[index].focus();
  chartSource = tabs[index].dataset.platform;
  loadResults(view === 'search' ? 'hot' : view);
});
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => loadResults(button.dataset.view)));
$('.chart-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || searching) return;
  const tabs = [...document.querySelectorAll('[data-view]')].filter(tab => !tab.hidden);
  const current = tabs.indexOf(document.activeElement);
  if (current < 0) return;
  event.preventDefault();
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
    (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[index].focus();
  loadResults(tabs[index].dataset.view);
});
$('#source-select').addEventListener('change', event => {
  source = event.target.value;
  if (view === 'search' && lastQuery && $('#query').value.trim()) loadResults('search');
});
// Return to the chart that was open before the search; keep the search tab as a way back.
$('#back-to-chart').addEventListener('click', () => loadResults(lastChartView));

syncBackendSources().finally(() => {
  loadResults();
  restorePlayback();
  loadDownloads();
});
