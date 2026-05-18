import * as cheerio from 'cheerio';
import fs from 'node:fs';
import { BASE_URL, log, resolveUrl, retry } from './utils.js';
import { STORAGE_STATE_PATH } from './auth.js';

const PLAY_URL = `${BASE_URL}/study/play.mooc`;
const DETAIL_URL = `${BASE_URL}/item/detail.mooc`;

// Read postoken from the cpstk cookie in storageState.json
function readPostoken() {
  try {
    const state = JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, 'utf8'));
    return state.cookies?.find((c) => c.name === 'cpstk')?.value || '';
  } catch {
    return '';
  }
}

// itemTypes that represent quizzes/tests with no downloadable file
// (chapters.js already filters these out; kept as a safety net)
const QUIZ_TYPES = new Set(['30', '50', '60']);

export async function fetchResourceUrl(apiContext, { itemId, itemType, title }, { retryCount = 3 } = {}) {
  if (QUIZ_TYPES.has(String(itemType))) return null;

  const postoken = readPostoken();
  const referer = `${BASE_URL}/study/initplay/${itemId}.mooc`;
  const ajaxHeaders = { 'X-Requested-With': 'XMLHttpRequest', Referer: referer };

  const fetchUrl = async () => {
    // Step 1: POST play.mooc to get nodeId for this item
    const playResp = await apiContext.post(PLAY_URL, {
      form: { itemId, itemType, testPaperId: '', postoken },
      headers: ajaxHeaders,
      failOnStatusCode: false,
    });
    if (playResp.status() !== 200) {
      throw new Error(`play.mooc returned HTTP ${playResp.status()}`);
    }
    const playHtml = await playResp.text();
    const nodeIdMatch = playHtml.match(/id="nodeId"\s+value="(\d+)"/);
    const nodeId = nodeIdMatch?.[1];
    if (!nodeId) {
      throw new Error('no nodeId in play.mooc response');
    }

    // Step 2: POST item/detail.mooc to get file URL
    const detailResp = await apiContext.post(DETAIL_URL, {
      form: { nodeId, itemId, postoken },
      headers: { ...ajaxHeaders, Accept: 'application/json, text/javascript, */*; q=0.01' },
      failOnStatusCode: false,
    });
    if (detailResp.status() !== 200) {
      throw new Error(`item/detail.mooc returned HTTP ${detailResp.status()}`);
    }
    const detail = await detailResp.json();
    const node = detail.node || {};
    const staticBase = detail.path || `https://static.cnmooc.sjtu.cn`;
    const flvUrl = node.flvUrl || '';
    const rsUrl = node.rsUrl || '';

    // flvUrl is absolute for videos; rsUrl is relative for documents (PDF, PPT, etc.)
    if (flvUrl.startsWith('http')) return flvUrl;
    if (rsUrl) return staticBase + rsUrl;
    if (flvUrl) return resolveUrl(flvUrl);
    throw new Error('no downloadable URL in detail response');
  };

  try {
    return await retry(fetchUrl, { maxAttempts: retryCount, baseDelay: 1000 });
  } catch (err) {
    log.warn(`  [skip] ${title}: ${err.message}`);
    return null;
  }
}
