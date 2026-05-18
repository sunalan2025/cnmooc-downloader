
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ===== state =====
let courses = [];
const courseSelection = new Map(); // courseId -> 'all' | 'none' | Set<chapter>
const expandedCourses = new Set();
let loginRequested = false;
let statusChecked = false;
let logCollapsed = localStorage.getItem('logCollapsed') === '1';

// ===== WebSocket =====
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${proto}://${location.host}/ws`);
ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
ws.onclose = () => addLog('warn', 'WebSocket 已断开，刷新页面恢复');
ws.onerror = () => {};

function handleMessage(msg) {
  switch (msg.type) {
    case 'log':
      addLog(msg.level, msg.message);
      break;
    case 'login-ok':
      loginRequested = false;
      hideOverlay();
      updateStatus(true);
      loadCourses();
      break;
    case 'login-error':
      loginRequested = false;
      hideOverlay();
      addLog('err', '登录失败: ' + msg.error);
      break;
    case 'prep-begin':
      showPrepCard(msg.total);
      break;
    case 'prep-progress':
      updatePrepCard(msg.processed, msg.total);
      break;
    case 'prep-end':
      finishPrepCard(msg.total);
      break;
    case 'download-begin':
      initDownloadCards();
      setControlState('downloading');
      break;
    case 'download-progress':
      updateDownloadCard(msg);
      break;
    case 'download-paused':
      setControlState('paused');
      break;
    case 'download-resumed':
      setControlState('downloading');
      break;
    case 'download-cancelled':
      setControlState('idle');
      addLog('warn', `已取消 (完成 ${msg.completed}, 失败 ${msg.errors}, 取消 ${msg.cancelled || 0})`);
      break;
    case 'download-end':
      setControlState('idle');
      addLog('ok', `全部下载结束 (成功: ${msg.completed}, 失败: ${msg.errors})`);
      break;
  }
}

// ===== log =====
// allowed log levels — drop anything else to avoid XSS via WS-sourced markup
const LOG_LEVELS = new Set(['info', 'ok', 'warn', 'err', 'skip', 'step']);

function addLog(level, message) {
  const safeLevel = LOG_LEVELS.has(level) ? level : 'info';
  const panel = $('#logPanel');
  const div = document.createElement('div');
  div.className = 'log-line';
  div.dataset.level = safeLevel;
  div.innerHTML = `<span class="lvl lvl-${safeLevel}">[${safeLevel.toUpperCase()}]</span>${escHtml(message)}`;
  panel.appendChild(div);
  panel.scrollTop = panel.scrollHeight;
  while (panel.children.length > 800) panel.firstChild.remove();
}

$('#logClear').onclick = () => { $('#logPanel').innerHTML = ''; };

function setLogCollapsed(collapsed) {
  logCollapsed = collapsed;
  $('#logSection').classList.toggle('collapsed', collapsed);
  $('#logToggle').textContent = collapsed ? '显示 INFO' : '隐藏 INFO';
  localStorage.setItem('logCollapsed', collapsed ? '1' : '0');
}
$('#logToggle').onclick = () => setLogCollapsed(!logCollapsed);
setLogCollapsed(logCollapsed);

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ===== status =====
async function checkStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    updateStatus(data.loggedIn);
    if (data.loggedIn) {
      courses = data.courses || [];
      renderCourses();
    } else if (!statusChecked) {
      addLog('step', '未检测到有效登录会话，自动启动登录流程...');
      startLogin();
    }
    if (data.downloadRunning) $('#downloadBtn').disabled = true;
  } catch {
    updateStatus(false);
  } finally {
    statusChecked = true;
  }
}

function updateStatus(loggedIn) {
  const pill = $('#statusPill');
  const text = $('#statusText');
  const loginBtn = $('#loginBtn');
  const refreshBtn = $('#refreshBtn');
  if (loggedIn) {
    pill.classList.add('on');
    text.textContent = '已登录';
    loginBtn.style.display = 'none';
    refreshBtn.style.display = '';
    updateDownloadBtn();
  } else {
    pill.classList.remove('on');
    text.textContent = '未登录';
    loginBtn.style.display = '';
    refreshBtn.style.display = 'none';
    $('#downloadBtn').disabled = true;
    $('#sidebarFooter').style.display = 'none';
    $('#courseList').innerHTML = `
      <div class="sidebar-empty">
        <div class="sidebar-empty-icon">🔐</div>
        <div class="sidebar-empty-title">请登录 CNMOOC 账号</div>
        <div class="sidebar-empty-desc">点击按钮，将弹出 Chromium 完成 Jaccount 扫码登录</div>
        <button class="btn btn-primary" onclick="document.getElementById('loginBtn').click()">登录 Jaccount</button>
      </div>`;
  }
}

// ===== login =====
async function startLogin() {
  if (loginRequested) return;
  loginRequested = true;
  showOverlay('正在登录', '请在弹出的 Chromium 中完成 Jaccount 扫码登录');
  try {
    const res = await fetch('/api/login', { method: 'POST' });
    if (res.status === 409) addLog('warn', '后端已在登录中，忽略重复请求');
  } catch (err) {
    hideOverlay();
    addLog('err', '登录请求失败: ' + err.message);
    loginRequested = false;
  }
}
$('#loginBtn').onclick = () => startLogin();

// ===== courses =====
function showCoursesLoading() {
  $('#sidebarFooter').style.display = 'none';
  $('#courseList').innerHTML = `
    <div class="sidebar-empty">
      <div class="spinner" style="margin:0 auto 16px"></div>
      <div class="sidebar-empty-title">正在加载课程...</div>
      <div class="sidebar-empty-desc">首次加载需要几秒钟</div>
    </div>`;
}

async function loadCourses() {
  showCoursesLoading();
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.courses) {
      courses = data.courses;
      renderCourses();
      updateDownloadBtn();
    }
  } catch (err) {
    addLog('err', '加载课程失败: ' + err.message);
  }
}

$('#refreshBtn').onclick = () => {
  courses = [];
  courseSelection.clear();
  expandedCourses.clear();
  loadCourses();
};

// ===== selection state helpers =====
function getCourseState(courseId) { return courseSelection.get(courseId) ?? 'none'; }
function isCourseChecked(courseId) { return getCourseState(courseId) !== 'none'; }
function isCourseIndeterminate(courseId) { return getCourseState(courseId) instanceof Set; }
function isChapterSelected(courseId, chapter) {
  const s = getCourseState(courseId);
  if (s === 'all') return true;
  if (s === 'none') return false;
  return s.has(chapter);
}

function toggleCourse(courseId) {
  const s = getCourseState(courseId);
  if (s === 'none') {
    courseSelection.set(courseId, 'all');
    ensureChaptersLoaded(courseId);
  } else {
    courseSelection.set(courseId, 'none');
  }
  syncSelectionDOM();
  updateDownloadBtn();
}

function toggleChapter(courseId, chapter) {
  const course = courses.find(c => c.courseId === courseId);
  if (!course?.chapters) return;
  const allCh = course.chapters.map(ch => ch.chapter);
  let s = getCourseState(courseId);

  let set;
  if (s === 'all') {
    set = new Set(allCh);
    set.delete(chapter);
  } else if (s === 'none') {
    set = new Set([chapter]);
  } else {
    set = new Set(s);
    if (set.has(chapter)) set.delete(chapter);
    else set.add(chapter);
  }

  if (set.size === 0) courseSelection.set(courseId, 'none');
  else if (set.size === allCh.length) courseSelection.set(courseId, 'all');
  else courseSelection.set(courseId, set);

  syncSelectionDOM();
  updateDownloadBtn();
}

// targeted DOM sync — no innerHTML rebuild, so other checkboxes don't re-animate
function syncSelectionDOM() {
  for (const card of $$('.course-card[data-cid]')) {
    const cid = card.dataset.cid;
    card.classList.toggle('selected', isCourseChecked(cid));
    const cb = card.querySelector('.cb[data-action="course"]');
    if (cb) {
      const chk = isCourseChecked(cid);
      const ind = isCourseIndeterminate(cid);
      if (cb.checked !== chk) cb.checked = chk;
      if (cb.indeterminate !== ind) cb.indeterminate = ind;
    }
    for (const chCb of card.querySelectorAll('.cb[data-action="chapter-cb"]')) {
      const isSel = isChapterSelected(cid, chCb.dataset.ch);
      if (chCb.checked !== isSel) chCb.checked = isSel;
    }
  }
}

function popAnimate(el) {
  if (!el) return;
  el.classList.remove('pop');
  void el.offsetWidth; // force restart
  el.classList.add('pop');
}

function updateDownloadBtn() {
  let selectedCourses = 0;
  let selectedChapterCount = 0;
  let totalChapters = 0;
  for (const c of courses) {
    const s = getCourseState(c.courseId);
    if (s === 'none') continue;
    selectedCourses++;
    if (c.chapters) {
      totalChapters += c.chapters.length;
      if (s === 'all') selectedChapterCount += c.chapters.length;
      else if (s instanceof Set) selectedChapterCount += s.size;
    }
  }
  $('#downloadBtn').disabled = selectedCourses === 0;

  // selection summary text near download button
  $('#selectionSummary').innerHTML = selectedCourses
    ? `已选 <strong>${selectedCourses}</strong> 门课程${selectedChapterCount ? ` · <strong>${selectedChapterCount}</strong> 章节` : ''}`
    : '';

  // sidebar footer
  const footer = $('#sidebarFooter');
  if (courses.length) {
    footer.style.display = '';
    $('#selectedCountText').textContent = selectedCourses;
    $('#totalCountText').textContent = `共 ${courses.length} 门`;
  } else {
    footer.style.display = 'none';
  }
}

// ===== chapter lazy load =====
async function ensureChaptersLoaded(courseId) {
  const course = courses.find(c => c.courseId === courseId);
  if (!course || course.chapters) return;
  try {
    const res = await fetch(`/api/courses/${courseId}/chapters`);
    course.chapters = await res.json();
    // only update the affected card's chapter list — don't rebuild whole sidebar
    updateChapterListDOM(courseId);
    syncSelectionDOM();
    updateDownloadBtn();
  } catch (err) {
    addLog('err', `加载章节失败: ${err.message}`);
  }
}

function updateChapterListDOM(courseId) {
  const card = $('#courseList').querySelector(`.course-card[data-cid="${CSS.escape(courseId)}"]`);
  if (!card) return;
  const course = courses.find(c => c.courseId === courseId);
  const list = card.querySelector('.chapter-list');
  if (!course?.chapters?.length) {
    list.innerHTML = '<div class="chapter-loading">加载章节中...</div>';
    return;
  }
  const cid = escAttr(courseId);
  list.innerHTML = course.chapters.map(ch => `
    <div class="chapter-item" data-action="chapter" data-cid="${cid}" data-ch="${escAttr(ch.chapter)}">
      <input type="checkbox" class="cb" data-action="chapter-cb" data-cid="${cid}" data-ch="${escAttr(ch.chapter)}">
      <span class="chapter-name">${escHtml(ch.chapter)}</span>
      <span class="chapter-count">${ch.items?.length || 0}</span>
    </div>`).join('');
  // update total count badge
  const total = course.chapters.reduce((s, ch) => s + (ch.items?.length || 0), 0);
  const header = card.querySelector('.course-header');
  let countEl = header.querySelector('.course-count');
  if (total) {
    if (!countEl) {
      countEl = document.createElement('span');
      countEl.className = 'course-count';
      header.appendChild(countEl);
    }
    countEl.textContent = total;
  } else if (countEl) {
    countEl.remove();
  }
}

function toggleExpand(courseId) {
  const card = $('#courseList').querySelector(`.course-card[data-cid="${CSS.escape(courseId)}"]`);
  if (!card) return;
  if (expandedCourses.has(courseId)) {
    expandedCourses.delete(courseId);
    card.classList.remove('open');
  } else {
    expandedCourses.add(courseId);
    card.classList.add('open');
    ensureChaptersLoaded(courseId);
  }
}

// ===== render =====
function renderCourses() {
  const container = $('#courseList');
  if (!courses.length) {
    container.innerHTML = `
      <div class="sidebar-empty">
        <div class="sidebar-empty-icon">📭</div>
        <div class="sidebar-empty-title">暂无课程</div>
        <div class="sidebar-empty-desc">点击右上角「刷新」重试</div>
      </div>`;
    return;
  }

  container.innerHTML = courses.map(c => {
    const selected = isCourseChecked(c.courseId);
    const expanded = expandedCourses.has(c.courseId);
    const chapters = c.chapters || [];
    const total = chapters.reduce((s, ch) => s + (ch.items?.length || 0), 0);
    const cid = escAttr(c.courseId);

    return `
      <div class="course-card ${expanded ? 'open' : ''} ${selected ? 'selected' : ''}" data-cid="${cid}">
        <div class="course-header" data-action="expand" data-cid="${cid}">
          <input type="checkbox" class="cb" data-action="course" data-cid="${cid}">
          <span class="course-arrow">▶</span>
          <span class="course-name">${escHtml(c.name)}</span>
          ${total ? `<span class="course-count">${total}</span>` : ''}
        </div>
        <div class="chapter-list">
          ${chapters.length === 0 && expanded
            ? '<div class="chapter-loading">加载章节中...</div>'
            : chapters.map(ch => `
              <div class="chapter-item" data-action="chapter" data-cid="${cid}" data-ch="${escAttr(ch.chapter)}">
                <input type="checkbox" class="cb" data-action="chapter-cb" data-cid="${cid}" data-ch="${escAttr(ch.chapter)}">
                <span class="chapter-name">${escHtml(ch.chapter)}</span>
                <span class="chapter-count">${ch.items?.length || 0}</span>
              </div>
            `).join('')
          }
        </div>
      </div>`;
  }).join('');

  // sync indeterminate / checked states after innerHTML rebuild
  for (const cb of $$('.cb[data-action="course"]')) {
    const cid = cb.dataset.cid;
    cb.checked = isCourseChecked(cid);
    cb.indeterminate = isCourseIndeterminate(cid);
  }
  for (const cb of $$('.cb[data-action="chapter-cb"]')) {
    cb.checked = isChapterSelected(cb.dataset.cid, cb.dataset.ch);
  }
}

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// event delegation
$('#courseList').addEventListener('click', (e) => {
  const t = e.target;
  if (t.dataset.action === 'course') {
    e.stopPropagation();
    popAnimate(t);
    toggleCourse(t.dataset.cid);
    return;
  }
  if (t.dataset.action === 'chapter-cb') {
    e.stopPropagation();
    popAnimate(t);
    toggleChapter(t.dataset.cid, t.dataset.ch);
    return;
  }
  const chapterRow = t.closest('[data-action="chapter"]');
  if (chapterRow) {
    popAnimate(chapterRow.querySelector('.cb'));
    toggleChapter(chapterRow.dataset.cid, chapterRow.dataset.ch);
    return;
  }
  const courseRow = t.closest('[data-action="expand"]');
  if (courseRow) {
    toggleExpand(courseRow.dataset.cid);
  }
});

$('#incremental').addEventListener('click', (e) => popAnimate(e.currentTarget));

// ===== prep (URL probing) phase =====
let prepStart = 0;
function showPrepCard(total) {
  prepStart = Date.now();
  const safeTotal = Number.isFinite(+total) ? Math.max(0, Math.floor(+total)) : 0;
  const area = $('#downloadArea');
  // Static skeleton only — no interpolation of WS-sourced values into innerHTML.
  area.innerHTML = `
    <div class="prep-card" id="prepCard">
      <div class="prep-orbit">
        <div class="prep-orbit-ring"></div>
        <div class="prep-orbit-ring r2"></div>
        <div class="prep-orbit-ring r3"></div>
        <div class="prep-orbit-core">⏳</div>
      </div>
      <div class="prep-title">正在准备下载</div>
      <div class="prep-sub" id="prepSub"></div>
      <div class="prep-bar"><div class="prep-bar-fill" id="prepFill" style="width:0%"></div></div>
      <div class="prep-hint">正在为每个课件解析下载地址，避免触发限流。下载阶段会更快。</div>
    </div>`;
  // Dynamic text goes via textContent so HTML in user-supplied values can't execute.
  $('#prepSub').textContent = `已处理 0 / ${safeTotal} · 预计 …`;
}
}

function updatePrepCard(processed, total) {
  const fill = $('#prepFill');
  const sub = $('#prepSub');
  if (!fill || !sub) return;
  const pct = total ? Math.round(processed / total * 100) : 0;
  fill.style.width = pct + '%';
  const elapsed = (Date.now() - prepStart) / 1000;
  const remaining = total - processed;
  const avgPer = processed > 0 ? elapsed / processed : 0;
  const etaSec = remaining * avgPer;
  const etaStr = avgPer > 0 ? `预计 ${formatTime(etaSec)}` : '预计 …';
  sub.textContent = `已处理 ${processed} / ${total} · ${pct}% · ${etaStr}`;
}

function finishPrepCard(total) {
  const sub = $('#prepSub');
  if (sub) sub.textContent = `准备完成，开始下载 ${total} 个文件...`;
  setTimeout(() => {
    const card = $('#prepCard');
    if (card) card.style.opacity = '0';
  }, 400);
}

// ===== download =====
$('#downloadBtn').onclick = async () => {
  const rt = $('#resourceType').value;
  const resourceTypes = rt === 'all' ? ['video', 'document'] : [rt];
  const concurrency = parseInt($('#concurrency').value, 10) || 3;
  const retryCount = parseInt($('#retryCount').value, 10) || 3;
  const incremental = $('#incremental').checked;

  const courseIds = [];
  const chapterFilter = {};
  for (const [cid, state] of courseSelection) {
    if (state === 'none') continue;
    courseIds.push(cid);
    if (state instanceof Set) chapterFilter[cid] = [...state];
  }
  if (!courseIds.length) return;

  $('#downloadBtn').disabled = true;
  $('#downloadArea').innerHTML = '<div class="download-empty"><div class="download-empty-icon">⏳</div><div class="download-empty-title">准备中...</div></div>';

  try {
    await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courseIds,
        selectedChapters: chapterFilter,
        resourceTypes,
        concurrency,
        retryCount,
        incremental,
      }),
    });
  } catch (err) {
    addLog('err', '下载请求失败: ' + err.message);
    $('#downloadBtn').disabled = false;
  }
};

// idle | downloading | paused
function setControlState(state) {
  const dlBtn = $('#downloadBtn');
  const pauseBtn = $('#pauseBtn');
  const resumeBtn = $('#resumeBtn');
  const cancelBtn = $('#cancelBtn');
  if (state === 'idle') {
    dlBtn.style.display = '';
    dlBtn.disabled = [...courseSelection.values()].every(s => s === 'none');
    pauseBtn.style.display = 'none';
    resumeBtn.style.display = 'none';
    cancelBtn.style.display = 'none';
  } else if (state === 'downloading') {
    dlBtn.style.display = 'none';
    pauseBtn.style.display = '';
    resumeBtn.style.display = 'none';
    cancelBtn.style.display = '';
  } else if (state === 'paused') {
    dlBtn.style.display = 'none';
    pauseBtn.style.display = 'none';
    resumeBtn.style.display = '';
    cancelBtn.style.display = '';
  }
}

$('#pauseBtn').onclick = async () => {
  try { await fetch('/api/pause', { method: 'POST' }); }
  catch (err) { addLog('err', '暂停失败: ' + err.message); }
};
$('#resumeBtn').onclick = async () => {
  try { await fetch('/api/resume', { method: 'POST' }); }
  catch (err) { addLog('err', '继续失败: ' + err.message); }
};
$('#cancelBtn').onclick = async () => {
  if (!confirm('确定取消下载吗？已下载的部分会保留在磁盘上，下次可断点续传。')) return;
  try { await fetch('/api/cancel', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' }); }
  catch (err) { addLog('err', '取消失败: ' + err.message); }
};

// ===== download progress cards =====
const progressCards = new Map(); // id -> { card, lastDownloaded, lastTime, speed }

function initDownloadCards() {
  $('#downloadArea').innerHTML = '';
  progressCards.clear();
}

function updateDownloadCard(msg) {
  const { itemId, title, filename, event } = msg;
  const id = itemId || filename;
  const area = $('#downloadArea');
  const empty = $('#downloadEmpty');
  if (empty) empty.remove();

  if (event === 'start') {
    const card = document.createElement('div');
    card.className = 'download-card';
    card.id = 'card-' + id;
    const sizeStr = msg.total ? formatSize(msg.total) : '?';
    card.innerHTML = `
      <div class="title">${escHtml(title || filename)}</div>
      <div class="meta">
        <span class="meta-progress">0 B / ${sizeStr}</span>
        <span class="meta-speed">—</span>
        <span class="meta-eta">—</span>
      </div>
      <div class="progress-bar"><div class="fill" style="width:0%"></div></div>`;
    area.insertBefore(card, area.firstChild);
    progressCards.set(id, { card, lastDownloaded: 0, lastTime: Date.now(), speed: 0 });
  } else if (event === 'progress') {
    const state = progressCards.get(id);
    if (!state) return;
    const now = Date.now();
    const dt = (now - state.lastTime) / 1000;
    if (dt > 0.05) {
      const inst = (msg.downloaded - state.lastDownloaded) / dt; // B/s
      state.speed = state.speed > 0 ? state.speed * 0.7 + inst * 0.3 : inst;
      state.lastDownloaded = msg.downloaded;
      state.lastTime = now;
    }

    const pct = msg.total ? Math.round(msg.downloaded / msg.total * 100) : 0;
    const remaining = Math.max(0, (msg.total || 0) - msg.downloaded);
    const etaSec = state.speed > 0.5 ? remaining / state.speed : 0;

    const fill = state.card.querySelector('.fill');
    fill.style.width = pct + '%';
    state.card.querySelector('.meta-progress').textContent =
      `${formatSize(msg.downloaded)} / ${formatSize(msg.total)} · ${pct}%`;
    state.card.querySelector('.meta-speed').textContent = formatSpeed(state.speed);
    state.card.querySelector('.meta-eta').textContent = etaSec > 0 ? `剩余 ${formatTime(etaSec)}` : '—';
  } else if (event === 'done') {
    const state = progressCards.get(id);
    if (state) {
      const fill = state.card.querySelector('.fill');
      fill.classList.add('done');
      fill.style.width = '100%';
      state.card.querySelector('.meta').innerHTML =
        `<span class="badge done">已完成</span><span>${formatSize(msg.size)}</span>`;
    }
  } else if (event === 'paused') {
    const state = progressCards.get(id);
    if (state) {
      const fill = state.card.querySelector('.fill');
      fill.classList.add('skip');
      state.card.querySelector('.meta').innerHTML =
        `<span class="badge skip">已暂停</span><span>${formatSize(msg.downloaded)} / ${formatSize(msg.total)}</span>`;
    }
  } else if (event === 'error') {
    const state = progressCards.get(id);
    if (state) {
      const fill = state.card.querySelector('.fill');
      fill.classList.add('error');
      fill.style.width = '100%';
      state.card.querySelector('.meta').innerHTML =
        `<span class="badge error">失败</span><span>${escHtml(msg.error || '')}</span>`;
    }
  } else if (event === 'skip') {
    const card = document.createElement('div');
    card.className = 'download-card';
    card.innerHTML = `
      <div class="title">${escHtml(filename)}</div>
      <div class="meta"><span class="badge skip">已跳过</span><span>${escHtml(msg.reason || '')}</span></div>
      <div class="progress-bar"><div class="fill skip" style="width:100%"></div></div>`;
    area.insertBefore(card, area.firstChild);
    progressCards.set(id, { card });
  }
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

function formatSpeed(bps) {
  if (!bps || bps < 1) return '—';
  return formatSize(bps) + '/s';
}

function formatTime(sec) {
  if (!sec || !isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// ===== overlay =====
function showOverlay(title, msg) {
  $('#overlayTitle').textContent = title;
  $('#overlayMsg').textContent = msg;
  $('#overlay').classList.remove('hidden');
}
function hideOverlay() { $('#overlay').classList.add('hidden'); }

// ===== init =====
checkStatus();
