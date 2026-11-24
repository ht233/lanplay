'use strict';

/* LanPlay 服务端 GUI（无框架，纯 DOM） */

const API = (path, opts = {}) => {
  const init = {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' }
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  return fetch(path, init).then(async (res) => {
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text }; }
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status; // 调用方按状态码判定（403 仅限本机等），不依赖错误文案
      throw err;
    }
    return data;
  });
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  data: null,
  tab: 'roots',
  browse: { rootId: null, path: '', stack: [] },
  logSeq: 0,
  logLines: [],
  timer: null,
  libraryVersion: 0,
  /** 媒体源排序模式（GUI 本地设置，与客户端互不影响），localStorage 持久化 */
  rootSort: localStorage.getItem('lanplay.rootsSort') || 'added'
};

/* ---------------- 工具 ---------------- */

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '--:--';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const p = (v) => String(v).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i === 0 ? n : n.toFixed(1)} ${u[i]}`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function toast(message, type = 'success', ms = 2600) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .2s';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

const STATE_TEXT = {
  STARTING: ['启动中', 'yellow'],
  PLAYING: ['转码中', 'blue'],
  PAUSED: ['已暂停', 'gray'],
  ENDED: ['已结束', 'gray'],
  STOPPED: ['已停止', 'gray'],
  ERROR: ['异常', 'red']
};

/* ---------------- 刷新 ---------------- */

async function refresh() {
  try {
    const data = await API('/api/gui/state');
    state.data = data;
    state.offlineSince = 0;
    hideOfflineBanner();
    renderHeader(data);
    if (state.tab === 'roots') renderRoots(data);
    if (state.tab === 'sessions') renderSessions(data);
    if (state.tab === 'clients') renderClients(data);
    if (state.tab === 'logs') renderLogs(data);
    if (state.tab === 'settings') renderSettings(data);
    // 目录监听触发的变化：正在浏览的目录需要重新拉一次列表
    // libraryVersion 缺失（旧服务端/异常响应）时不触发重拉，避免每 2s 无谓请求
    if (typeof data.libraryVersion === 'number' && data.libraryVersion !== state.libraryVersion) {
      state.libraryVersion = data.libraryVersion;
      if (state.browse.rootId) {
        try {
          const _s = currentSort();
          const res = await API(`/api/gui/browse?rootId=${encodeURIComponent(state.browse.rootId)}&path=${encodeURIComponent(state.browse.path)}&sort=${_s.sort}&order=${_s.order}`);
          renderBrowse(res);
        } catch (err) {
          // 引用已被移除（服务端 400）：清空浏览区
          clearStaleBrowse(err);
        }
      }
    }
  } catch (err) {
    console.warn('state refresh failed', err);
    // 连接失败：连续 3 次（约 6s）后横幅提示，避免断连后界面静默冻结（G-5）
    state.offlineSince = (state.offlineSince || 0) + 1;
    if (state.offlineSince >= 3) showOfflineBanner();
  }
}

function showOfflineBanner() {
  if ($('#offline-banner')) return;
  const bar = document.createElement('div');
  bar.id = 'offline-banner';
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;padding:10px 16px;background:var(--red,#c0392b);color:#fff;font-size:13px;text-align:center';
  bar.textContent = '与服务端断开连接，正在重试…（检查服务端进程是否在运行）';
  document.body.appendChild(bar);
}

function hideOfflineBanner() {
  const bar = $('#offline-banner');
  if (bar) bar.remove();
}

function renderHeader(d) {
  const s = d.server;
  $('#pill-serverid').innerHTML = `服务ID <b>${esc(s.serverId)}</b>`;
  $('#pill-lan').innerHTML = `局域网 <b>${esc((s.urls && s.urls[0]) ? s.urls[0].replace('http://', '') : '—')}</b>`;
  const m = d.metrics || {};
  $('#pill-cpu').innerHTML = `CPU <b>${m.cpu != null ? m.cpu : 0}%</b>`;
  // GPU pill：nvidia-smi 或 typeperf（多厂商 GPU Engine 计数器）任一有数据即显示
  const gpuPill = $('#pill-gpu');
  if (m.gpu != null) {
    gpuPill.classList.remove('hidden');
    const memOk = Number.isFinite(m.gpuMemUsed) && Number.isFinite(m.gpuMemTotal) && m.gpuMemTotal > 0;
    const memG = memOk ? ` · ${(m.gpuMemUsed / 1024).toFixed(1)}/${(m.gpuMemTotal / 1024).toFixed(1)}G` : '';
    gpuPill.innerHTML = `GPU <b>${m.gpu}%</b>${memG}`;
    gpuPill.title = m.gpuName ? `${m.gpuName} · 编码/渲染占用` : 'GPU 占用';
  } else {
    gpuPill.classList.add('hidden');
  }
  $('#pill-mem').innerHTML = `内存 <b>${m.mem != null ? m.mem : 0}%</b>`;
  const active = (d.sessions || []).filter((x) => !['STOPPED', 'ENDED'].includes(x.state)).length;
  $('#pill-transcode').innerHTML = `转码 <b>${active}/${d.maxSessions}</b>`;
  if (s.requirePin) {
    $('#pin-value').textContent = s.pin;
    $('#pin-value').classList.remove('muted');
  } else {
    $('#pin-value').textContent = '无有效配对码';
    $('#pin-value').classList.add('muted');
  }
  const ff = d.ffmpeg || {};
  $('#pill-ffmpeg').classList.toggle('hidden', !!ff.available);
  document.title = `${s.name} · LanPlay`;
}

/* ---------------- 媒体源 ---------------- */

function renderRoots(d) {
  const tbody = $('#roots-table tbody');
  $('#roots-count').textContent = d.roots.length ? `${d.roots.length} 个` : '';
  // 渲染时保留已勾选项（列表会随轮询刷新，不能把用户的选择冲掉）
  const checked = new Set(Array.from(tbody.querySelectorAll('input.row-check:checked')).map((el) => el.closest('tr').dataset.id));
  const alive = new Set(d.roots.map((r) => r.id));
  for (const id of [...checked]) if (!alive.has(id)) checked.delete(id);

  const roots = sortRoots(d.roots);
  // 数据未变时跳过重建（避免 2s 轮询打掉用户的点击/悬停状态）：用 JSON 指纹比对
  const fingerprint = JSON.stringify(roots.map((r) => [r.id, r.name, r.path, r.type, r.enabled, r.exists])) +
    '|' + JSON.stringify([...checked]);
  if (tbody.dataset.fp === fingerprint) return;
  tbody.dataset.fp = fingerprint;
  tbody.innerHTML = roots.map((r) => `
    <tr data-id="${esc(r.id)}">
      <td class="check-cell"><input type="checkbox" class="row-check" data-id="${esc(r.id)}" ${checked.has(r.id) ? 'checked' : ''}></td>
      <td title="${esc(r.name)}">${esc(r.name)}</td>
      <td class="mono" title="${esc(r.path)}">${esc(r.path)}</td>
      <td><span class="badge gray">${r.type === 'dir' ? '文件夹' : '单文件'}</span></td>
      <td>${r.enabled
        ? `<span class="badge ${r.exists ? 'green' : 'red'}">${r.exists ? '启用' : '路径丢失'}</span>`
        : '<span class="badge gray">禁用</span>'}</td>
      <td><div class="actions">
        <button class="btn ghost small" data-act="browse">浏览</button>
        <button class="btn ghost small" data-act="toggle">${r.enabled ? '禁用' : '启用'}</button>
        <button class="btn danger small" data-act="remove">移除</button>
      </div></td>
    </tr>`).join('');
  $('#roots-empty').classList.toggle('hidden', d.roots.length > 0);
  $('#roots-table').classList.toggle('hidden', d.roots.length === 0);
  syncRootSelection();
}

/** 媒体源排序（added=添加顺序；name/mtime/size 升降序；type：asc=文件夹在前文件在后、desc=文件在前）
 *  时间/大小字段来自服务端 roots 下发（mtime/size 缺失时按 0 处理，稳定排尾部） */
function sortRoots(roots) {
  const mode = state.rootSort || 'added';
  const arr = roots.slice();
  if (mode === 'added') return arr;
  const coll = (a, b) => (a || '').localeCompare(b || '', 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  const byName = (a, b) => coll(a.name, b.name);
  const num = (r) => Number(r[mode === 'mtime' || mode === 'mtime-desc' ? 'mtime' : 'size'] || 0);
  if (mode === 'name' || mode === 'name-desc') {
    arr.sort(byName);
    if (mode === 'name-desc') arr.reverse();
  } else if (mode === 'mtime' || mode === 'mtime-desc' || mode === 'size' || mode === 'size-desc') {
    arr.sort((a, b) => num(a) - num(b) || byName(a, b));
    if (mode.endsWith('-desc')) arr.reverse();
  } else if (mode === 'type' || mode === 'type-desc') {
    // asc：文件夹（dir）在前、单文件在后；desc：文件在前；同组内按名称
    const rank = (r) => (r.type === 'dir' ? 0 : 1);
    arr.sort((a, b) => rank(a) - rank(b) || byName(a, b));
    if (mode === 'type-desc') arr.reverse();
  } else if (mode === 'state') {
    const rank = (r) => (!r.enabled ? 2 : (!r.exists ? 1 : 0)); // 启用在前，丢失/禁用靠后
    arr.sort((a, b) => rank(a) - rank(b) || byName(a, b));
  }
  return arr;
}

/** 勾选状态同步到批量按钮（没选中时禁用） */
function syncRootSelection() {
  const boxes = Array.from(document.querySelectorAll('#roots-table input.row-check'));
  const n = boxes.filter((b) => b.checked).length;
  const total = boxes.length;
  const headBox = $('#roots-check-head');
  if (headBox) {
    headBox.checked = total > 0 && n === total;
    headBox.indeterminate = n > 0 && n < total;
  }
  const all = $('#roots-check-all');
  if (all) all.checked = total > 0 && n === total;
  const has = n > 0;
  $('#btn-batch-enable').disabled = !has;
  $('#btn-batch-disable').disabled = !has;
  $('#btn-batch-remove').disabled = !has;
}

/** 当前选中的媒体源 id */
function selectedRootIds() {
  return Array.from(document.querySelectorAll('#roots-table input.row-check:checked'))
    .map((b) => b.closest('tr').dataset.id);
}

async function addRoot(paths) {
  if (!paths.length) return 0;
  try {
    const res = await API('/api/gui/roots', { method: 'POST', body: { paths } });
    const okCount = (res.added || []).length;
    if (okCount) toast(`已添加 ${okCount} 个媒体源`, 'success');
    for (const f of res.failed || []) toast(`${f.path}：${f.error}`, 'error', 4000);
    await refresh();
    return okCount;
  } catch (err) {
    toast(`添加失败：${err.message}`, 'error', 4000);
    return 0;
  }
}

async function browseRoot(rootId, relPath = '', push = true) {
  state.browse.rootId = rootId;
  state.browse.path = relPath;
  if (push) {
    if (relPath) state.browse.stack.push(relPath);
    else state.browse.stack = [];
  }
  const root = state.data.roots.find((r) => r.id === rootId);
  $('#browse-path').textContent = root ? `${root.name}${relPath ? ' / ' + relPath : ''}` : '';
  $('#btn-browse-up').classList.toggle('hidden', !relPath);
  try {
    const { sort, order } = currentSort();
    const res = await API(`/api/gui/browse?rootId=${encodeURIComponent(rootId)}&path=${encodeURIComponent(relPath)}&sort=${sort}&order=${order}`);
    renderBrowse(res);
  } catch (err) {
    toast(`浏览失败：${err.message}`, 'error');
  }
}

/** 当前排序选择 → {sort, order} */
function currentSort() {
  const v = ($('#browse-sort') || {}).value || 'name';
  const [sort, order] = v.split('-');
  return { sort, order: order === 'desc' ? 'desc' : 'asc' };
}

function renderBrowse(res) {
  const tbody = $('#browse-table tbody');
  const items = res.items || [];
  tbody.innerHTML = items.map((it) => {
    const isDir = it.kind === 'dir';
    const isImage = it.kind === 'image';
    const isVideo = it.kind === 'video';
    const isAudio = it.kind === 'audio';
    const icon = isDir ? '📁' : (it.kind === 'audio' ? '🎵' : (isImage ? '🖼️' : '🎬'));
    const kindLabel = isDir ? '文件夹' : it.kind === 'audio' ? '音频' : isImage ? '图片' : '视频';
    const size = isDir ? '-' : humanSize(it.size);
    const dur = !isDir && it.duration ? formatDuration(it.duration) : '';
    return `<tr data-path="${esc(it.path)}" data-kind="${esc(it.kind)}">
      <td title="${esc(it.name)}">${icon} ${esc(it.name)} ${dur ? `<span class="dim">· ${dur}</span>` : ''}</td>
      <td class="dim">${kindLabel}</td>
      <td class="dim">${size}</td>
      <td><div class="actions">
        ${isDir ? '<button class="btn ghost small" data-act="open">进入</button>' : ''}
        ${isImage ? '<button class="btn primary small" data-act="view">打开</button>' : ''}
        ${isVideo || isAudio ? `<button class="btn primary small" data-act="play-local">预览</button>` : ''}
        ${!isDir ? '<button class="btn ghost small" data-act="reveal">定位</button>' : ''}
      </div></td>
    </tr>`;
  }).join('');
  $('#browse-empty').classList.toggle('hidden', items.length > 0);
  $('#browse-table').classList.toggle('hidden', items.length === 0);
}

/**
 * 媒体源被移除后清空浏览区（轮询 browse 失败时的兜底）。
 */
function clearStaleBrowse() {
  state.browse = { rootId: null, path: '', stack: [] };
  $('#browse-path').textContent = '';
  $('#browse-empty').classList.remove('hidden');
  $('#browse-table').classList.add('hidden');
}

/* ---------------- 转码会话 ---------------- */

function renderSessions(d) {
  const rows = d.sessions || [];
  $('#sessions-count').textContent = rows.length ? `${rows.length} 个` : '';
  const tbody = $('#sessions-table tbody');
  // 会话位置每秒都在变，指纹比对意义不大 —— 只对「结构不变」的会话做原地更新进度条，
  // 结构变化（数量/状态/文件）才整体重建，避免轮询打掉用户正在点击的「停止」按钮。
  const fp = JSON.stringify(rows.map((s) => [s.id, s.state, s.directPlay, s.hardware, s.encoder, s.file, s.client]));
  if (tbody.dataset.fp === fp && rows.length === tbody.querySelectorAll('tr[data-sid]').length) {
    // 原地更新进度与位置列
    const trs = tbody.querySelectorAll('tr[data-sid]');
    rows.forEach((s, i) => {
      const pct = s.duration ? Math.min(100, (s.position / s.duration) * 100) : 0;
      const tr = trs[i];
      if (!tr) return;
      const posTd = tr.querySelector('.pos-cell');
      if (posTd) posTd.textContent = `${formatDuration(s.position)} / ${formatDuration(s.duration)}`;
      const bar = tr.nextElementSibling && tr.nextElementSibling.querySelector('.bar > i');
      if (bar) bar.style.width = `${pct}%`;
    });
    return;
  }
  tbody.dataset.fp = fp;
  tbody.innerHTML = rows.map((s) => {
    const [label, color] = STATE_TEXT[s.state] || [esc(s.state || ''), 'gray'];
    const pct = s.duration ? Math.min(100, (s.position / s.duration) * 100) : 0;
    // 编码方式一目了然：直通 / GPU 编码 / CPU 软编
    const encBadge = s.directPlay
      ? '<span class="badge green">直通</span>'
      : s.hardware
        ? `<span class="badge blue">GPU 编码</span> <span class="dim">${esc(s.encoder || '')}</span>`
        : `<span class="badge gray">CPU 软编</span> <span class="dim">${esc(s.encoder || '')}</span>`;
    return `<tr data-sid="${esc(s.id)}">
      <td class="mono">${esc(s.id)}</td>
      <td title="${esc(s.file)}">${esc(s.file)}</td>
      <td>${s.directPlay ? '<span class="badge green">直通</span>' : '<span class="badge yellow">转码</span>'}</td>
      <td><span class="badge ${color}">${label}</span></td>
      <td class="dim pos-cell">${formatDuration(s.position)} / ${formatDuration(s.duration)}</td>
      <td class="dim">${esc(s.client || '-')}</td>
      <td>${encBadge}</td>
      <td><div class="actions"><button class="btn danger small" data-act="stop" data-id="${esc(s.id)}">停止</button></div></td>
    </tr>
    <tr class="progress-row"><td colspan="8"><div class="bar"><i style="width:${pct}%"></i></div></td></tr>`;
  }).join('');
  $('#sessions-empty').classList.toggle('hidden', rows.length > 0);
  $('#sessions-table').classList.toggle('hidden', rows.length === 0);

  const hist = d.history || [];
  $('#history-table tbody').innerHTML = hist.map((h) => `
    <tr>
      <td title="${esc(h.file)}">${esc(h.title || h.file)}</td>
      <td class="dim">${esc(h.client || '-')}</td>
      <td class="dim">${formatDuration(h.duration)}</td>
      <td class="dim">${formatTs(h.endedAt)}</td>
      <td>${h.error ? `<span class="badge red">异常</span> <span class="dim">${esc(h.error.slice(0, 40))}</span>` : '<span class="badge gray">正常</span>'}</td>
    </tr>`).join('');
  $('#history-empty').classList.toggle('hidden', hist.length > 0);
  $('#history-table').classList.toggle('hidden', hist.length === 0);
}

function formatTs(v) {
  const t = Number(v);
  if (!Number.isFinite(t)) return '-';
  return new Date(t).toLocaleString('zh-CN', { hour12: false });
}

/* ---------------- 客户端 ---------------- */

function renderClients(d) {
  const rows = d.clients || [];
  $('#clients-count').textContent = rows.length ? `${rows.length} 台` : '';
  const tbody = $('#clients-table tbody');
  const fp = JSON.stringify(rows.map((c) => [c.id, c.name, c.model, c.ip, c.pairedAt, c.lastSeen, c.status]));
  if (tbody.dataset.fp === fp) return; // 数据未变不重建（保留按钮悬停/点击状态）
  tbody.dataset.fp = fp;
  tbody.innerHTML = rows.map((c) => `
    <tr>
      <td title="${esc(c.name)}">${esc(c.name)}</td>
      <td class="dim">${esc(c.model || '-')}</td>
      <td class="mono">${esc(c.ip || '-')}</td>
      <td class="dim">${esc(c.pairedAt || '-')}</td>
      <td class="dim">${esc(c.lastSeen || '-')}</td>
      <td>${c.status === 'online' ? '<span class="badge green">正常</span>' : '<span class="badge gray">离线</span>'}</td>
      <td><div class="actions"><button class="btn danger small" data-act="kick" data-id="${esc(c.id)}">踢出</button></div></td>
    </tr>`).join('');
  $('#clients-empty').classList.toggle('hidden', rows.length > 0);
  $('#clients-table').classList.toggle('hidden', rows.length === 0);
}

/* ---------------- 日志 ---------------- */

function renderLogs(d) {
  const view = $('#log-view');
  const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
  const lines = (d.logs || []).map((e) => ({
    seq: e.seq, time: e.time, level: e.level, message: e.message
  }));
  const lastSeq = lines.length ? lines[lines.length - 1].seq : state.logSeq;
  // 服务端重启后 seq 会归零重来：检测到断裂（新 seq 不大于已见游标且日志非空）即重置游标重拉，
  // 否则本页会从此永久冻结在旧 seq（G-3）。
  if (state.logLines.length > 0 && lines.length > 0 && lastSeq <= state.logSeq && lines[0].seq <= state.logSeq) {
    if (lines[0].seq === 1) state.logSeq = 0;
  }
  if (lastSeq > state.logSeq || state.logLines.length === 0) {
    state.logLines = state.logLines.concat(lines.filter((l) => l.seq > state.logSeq));
    if (state.logLines.length > 3000) state.logLines = state.logLines.slice(-3000);
    state.logSeq = lastSeq;
    view.innerHTML = state.logLines.map((l) => `
      <div class="log-line ${esc(l.level)}"><span class="t">${esc(l.time)}</span><span class="m">${esc(l.message)}</span></div>`).join('');
    if ($('#log-follow').checked && atBottom) view.scrollTop = view.scrollHeight;
  }
  $('#log-seq').textContent = `SEQ ${state.logSeq}`;
}

/* ---------------- 设置 ---------------- */

function renderSettings(d) {
  // 用户正在设置页编辑任何输入控件（输入框/下拉框/复选框）时跳过回写，避免 2s 轮询冲掉未提交的选择（G-2）
  const ae = document.activeElement;
  if (ae && ae.closest('#panel-settings') && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT')) return;
  const s = d.server;
  const t = d.transcodeDefaults || {};
  $('#set-name').value = s.name || '';
  $('#set-port').value = s.port || 8099;
  $('#set-maxsessions').value = d.maxSessions || 2;
  $('#set-requirepin').checked = !!s.requirePin;
  $('#set-discovery').checked = !!s.discovery;
  $('#set-hw').checked = !!d.hardwareAccel;
  $('#set-resolution').value = t.resolution || 'auto';
  $('#set-bitrate').value = t.bitrate || 4000;
  $('#set-fps').value = String(t.fps || 'auto');
  $('#set-codec').value = t.codec || 'h264';
  $('#set-quality').value = t.quality || 'balanced';
  $('#set-audiobitrate').value = t.audioBitrate || 128;
  $('#set-directplay').value = t.directPlay || 'auto';

  const ff = d.ffmpeg || {};
  $('#hw-ffmpeg').textContent = ff.available ? '已就绪' : '缺失（请把 ffmpeg.exe / ffprobe.exe 放入 bin 目录）';
  $('#hw-ffmpeg').style.color = ff.available ? 'var(--green)' : 'var(--red)';  $('#hw-version').textContent = ff.version || '-';
  $('#hw-encoders').textContent = (ff.hwEncoders && ff.hwEncoders.length)
    ? ff.hwEncoders.map((e) => e.label).join('、')
    : '无（CPU 软编）';
  // 编码方式说明：有真 GPU 时告诉用户怎么核对；没有时说明 h264_mf 是系统软编不算 GPU
  const hwCount = (ff.hwEncoders || []).length;
  const swMf = (ff.softwareMfEncoders || []).map((e) => e.label).join('、');
  let note = hwCount
    ? '播放时任务管理器 GPU 占用会上升；会话列表「编码」列显示 GPU 编码即真实生效'
    : '当前无真实 GPU 编码（MediaFoundation 的 H264 Encoder MFT 是微软系统软编，跑 CPU）；转码走 CPU 软编';
  if (swMf) note += `；系统软编备选：${swMf}`;
  $('#hw-note').textContent = note;
  if (window.lanplay && window.lanplay.info) {
    window.lanplay.info().then((info) => { $('#info-root').textContent = info.rootDir; }).catch(() => {});
  }
}

/* ---------------- 事件绑定 ---------------- */

function bindTabs() {
  $$('#tabs .tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#tabs .tab').forEach((b) => {
        b.classList.toggle('active', b === btn);
        if (b.hasAttribute('role')) b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });
      $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${btn.dataset.tab}`));
      state.tab = btn.dataset.tab;
      if (state.data) {
        if (state.tab === 'settings') renderSettings(state.data);
        if (state.tab === 'logs') renderLogs(state.data);
      }
      refresh();
    });
  });
}

function bindRoots() {
  $('#btn-add-root').addEventListener('click', () => {
    const raw = $('#root-input').value.trim();
    if (!raw) return toast('请输入路径', 'warn');
    const paths = raw.split(/[,，;；\n]/).map((s) => s.trim()).filter(Boolean);
    // 只在全部成功时才清空输入框（部分失败时保留原输入便于修正后重试，G-8）
    const before = paths.length;
    addRoot(paths).then((added) => {
      if (added >= before) $('#root-input').value = '';
    });
  });
  $('#root-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-add-root').click();
  });
  $('#btn-pick-folder').addEventListener('click', async () => {
    try {
      const res = await API('/api/gui/pick-folder', { method: 'POST' });
      await addRoot(res.paths || []);
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#btn-pick-file').addEventListener('click', async () => {
    try {
      const res = await API('/api/gui/pick-files', { method: 'POST' });
      await addRoot(res.paths || []);
    } catch (err) { toast(err.message, 'error'); }
  });

  $('#roots-table').addEventListener('change', (e) => {
    if (e.target.matches('input.row-check')) syncRootSelection();
  });

  // 表头/工具条的全选
  const toggleAll = (on) => {
    document.querySelectorAll('#roots-table input.row-check').forEach((b) => { b.checked = on; });
    syncRootSelection();
  };
  $('#roots-check-head').addEventListener('change', (e) => toggleAll(e.target.checked));
  $('#roots-check-all').addEventListener('change', (e) => toggleAll(e.target.checked));

  const batch = async (action, label) => {
    const ids = selectedRootIds();
    if (action !== 'purge' && !ids.length) return toast('请先勾选要操作的媒体源', 'warn');
    const tip = action === 'purge'
      ? '确定移除全部媒体源？只移除引用记录，不会删除磁盘文件。'
      : `确定${label}选中的 ${ids.length} 个媒体源？`;
    if (!confirm(tip)) return;
    try {
      await API('/api/gui/roots-batch', { method: 'POST', body: { action, ids } });
      toast(`已${label} ${action === 'purge' ? '全部媒体源' : ids.length + ' 个媒体源'}`, 'success');
      if (action === 'remove' || action === 'purge') {
        const keep = state.browse.rootId && !ids.includes(state.browse.rootId);
        if (!keep) {
          state.browse = { rootId: null, path: '', stack: [] };
          $('#browse-path').textContent = '';
          $('#browse-empty').classList.remove('hidden');
          $('#browse-table').classList.add('hidden');
        }
      }
      await refresh();
    } catch (err) { toast(err.message, 'error', 4000); }
  };
  $('#btn-batch-enable').addEventListener('click', () => batch('enable', '启用'));
  $('#btn-batch-disable').addEventListener('click', () => batch('disable', '禁用'));
  $('#btn-batch-remove').addEventListener('click', () => batch('remove', '移除'));
  $('#btn-batch-purge').addEventListener('click', () => batch('purge', '移除'));

  $('#roots-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const id = tr.dataset.id;
    const root = state.data.roots.find((r) => r.id === id);
    try {
      if (btn.dataset.act === 'browse') {
        await browseRoot(id, '');
        $('#panel-roots').querySelector('.card.grow').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else if (btn.dataset.act === 'toggle') {
        await API('/api/gui/roots', { method: 'PATCH', body: { id, enabled: !root.enabled } });
        await refresh();
      } else if (btn.dataset.act === 'remove') {
        if (!confirm(`确定移除媒体源「${root.name}」？不会删除磁盘文件。`)) return;
        await API('/api/gui/roots', { method: 'DELETE', body: { id } });
        toast('已移除媒体源');
        if (state.browse.rootId === id) {
          state.browse = { rootId: null, path: '', stack: [] };
          $('#browse-path').textContent = '';
          $('#browse-empty').classList.remove('hidden');
          $('#browse-table').classList.add('hidden');
        }
        await refresh();
      }
    } catch (err) { toast(err.message, 'error', 4000); }
  });

  $('#btn-browse-up').addEventListener('click', () => {
    const stack = state.browse.stack.slice(0, -1);
    const parent = stack.length ? stack[stack.length - 1] : '';
    state.browse.stack = stack;
    browseRoot(state.browse.rootId, parent, false);
  });

  // 排序变更：保持当前目录，重新拉一次
  $('#browse-sort').addEventListener('change', () => {
    if (state.browse.rootId) browseRoot(state.browse.rootId, state.browse.path, false);
  });
  // 媒体源排序：GUI 本地设置（localStorage 持久化），与客户端互不影响。
  // 服务端 config.rootSort 已废弃——排序纯前端，root 列表来自 /api/gui/state 原序。
  const rootsSortSel = $('#roots-sort');
  if (rootsSortSel) {
    rootsSortSel.value = state.rootSort || 'added';
    rootsSortSel.addEventListener('change', () => {
      state.rootSort = rootsSortSel.value;
      try { localStorage.setItem('lanplay.rootsSort', state.rootSort); } catch (_) { /* ignore */ }
      renderRoots(state.data);
    });
  }
  $('#btn-browse-refresh').addEventListener('click', () => {
    if (state.browse.rootId) browseRoot(state.browse.rootId, state.browse.path, false);
  });

  $('#browse-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const p = tr.dataset.path;
    const kind = tr.dataset.kind;
    try {
      if (btn.dataset.act === 'open') {
        await browseRoot(state.browse.rootId, p, true);
      } else if (btn.dataset.act === 'view') {
        // 图片：新窗口打开原图直出（无需转码会话）
        const base = location.origin;
        const url = `${base}/raw/${encodeURIComponent(state.browse.rootId)}/${p.split('/').map(encodeURIComponent).join('/')}`;
        window.open(url, '_blank');
      } else if (btn.dataset.act === 'play-local') {
        // 系统默认播放器预览（补充 19）：服务端 explorer.exe 打开本机文件 → Windows 弹「用 xxx 打开」/默认播放器接管。
        // 不创建转码会话、不经浏览器 —— 视频解码完全交给用户系统里装的播放器。
        const root = state.data.roots.find((r) => r.id === state.browse.rootId);
        if (!root) throw new Error('媒体源不存在');
        const full = root.type === 'file'
          ? root.path
          : root.path.replace(/[\\/]$/, '') + '\\' + p.replace(/\//g, '\\');
        const res = await API('/api/gui/open-with-player', { method: 'POST', body: { path: full } });
        toast(`已调用系统默认播放器打开：${res.path ? full.split('\\').pop() : ''}`);
      } else if (btn.dataset.act === 'reveal') {
        const root = state.data.roots.find((r) => r.id === state.browse.rootId);
        if (root) {
          // 单文件引用时 p 已经是绝对路径（describeFile 直接返回文件全路径），
          // 再拼 root.path 会得到 "C:\...\a.mkv\C:/...\a.mkv" 这种非法路径。
          const full = root.type === 'file'
            ? root.path
            : root.path.replace(/[\\/]$/, '') + '\\' + p.replace(/\//g, '\\');
          await API('/api/gui/reveal-file', { method: 'POST', body: { path: full } }).catch((err) => toast(err.message, 'error'));
        }
      }
    } catch (err) { toast(err.message, 'error', 4000); }
  });
}

function bindSessions() {
  $('#sessions-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act="stop"]');
    if (!btn) return;
    try {
      await API('/api/gui/sessions-stop', { method: 'POST', body: { id: btn.dataset.id } });
      toast('会话已停止');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function bindClients() {
  $('#clients-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act="kick"]');
    if (!btn) return;
    if (!confirm('确定踢出该客户端？需要重新输入配对码才能连接。')) return;
    try {
      await API('/api/gui/clients-kick', { method: 'POST', body: { id: btn.dataset.id } });
      toast('已踢出客户端');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function bindLogs() {
  $('#btn-log-clear').addEventListener('click', async () => {
    try {
      await API('/api/gui/logs-clear', { method: 'POST' });
      state.logLines = [];
      state.logSeq = 0;
      $('#log-view').innerHTML = '';
      toast('日志已清空');
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#btn-log-export').addEventListener('click', async () => {
    try {
      const res = await API('/api/gui/logs-export', { method: 'POST' });
      toast(`已导出到 ${res.file}`, 'success', 4000);
      if (window.lanplay) window.lanplay.showItemInFolder(res.file);
    } catch (err) { toast(err.message, 'error'); }
  });
}

function bindSettings() {
  $('#btn-save-settings').addEventListener('click', async () => {
    try {
      await API('/api/gui/settings', {
        method: 'POST',
        body: {
          serverName: $('#set-name').value.trim() || 'LanPlay 服务端',
          port: Number($('#set-port').value) || 8099,
          maxSessions: Number($('#set-maxsessions').value) || 2,
          requirePin: $('#set-requirepin').checked,
          discovery: $('#set-discovery').checked,
          hardwareAccel: $('#set-hw').checked
        }
      });
      toast('设置已保存（端口修改需重启生效）', 'success');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });

  $('#btn-save-transcode').addEventListener('click', async () => {
    try {
      await API('/api/gui/settings', {
        method: 'POST',
        body: {
          transcode: {
            resolution: $('#set-resolution').value,
            bitrate: Number($('#set-bitrate').value) || 4000,
            fps: $('#set-fps').value,
            codec: $('#set-codec').value,
            quality: $('#set-quality').value,
            audioBitrate: Number($('#set-audiobitrate').value) || 128,
            directPlay: $('#set-directplay').value
          }
        }
      });
      toast('转码参数已保存', 'success');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });

  $('#btn-redetect').addEventListener('click', async () => {
    toast('正在重新检测编码器…', 'success');
    try {
      await API('/api/gui/ffmpeg-detect', { method: 'POST' });
      await refresh();
      toast('检测完成', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });

  $('#btn-open-data').addEventListener('click', async () => {
    try { await API('/api/gui/open-folder', { method: 'POST', body: {} }); } catch (err) { toast(err.message, 'error'); }
  });

  $('#btn-quit').addEventListener('click', async () => {
    if (!confirm('确定退出 LanPlay 服务端？')) return;
    await API('/api/gui/quit', { method: 'POST' }).catch(() => {});
    setTimeout(() => window.close(), 600);
  });
}

function bindPin() {
  $('#btn-regen-pin').addEventListener('click', async () => {
    if (!confirm('重新生成后，旧配对码立即失效（已配对客户端不受影响）。继续？')) return;
    try {
      const res = await API('/api/gui/pin', { method: 'POST' });
      $('#pin-value').textContent = res.pin;
      toast(`新配对码：${res.pin}`, 'success', 4000);
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function bindDragDrop() {
  const overlay = $('#drop-overlay');
  let depth = 0;

  const getPaths = (dt) => {
    const files = Array.from(dt.files || []);
    const out = [];
    for (const f of files) {
      let p = null;
      if (window.lanplay && window.lanplay.pathForFile) p = window.lanplay.pathForFile(f);
      if (p) out.push(p);
    }
    // 兜底：部分环境拖拽只带 text/uri-list（file:///C:/xxx）
    if (!out.length) {
      const uriList = dt.getData('text/uri-list') || dt.getData('text/plain') || '';
      for (const line of uriList.split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith('#')) continue;
        if (s.startsWith('file:///')) {
          try { out.push(decodeURIComponent(s.slice(8)).replace(/\//g, '\\')); } catch (_) { /* ignore */ }
        } else if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\')) {
          out.push(s);
        }
      }
    }
    return out;
  };

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    overlay.classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.classList.add('hidden');
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    overlay.classList.add('hidden');
    const paths = getPaths(e.dataTransfer);
    if (!paths.length) {
      toast('无法读取拖入路径（请通过「选择文件夹」按钮添加）', 'warn', 4000);
      return;
    }
    await addRoot(paths);
    $$('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'roots'));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-roots'));
    state.tab = 'roots';
  });
}

/* ---------------- 主题 ---------------- */

const THEME_KEY = 'lanplay.theme';
const THEME_AUTO_KEY = 'lanplay.themeAuto';

const theme = {
  current: 'dark',
  auto: false,
  media: null
};

function systemTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(name, { persist = true } = {}) {
  const target = name === 'light' ? 'light' : 'dark';
  theme.current = target;
  document.documentElement.setAttribute('data-theme', target);
  const icon = $('#theme-icon');
  const label = $('#theme-label');
  if (icon) icon.textContent = target === 'light' ? '🌙' : '☀';
  if (label) label.textContent = target === 'light' ? '深色' : '亮色';
  const btn = $('#btn-theme');
  if (btn) btn.title = target === 'light' ? '切换到深色主题（Ctrl+Shift+L）' : '切换到亮色主题（Ctrl+Shift+L）';
  $$('.theme-swatch').forEach((el) => {
    el.classList.toggle('active', el.dataset.swatch === target);
  });
  if (persist && !theme.auto) {
    try { localStorage.setItem(THEME_KEY, target); } catch (_) { /* ignore */ }
  }
}

function toggleTheme() {
  theme.auto = false;
  try { localStorage.setItem(THEME_AUTO_KEY, '0'); } catch (_) { /* ignore */ }
  const auto = $('#set-theme-auto');
  if (auto) auto.checked = false;
  applyTheme(theme.current === 'light' ? 'dark' : 'light');
}

function initTheme() {
  let saved = null;
  let auto = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
    auto = localStorage.getItem(THEME_AUTO_KEY);
  } catch (_) { /* ignore */ }
  theme.auto = auto === '1';
  if (theme.auto) {
    applyTheme(systemTheme(), { persist: false });
  } else {
    applyTheme(saved === 'light' ? 'light' : 'dark');
  }
  // 跟随系统时监听变化
  if (window.matchMedia) {
    theme.media = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => { if (theme.auto) applyTheme(systemTheme(), { persist: false }); };
    if (theme.media.addEventListener) theme.media.addEventListener('change', handler);
    else if (theme.media.addListener) theme.media.addListener(handler);
  }
  const chk = $('#set-theme-auto');
  if (chk) {
    chk.checked = theme.auto;
    chk.addEventListener('change', () => {
      theme.auto = chk.checked;
      try { localStorage.setItem(THEME_AUTO_KEY, theme.auto ? '1' : '0'); } catch (_) { /* ignore */ }
      if (theme.auto) applyTheme(systemTheme(), { persist: false });
      else applyTheme(theme.current);
    });
  }
  $$('.theme-swatch').forEach((el) => {
    el.addEventListener('click', () => {
      theme.auto = false;
      if (chk) chk.checked = false;
      try { localStorage.setItem(THEME_AUTO_KEY, '0'); } catch (_) { /* ignore */ }
      applyTheme(el.dataset.swatch);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
      e.preventDefault();
      toggleTheme();
    }
  });
}

/* ---------------- 启动 ---------------- */

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(refresh, 2000);
}

/**
 * 管理接口仅限本机回环访问（服务端 gui-api.js 硬性 403）。
 * 局域网地址打开管理页时 state 会 403——与其显示一堆横杠让用户以为坏了，
 * 不如明确告知原因与正确用法（安全设计，不是故障）。
 */
async function checkLoopbackOnce() {
  if (state.loopbackChecked) return;
  state.loopbackChecked = true;
  try {
    await API('/api/gui/state');
    return; // 本机回环，正常
  } catch (err) {
    if ((err && err.status) !== 403) return; // 仅 403（仅限本机）走提示页；其它错误交给常规刷新逻辑
  }
  // 命中 403：替换整个页面为提示
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#141a21;color:#d7dde6;font-family:inherit;">
      <div style="max-width:560px;padding:40px;background:#1b2129;border:1px solid #2b333d;border-radius:12px;">
        <h1 style="font-size:20px;margin:0 0 14px;">⚠️ 管理页面仅限服务端本机打开</h1>
        <p style="line-height:1.8;margin:0 0 10px;">你当前通过<b>局域网地址</b>访问 LanPlay 管理页。出于安全考虑，添加/删除媒体源、查看转码状态等管理能力<b>只允许在服务端电脑本机操作</b>（防止局域网内其它设备篡改媒体库或读取文件路径）。</p>
        <p style="line-height:1.8;margin:0 0 10px;">请在本机打开 <b>http://127.0.0.1:${location.port}</b> 进行管理。</p>
        <p style="line-height:1.8;margin:0;color:#8a93a5;">投影仪 / 其它设备请使用 LanPlay Android 客户端连接观看（客户端有自己的配对鉴权，不受此限制）。</p>
      </div>
    </div>`;
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
}

bindTabs();
bindRoots();
bindSessions();
bindClients();
bindLogs();
bindSettings();
bindPin();
bindDragDrop();
initTheme();
$('#btn-theme').addEventListener('click', toggleTheme);
checkLoopbackOnce();
refresh();
startPolling();

if (window.lanplay && window.lanplay.onReady) {
  window.lanplay.onReady(() => refresh());
}
