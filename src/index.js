import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ensureAuthenticated, STORAGE_STATE_PATH } from './auth.js';
import { fetchCourses } from './courses.js';
import { fetchChapters } from './chapters.js';
import { fetchResourceUrl } from './resources.js';
import { downloadFile } from './downloader.js';
import { log, jitter, ConcurrencyPool } from './utils.js';
import { loadConfig, classifyResourceUrl } from './config.js';

const PROGRESS_PATH = path.resolve('.progress.json');
const SNAPSHOT_PATH = path.resolve('.snapshot.json');

function parseArgs() {
  const args = process.argv.slice(2);
  const courseIdArg = args.find((a) => a.startsWith('--course-id='));
  const concurrencyArg = args.find((a) => a.startsWith('--concurrency='));
  const retryArg = args.find((a) => a.startsWith('--retry='));
  return {
    loginOnly: args.includes('--login-only'),
    listOnly: args.includes('--list-only'),
    forceRelogin: args.includes('--relogin'),
    incremental: args.includes('--incremental'),
    videoOnly: args.includes('--video-only'),
    docOnly: args.includes('--doc-only'),
    courseId: courseIdArg ? courseIdArg.split('=')[1] : null,
    concurrency: concurrencyArg ? parseInt(concurrencyArg.split('=')[1], 10) : undefined,
    retryCount: retryArg ? parseInt(retryArg.split('=')[1], 10) : undefined,
  };
}

// --- progress persistence (task-level resume) ---

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_PATH)) {
      return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

// In-memory store to avoid race conditions from concurrent writes
let _progressCache = null;

function getProgress() {
  if (!_progressCache) _progressCache = loadProgress();
  return _progressCache;
}

function saveProgressItem(courseId, chapterName, itemId) {
  const progress = getProgress();
  const key = `${courseId}|${chapterName}`;
  if (!progress[key]) progress[key] = [];
  if (!progress[key].includes(itemId)) {
    progress[key].push(itemId);
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), 'utf8');
  }
}

// --- snapshot persistence (incremental mode) ---

function loadSnapshot() {
  try {
    if (fs.existsSync(SNAPSHOT_PATH)) {
      return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function saveSnapshot(courseId, itemIds) {
  const snapshot = loadSnapshot();
  snapshot[courseId] = [...new Set(itemIds)].sort();
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
}

// --- main ---

async function main() {
  const cliArgs = parseArgs();
  const config = loadConfig({
    concurrency: cliArgs.concurrency,
    retryCount: cliArgs.retryCount,
  });

  // Resolve resourceTypes from shorthand flags
  const resourceTypes = cliArgs.videoOnly
    ? ['video']
    : cliArgs.docOnly
      ? ['document']
      : config.resourceTypes;

  await ensureAuthenticated({ forceRelogin: cliArgs.forceRelogin });
  if (cliArgs.loginOnly) {
    log.ok('Login complete. Exiting.');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
  const api = context.request;

  try {
    const allCourses = await fetchCourses(context);
    const courses = cliArgs.courseId
      ? allCourses.filter((c) => c.courseId === cliArgs.courseId)
      : allCourses;

    if (!courses.length) {
      log.warn(cliArgs.courseId ? `Course ${cliArgs.courseId} not found.` : 'No courses found.');
      return;
    }

    if (cliArgs.listOnly) {
      log.step('Course list:');
      for (const { courseId: id, name } of courses) console.log(`  [${id}] ${name}`);
      return;
    }

    // Phase 1: collect all downloadable resource URLs
    const progress = getProgress();
    const snapshot = cliArgs.incremental ? loadSnapshot() : null;
    const downloadTasks = [];

    for (const course of courses) {
      log.step(`=== ${course.name} [${course.courseId}] ===`);
      const chapters = await fetchChapters(api, course.courseId);

      for (const { chapter, items } of chapters) {
        if (!items.length) continue;

        // Check chapter exclusion patterns
        const excluded = config.excludeChapters.some((pattern) => {
          try { return new RegExp(pattern, 'i').test(chapter); } catch { return false; }
        });
        if (excluded) {
          log.skip(`  ${chapter} (excluded by config)`);
          continue;
        }

        log.step(`  ${chapter} (${items.length} items)`);

        for (const item of items) {
          // Task-level resume: skip already completed items
          const progressKey = `${course.courseId}|${chapter}`;
          if (progress[progressKey]?.includes(item.itemId)) {
            log.skip(`  ${item.title} (already downloaded)`);
            continue;
          }

          // Incremental mode: skip items that existed in last full run
          if (snapshot && snapshot[course.courseId]?.includes(item.itemId)) {
            log.skip(`  ${item.title} (not new)`);
            continue;
          }

          await jitter(config.jitterMin, config.jitterMax);

          const url = await fetchResourceUrl(api, item, { retryCount: config.retryCount });
          if (!url) continue;

          // Apply resource type filter
          const type = classifyResourceUrl(url);
          if (!resourceTypes.includes(type)) {
            log.skip(`  ${item.title} (${type}, filtered by config)`);
            continue;
          }

          downloadTasks.push({
            url,
            courseName: course.name,
            chapterName: chapter,
            title: item.title,
            courseId: course.courseId,
            chapter: chapter,
            itemId: item.itemId,
          });
        }
      }
    }

    if (!downloadTasks.length) {
      log.ok('Nothing to download.');
      return;
    }

    // Phase 2: concurrent download
    log.step(`Starting ${downloadTasks.length} download(s) with ${config.concurrency} concurrent...`);
    const pool = new ConcurrencyPool(config.concurrency);
    const promises = downloadTasks.map((task) =>
      pool.run(async () => {
        await downloadFile(
          { url: task.url, courseName: task.courseName, chapterName: task.chapterName, title: task.title },
          { retryCount: config.retryCount },
        );
        saveProgressItem(task.courseId, task.chapter, task.itemId);
      }),
    );
    await Promise.all(promises);

    // Phase 3: update snapshot in incremental mode
    if (cliArgs.incremental) {
      for (const course of courses) {
        const courseItemIds = [
          ...(snapshot?.[course.courseId] || []),
          ...downloadTasks
            .filter((t) => t.courseId === course.courseId)
            .map((t) => t.itemId),
        ];
        if (courseItemIds.length) {
          saveSnapshot(course.courseId, courseItemIds);
        }
      }
      log.ok('Snapshot updated.');
    }

    log.ok('All done!');
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  log.err(err.message);
  process.exit(1);
});
