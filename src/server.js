import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { ensureAuthenticated, isSessionValid, STORAGE_STATE_PATH, hasStoredSession } from './auth.js';
import { fetchCourses } from './courses.js';
import { fetchChapters } from './chapters.js';
import { fetchResourceUrl } from './resources.js';
import { downloadFile } from './downloader.js';
import { jitter, ConcurrencyPool, setLogHandler } from './utils.js';
import { loadConfig, classifyResourceUrl } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const PORT = 3456;
// Bind to loopback only by default so other machines on the same LAN can't
// hit the API (would let them browse our courses, trigger downloads, etc.).
// Set CNMOOC_BIND=0.0.0.0 explicitly to expose externally.
const HOST = process.env.CNMOOC_BIND || '127.0.0.1';

// ---------------------------------------------------------------------------
// WebSocket & log routing
// ---------------------------------------------------------------------------
const clients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

setLogHandler((level, message) => {
  broadcast({ type: 'log', level, message });
});

// ---------------------------------------------------------------------------
// Download state
// ---------------------------------------------------------------------------
// Download state + session
// ---------------------------------------------------------------------------
let downloadState = { running: false, completed: 0, errors: 0, total: 0 };

// Current download session — supports pause/resume/cancel
let session = null;

function resetDownloadState(taskCount) {
  downloadState = { running: true, completed: 0, errors: 0, total: taskCount };
  broadcast({ type: 'download-begin', total: taskCount });
}

function markTaskDone() {
  downloadState.completed++;
  broadcast({ type: 'download-progress-summary', completed: downloadState.completed, total: downloadState.total });
}

function markTaskError() {
  downloadState.errors++;
}

function finishDownload() {
  downloadState.running = false;
  session = null;
  broadcast({ type: 'download-end', completed: downloadState.completed, errors: downloadState.errors });
}

function finishDownloadCancelled() {
  downloadState.running = false;
  const cancelled = session?.tasks.filter((t) => t.state === 'cancelled').length || 0;
  session = null;
  broadcast({ type: 'download-cancelled', completed: downloadState.completed, errors: downloadState.errors, cancelled });
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// --- GET /api/status ---
app.get('/api/status', async (_req, res) => {
  try {
    let loggedIn = false;
    let courses = [];
    if (hasStoredSession()) {
      const b = await chromium.launch({ headless: true });
      try {
        const valid = await isSessionValid(b);
        if (valid) {
          loggedIn = true;
          const ctx = await b.newContext({ storageState: STORAGE_STATE_PATH });
          courses = await fetchCourses(ctx);
          await ctx.close();
        }
      } catch { /* session may be stale */ }
      await b.close();
    }
    res.json({ loggedIn, courses, downloadRunning: downloadState.running });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /api/login ---
let loginInProgress = false;
app.post('/api/login', async (_req, res) => {
  if (loginInProgress) {
    res.status(409).json({ error: 'Login already in progress' });
    broadcast({ type: 'log', level: 'warn', message: '登录请求已在进行中，忽略重复触发' });
    return;
  }
  loginInProgress = true;
  res.json({ status: 'started' });
  try {
    await ensureAuthenticated({ forceRelogin: true });
    broadcast({ type: 'login-ok' });
  } catch (err) {
    broadcast({ type: 'login-error', error: err.message });
  } finally {
    loginInProgress = false;
  }
});

// --- GET /api/courses/:id/chapters ---
app.get('/api/courses/:id/chapters', async (req, res) => {
  try {
    const b = await chromium.launch({ headless: true });
    const ctx = await b.newContext({ storageState: STORAGE_STATE_PATH });
    const api = ctx.request;
    const chapters = await fetchChapters(api, req.params.id);
    await ctx.close();
    await b.close();
    res.json(chapters);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /api/download ---
app.post('/api/download', async (req, res) => {
  if (downloadState.running) {
    res.status(409).json({ error: 'Download already in progress' });
    return;
  }

  const { courseIds, selectedChapters, resourceTypes, concurrency, incremental } = req.body;
  const config = loadConfig({
    resourceTypes: resourceTypes || undefined,
    concurrency: concurrency || undefined,
    retryCount: req.body.retryCount || undefined,
  });

  res.json({ status: 'started' });

  // Run download asynchronously
  runDownload(courseIds, config, incremental, selectedChapters).catch((err) => {
    broadcast({ type: 'log', level: 'err', message: `Fatal: ${err.message}` });
    finishDownload();
  });
});

// --- POST /api/pause ---
app.post('/api/pause', (_req, res) => {
  if (!session || session.paused) {
    res.status(409).json({ error: 'No active session to pause' });
    return;
  }
  session.paused = true;
  for (const ac of session.controllers.values()) ac.abort();
  broadcast({ type: 'download-paused' });
  broadcast({ type: 'log', level: 'warn', message: '已暂停下载' });
  res.json({ ok: true });
});

// --- POST /api/resume ---
app.post('/api/resume', async (_req, res) => {
  if (!session || !session.paused) {
    res.status(409).json({ error: 'No paused session to resume' });
    return;
  }
  res.json({ ok: true });
  session.paused = false;
  broadcast({ type: 'download-resumed' });
  broadcast({ type: 'log', level: 'step', message: '继续下载...' });
  try {
    await runPendingTasks(session);
  } catch (err) {
    broadcast({ type: 'log', level: 'err', message: `Resume failed: ${err.message}` });
  }
});

// --- POST /api/cancel ---
app.post('/api/cancel', (req, res) => {
  if (!session) {
    res.status(409).json({ error: 'No active session to cancel' });
    return;
  }
  const deletePartial = req.body?.deletePartial === true;
  session.cancelled = true;
  session.paused = false;
  for (const t of session.tasks) {
    if (t.state === 'pending' || t.state === 'paused' || t.state === 'downloading') {
      t.state = 'cancelled';
    }
  }
  for (const ac of session.controllers.values()) ac.abort();
  if (deletePartial) {
    // best-effort partial file cleanup happens client-side via /api/cleanup; here just mark
    broadcast({ type: 'log', level: 'warn', message: '已取消下载（保留已下载部分）' });
  } else {
    broadcast({ type: 'log', level: 'warn', message: '已取消下载（保留已下载部分）' });
  }
  finishDownloadCancelled();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Download orchestrator (same logic as CLI, but talks WebSocket)
// ---------------------------------------------------------------------------
async function runDownload(courseIds, config, incremental, selectedChapters) {
  const snapshot = incremental ? loadSnapshot() : null;
  const downloadTasks = [];

  try {
    const b = await chromium.launch({ headless: true });
    const ctx = await b.newContext({ storageState: STORAGE_STATE_PATH });
    const api = ctx.request;

    let courses = await fetchCourses(ctx);
    if (courseIds && courseIds.length) {
      courses = courses.filter((c) => courseIds.includes(c.courseId));
    }

    if (!courses.length) {
      broadcast({ type: 'log', level: 'warn', message: 'No courses found.' });
      await ctx.close();
      await b.close();
      finishDownload();
      return;
    }

    // Pass 1: fetch chapters for every selected course
    broadcast({ type: 'log', level: 'step', message: `正在获取 ${courses.length} 门课程的章节...` });
    const courseChapterPairs = [];
    for (const course of courses) {
      const chapters = await fetchChapters(api, course.courseId);
      courseChapterPairs.push({ course, chapters });
    }

    // Pass 2: build flat list of items to probe, applying chapter + snapshot filters
    const probeItems = [];
    for (const { course, chapters } of courseChapterPairs) {
      const chSel = selectedChapters?.[course.courseId];
      for (const { chapter, items } of chapters) {
        if (!items.length) continue;
        if (Array.isArray(chSel) && !chSel.includes(chapter)) continue;
        const excluded = config.excludeChapters.some((p) => {
          try { return new RegExp(p, 'i').test(chapter); } catch { return false; }
        });
        if (excluded) continue;
        for (const item of items) {
          if (snapshot && snapshot[course.courseId]?.includes(item.itemId)) continue;
          probeItems.push({ course, chapter, item });
        }
      }
    }

    if (!probeItems.length) {
      broadcast({ type: 'log', level: 'ok', message: '没有可下载的内容。' });
      await ctx.close();
      await b.close();
      finishDownload();
      return;
    }

    // Pass 3: probe URLs (prep phase) — emit progress so GUI can show ETA
    broadcast({ type: 'prep-begin', total: probeItems.length });
    let processed = 0;
    for (const { course, chapter, item } of probeItems) {
      await jitter(config.jitterMin, config.jitterMax);
      const url = await fetchResourceUrl(api, item, { retryCount: config.retryCount });
      processed++;
      broadcast({ type: 'prep-progress', processed, total: probeItems.length });
      if (!url) continue;
      const type = classifyResourceUrl(url);
      if (!config.resourceTypes.includes(type)) continue;
      downloadTasks.push({
        url,
        courseName: course.name,
        chapterName: chapter,
        title: item.title,
        courseId: course.courseId,
        itemId: item.itemId,
      });
    }
    broadcast({ type: 'prep-end', total: downloadTasks.length });

    await ctx.close();
    await b.close();

    if (!downloadTasks.length) {
      broadcast({ type: 'log', level: 'ok', message: '没有可下载的内容。' });
      finishDownload();
      return;
    }

    // Phase 2: build session and run pending tasks
    resetDownloadState(downloadTasks.length);
    session = {
      tasks: downloadTasks.map((t) => ({ ...t, state: 'pending' })),
      pool: new ConcurrencyPool(config.concurrency),
      controllers: new Map(), // itemId -> AbortController
      paused: false,
      cancelled: false,
      config,
      incremental,
      snapshot,
      courses,
    };

    await runPendingTasks(session);

    if (!session) return; // cancelled already finished

    // Phase 3: update snapshot
    if (incremental) {
      for (const course of courses) {
        const ids = downloadTasks
          .filter((t) => t.courseId === course.courseId)
          .map((t) => t.itemId);
        if (ids.length) {
          saveSnapshotItem(course.courseId, [...(snapshot[course.courseId] || []), ...ids]);
        }
      }
    }

    finishDownload();
  } catch (err) {
    broadcast({ type: 'log', level: 'err', message: err.message });
    finishDownload();
  }
}

// Run all tasks currently in 'pending' or 'paused' state. Called once on initial start and again on resume.
async function runPendingTasks(s) {
  const promises = s.tasks
    .filter((t) => t.state === 'pending' || t.state === 'paused')
    .map((t) => s.pool.run(() => runOneTask(s, t)));
  await Promise.all(promises);
}

async function runOneTask(s, t) {
  if (s.cancelled || s.paused || t.state === 'done' || t.state === 'cancelled') return;

  t.state = 'downloading';
  const ac = new AbortController();
  s.controllers.set(t.itemId, ac);
  let lastProgressSent = 0;

  try {
    await downloadFile(
      { url: t.url, courseName: t.courseName, chapterName: t.chapterName, title: t.title },
      {
        retryCount: s.config.retryCount,
        signal: ac.signal,
        onProgress: (p) => {
          if (p.event === 'progress') {
            const now = Date.now();
            if (now - lastProgressSent < 200 && p.downloaded < p.total) return;
            lastProgressSent = now;
          }
          broadcast({
            type: 'download-progress',
            itemId: t.itemId,
            title: t.title,
            ...p,
          });
          if (p.event === 'done' || p.event === 'skip') markTaskDone();
          if (p.event === 'error') markTaskError();
        },
      },
    );
    t.state = 'done';
  } catch (err) {
    if (err.name === 'AbortError' || ac.signal.aborted) {
      t.state = s.cancelled ? 'cancelled' : 'paused';
    } else {
      t.state = 'error';
      markTaskError();
    }
  } finally {
    s.controllers.delete(t.itemId);
  }
}

// ---------------------------------------------------------------------------
// Snapshot helpers (duplicated from index.js for independence)
// ---------------------------------------------------------------------------
const SNAPSHOT_PATH = path.resolve('.snapshot.json');

function loadSnapshot() {
  try {
    if (fs.existsSync(SNAPSHOT_PATH)) {
      return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function saveSnapshotItem(courseId, itemIds) {
  const snapshot = loadSnapshot();
  snapshot[courseId] = [...new Set(itemIds)].sort();
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

server.listen(PORT, HOST, () => {
  console.log(`\n  CNMOOC Downloader GUI 已启动`);
  console.log(`  打开浏览器访问: http://localhost:${PORT}\n`);

  if (process.env.CNMOOC_NO_OPEN) return;

  // Try to open browser automatically
  const url = `http://localhost:${PORT}`;
  const platform = process.platform;
  if (platform === 'win32') {
    import('node:child_process').then(({ exec }) => exec(`start "" "${url}"`));
  } else if (platform === 'darwin') {
    import('node:child_process').then(({ exec }) => exec(`open "${url}"`));
  } else {
    import('node:child_process').then(({ exec }) => exec(`xdg-open "${url}"`));
  }
});
