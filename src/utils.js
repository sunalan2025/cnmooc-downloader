const BASE_URL = 'https://cnmooc.sjtu.cn';

const INVALID_PATH_CHARS = /[\\/:*?"<>|\r\n\t]/g;
const TRAILING_DOTS_SPACES = /[ .]+$/;

export function sanitizeName(name, fallback = 'untitled') {
  if (!name) return fallback;
  let cleaned = String(name)
    .replace(INVALID_PATH_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TRAILING_DOTS_SPACES, '');
  if (cleaned.length > 120) cleaned = cleaned.slice(0, 120).trim();
  return cleaned || fallback;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function jitter(minMs = 400, maxMs = 1000) {
  const delay = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
  return sleep(delay);
}

export async function retry(fn, { maxAttempts = 3, baseDelay = 1000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      log.warn(`  Retry ${attempt}/${maxAttempts} in ${delay}ms... (${err.message})`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export class ConcurrencyPool {
  constructor(limit) {
    this.limit = limit;
    this.running = 0;
    this.waiters = [];
  }

  async run(fn) {
    if (this.running >= this.limit) {
      await new Promise((resolve) => {
        this.waiters.push(resolve);
      });
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      if (this.waiters.length > 0) {
        this.waiters.shift()();
      }
    }
  }
}

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const LEVEL_CONFIG = {
  info: { color: 'cyan', label: 'INFO' },
  ok: { color: 'green', label: ' OK ' },
  warn: { color: 'yellow', label: 'WARN' },
  err: { color: 'red', label: 'ERR ' },
  skip: { color: 'dim', label: 'SKIP' },
  step: { color: 'blue', label: '==>' },
};

let _logHandler = null;

export function setLogHandler(handler) {
  _logHandler = handler;
}

function emitLog(level, msg) {
  if (_logHandler) {
    _logHandler(level, msg);
  } else {
    const cfg = LEVEL_CONFIG[level] || { color: 'reset', label: level };
    console.log(`${COLORS[cfg.color]}[${cfg.label}]${COLORS.reset} ${msg}`);
  }
}

export const log = {
  info: (msg) => emitLog('info', msg),
  ok: (msg) => emitLog('ok', msg),
  warn: (msg) => emitLog('warn', msg),
  err: (msg) => emitLog('err', msg),
  skip: (msg) => emitLog('skip', msg),
  step: (msg) => emitLog('step', msg),
};

export function resolveUrl(maybeRelative) {
  if (!maybeRelative) return null;
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  if (maybeRelative.startsWith('//')) return 'https:' + maybeRelative;
  if (maybeRelative.startsWith('/')) return BASE_URL + maybeRelative;
  return BASE_URL + '/' + maybeRelative;
}

export function inferExtension(url, fallback = '') {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.([a-z0-9]{1,5})$/i);
    if (m) return '.' + m[1].toLowerCase();
  } catch {}
  return fallback;
}

export { BASE_URL };
