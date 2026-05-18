import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { BASE_URL, log, sleep } from './utils.js';

const STORAGE_STATE_PATH = path.resolve('storageState.json');
const MY_COURSES_URL = `${BASE_URL}/portal/myCourseIndex/1.mooc`;
const LOGIN_URL = `${BASE_URL}/home/login.mooc`;
const HOME_URL = `${BASE_URL}/home/index.mooc`;

export function hasStoredSession() {
  return fs.existsSync(STORAGE_STATE_PATH);
}

export async function isSessionValid(browser) {
  try {
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
    const apiContext = context.request;
    const resp = await apiContext.get(MY_COURSES_URL, {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    const status = resp.status();
    const body = status >= 200 && status < 300 ? await resp.text() : '';
    await context.close();
    // 302/301 → likely redirect to login page = invalid
    // 200 with "login" form or empty redirect markers → check body
    if (status >= 300 && status < 400) return false;
    if (status !== 200) return false;
    // The login page contains a password form; the courses page contains "我的课程" or course list markup.
    if (/myCourseIndex|我的课程|courseList|portal\/course/i.test(body)) return true;
    if (/login\.mooc|jaccount|请登录/i.test(body)) return false;
    return true;
  } catch (e) {
    log.warn(`Session validation error: ${e.message}`);
    return false;
  }
}

async function interactiveLogin() {
  // When running inside Electron, hand the UI off to the main process so the
  // user sees the login flow inside the app, not in a popped-out Chromium.
  if (typeof globalThis.cnmoocElectronLogin === 'function') {
    log.step('在应用内打开 Jaccount 登录窗口...');
    await globalThis.cnmoocElectronLogin();
    log.ok('登录成功，cookie 已保存到 storageState.json');
    return;
  }

  log.step('Launching browser for Jaccount login...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  log.info(`Navigating to ${HOME_URL}`);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });

  // Click the login link in the top nav (a[href="/home/login.mooc"])
  try {
    await page.click('a[href="/home/login.mooc"]', { timeout: 5000 });
  } catch {
    // Maybe already on a page where the login link is hidden — just go directly.
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  }

  log.info('On login page. Looking for Jaccount button...');
  // Try several selectors for Jaccount login
  const jaccountSelectors = [
    'a[href*="jaccount"]',
    'button:has-text("Jaccount")',
    'a:has-text("Jaccount")',
    'a:has-text("使用Jaccount")',
    'a:has-text("JAccount")',
    '.jaccount',
    '#jaccount',
  ];
  let clicked = false;
  for (const sel of jaccountSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        clicked = true;
        log.ok(`Clicked Jaccount via selector: ${sel}`);
        break;
      }
    } catch {}
  }
  if (!clicked) {
    log.warn('Could not auto-click Jaccount button. Please click it manually in the browser.');
  }

  log.info('请在浏览器中完成 Jaccount 扫码 / 账号登录...');
  log.info('登录成功后会自动检测并保存 cookie。等待中（最多 5 分钟）...');

  // Wait until we land back on cnmooc.sjtu.cn AND the page shows logged-in markers
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.startsWith(BASE_URL)) {
      try {
        // Poll the My Courses URL via the same context's request — confirms session.
        const probe = await context.request.get(MY_COURSES_URL, { failOnStatusCode: false });
        if (probe.status() === 200) {
          const text = await probe.text();
          if (/myCourseIndex|我的课程|courseList|portal\/course/i.test(text) &&
              !/login\.mooc|jaccount\.sjtu/i.test(text.slice(0, 2000))) {
            break;
          }
        }
      } catch {}
    }
    await sleep(2000);
  }
  if (Date.now() >= deadline) {
    await browser.close();
    throw new Error('登录超时（5 分钟）。请重新运行。');
  }

  log.ok('登录成功，保存 cookie 到 storageState.json');
  await context.storageState({ path: STORAGE_STATE_PATH });
  await browser.close();
}

/**
 * Ensure a valid session exists on disk. Logs in if needed.
 * Returns the path to storageState.json.
 */
export async function ensureAuthenticated({ forceRelogin = false } = {}) {
  if (!forceRelogin && hasStoredSession()) {
    log.step('Found existing storageState.json, validating session...');
    const browser = await chromium.launch({ headless: true });
    const ok = await isSessionValid(browser);
    await browser.close();
    if (ok) {
      log.ok('已有 cookie 仍然有效，跳过登录');
      return STORAGE_STATE_PATH;
    }
    log.warn('已有 cookie 已失效，需要重新登录');
  }
  await interactiveLogin();
  return STORAGE_STATE_PATH;
}

export { STORAGE_STATE_PATH, MY_COURSES_URL };
