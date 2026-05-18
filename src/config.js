import fs from 'node:fs';
import path from 'node:path';

const CONFIG_PATH = path.resolve('config.json');

const DEFAULTS = {
  concurrency: 3,
  retryCount: 3,
  resourceTypes: ['video', 'document'],
  excludeChapters: [],
  jitterMin: 300,
  jitterMax: 800,
};

export function loadConfig(cliOverrides = {}) {
  let fileConfig = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn(`Warning: failed to parse config.json: ${e.message}`);
  }
  return { ...DEFAULTS, ...fileConfig, ...cliOverrides };
}

export function classifyResourceUrl(url) {
  if (!url) return null;
  const lower = url.toLowerCase();
  if (/\.(mp4|flv|webm|mkv|avi|mov|wmv|m4v)(\?|$)/i.test(lower)) return 'video';
  if (/\.(pdf|ppt|pptx|doc|docx|xls|xlsx|txt|zip|rar)(\?|$)/i.test(lower)) return 'document';
  if (url.includes('static.cnmooc.sjtu.cn')) return 'document';
  return 'video';
}
