// Electron main process — wraps the Express server in a desktop window,
// and also provides an in-app Jaccount login so we don't need to launch a
// separate Playwright Chromium instance just to scan a QR code.
//
// Project uses ESM ("type":"module") but Electron loads its main entry as
// CommonJS, hence the .cjs extension.

const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const PORT = 3456;
const STORAGE_STATE_PATH = path.resolve('storageState.json');
const CNMOOC_BASE = 'https://cnmooc.sjtu.cn';
const LOGIN_URL = `${CNMOOC_BASE}/home/login.mooc`;
const MY_COURSES_URL = `${CNMOOC_BASE}/portal/myCourseIndex/1.mooc`;

let mainWindow = null;

// ─────────────────────────────────────────────────────────────────────────
// In-app Jaccount login — replaces Playwright's chromium.launch({headless:false})
// when running inside Electron. Saves cookies in Playwright's storageState format
// so the rest of the pipeline (which still uses Playwright for headless probing)
// keeps working unchanged.
// ─────────────────────────────────────────────────────────────────────────
global.cnmoocElectronLogin = function electronLogin() {
  return new Promise((resolve, reject) => {
    const loginWin = new BrowserWindow({
      width: 1100,
      height: 760,
      title: '登录 CNMOOC (Jaccount)',
      parent: mainWindow || undefined,
      modal: false,
      autoHideMenuBar: true,
      backgroundColor: '#f8fafc',
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        // Dedicated partition keeps these cookies isolated from the host GUI page.
        partition: 'persist:cnmooc-login',
      },
    });

    const sess = loginWin.webContents.session;
    let finished = false;
    let pollTimer = null;

    function cleanup(ok, err) {
      if (finished) return;
      finished = true;
      if (pollTimer) clearInterval(pollTimer);
      try { loginWin.removeAllListeners('closed'); } catch {}
      try { if (!loginWin.isDestroyed()) loginWin.close(); } catch {}
      if (ok) resolve(STORAGE_STATE_PATH);
      else reject(err);
    }

    loginWin.on('closed', () => {
      if (!finished) cleanup(false, new Error('登录窗口已关闭'));
    });

    // Best-effort: auto-click the Jaccount entry on the login page so the
    // user lands directly on the QR-scan screen.
    loginWin.webContents.on('did-finish-load', () => {
      const url = loginWin.webContents.getURL();
      if (url.includes('/home/login.mooc')) {
        loginWin.webContents
          .executeJavaScript(`
            (() => {
              for (const sel of ['a[href*="jaccount"]', 'a.jaccount', '#jaccount']) {
                const el = document.querySelector(sel);
                if (el) { el.click(); return true; }
              }
              for (const el of document.querySelectorAll('a, button')) {
                const t = (el.textContent || '') + ' ' + (el.getAttribute('href') || '');
                if (/jaccount/i.test(t)) { el.click(); return true; }
              }
              return false;
            })();
          `)
          .catch(() => {});
      }
    });

    // Poll the protected URL every 2 s. When it returns the course-list page
    // (not the login page) we know login succeeded.
    const deadline = Date.now() + 5 * 60 * 1000;
    pollTimer = setInterval(async () => {
      if (finished) return;
      if (Date.now() > deadline) {
        cleanup(false, new Error('登录超时（5 分钟）'));
        return;
      }
      try {
        const resp = await sess.fetch(MY_COURSES_URL, { redirect: 'manual' });
        if (resp.status !== 200) return;
        const text = await resp.text();
        if (
          /myCourseIndex|我的课程|courseList|portal\/course/i.test(text) &&
          !/login\.mooc|jaccount\.sjtu/i.test(text.slice(0, 2000))
        ) {
          // Logged in. Snapshot cookies in Playwright's storageState shape.
          const cookies = await sess.cookies.get({});
          const SAME_SITE = { lax: 'Lax', strict: 'Strict', no_restriction: 'None' };
          const storageState = {
            cookies: cookies.map((c) => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path || '/',
              expires: typeof c.expirationDate === 'number' ? c.expirationDate : -1,
              httpOnly: !!c.httpOnly,
              secure: !!c.secure,
              sameSite: SAME_SITE[c.sameSite] || 'Lax',
            })),
            origins: [],
          };
          fs.writeFileSync(STORAGE_STATE_PATH, JSON.stringify(storageState, null, 2), 'utf8');
          cleanup(true);
        }
      } catch {
        // network blip — keep polling
      }
    }, 2000);

    loginWin.loadURL(LOGIN_URL);
  });
};

// ─────────────────────────────────────────────────────────────────────────
// Internal Express server (same one as `npm run gui`, no system browser popup)
// ─────────────────────────────────────────────────────────────────────────
async function startServer() {
  process.env.CNMOOC_NO_OPEN = '1';
  const serverPath = path.join(__dirname, '..', 'src', 'server.js');
  await import(pathToFileURL(serverPath).href);
  await new Promise((r) => setTimeout(r, 500));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'CNMOOC Downloader',
    autoHideMenuBar: true,
    backgroundColor: '#f8fafc',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (err) {
    console.error('Failed to start internal server:', err);
    app.exit(1);
    return;
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
