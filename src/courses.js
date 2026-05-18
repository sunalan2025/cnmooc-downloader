import * as cheerio from 'cheerio';
import fs from 'node:fs';
import { MY_COURSES_URL } from './auth.js';
import { log, sanitizeName } from './utils.js';

// tabIndex values: 1=正在进行, 2=即将开始, 3=已结束
export async function fetchCourses(browserContext, { tabIndex = 1 } = {}) {
  log.step('Fetching "正在学习" course list (rendering page)...');
  const page = await browserContext.newPage();
  try {
    // Navigate and wait for the AJAX-loaded course cards to appear
    await page.goto(`${MY_COURSES_URL}`, { waitUntil: 'networkidle', timeout: 30000 });
    if (tabIndex !== 1) {
      // Click the corresponding tab and wait for reload
      await page.click(`.btn-item[tabindex="${tabIndex}"]`);
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    }
    const html = await page.content();
    return parseCourseHtml(html);
  } finally {
    await page.close();
  }
}

function parseCourseHtml(html) {
  const $ = cheerio.load(html);
  const courses = [];
  const seen = new Set();

  // Each course card wraps an <a class="view-shadow" href="/portal/session/index/{sessionId}.mooc">
  $('a.view-shadow[href*="/portal/session/index/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/\/portal\/session\/index\/(\d+)\.mooc/);
    if (!m) return;
    const courseId = m[1]; // actually the session/openId
    if (seen.has(courseId)) return;
    seen.add(courseId);

    // Walk up to .view card, then find h3.view-title (exclude the span.cview-time sub-text)
    const $card = $(el).closest('.view');
    const $h3 = $card.find('h3.view-title').clone();
    $h3.find('span').remove();
    const rawName = $h3.text().trim();
    courses.push({ courseId, name: sanitizeName(rawName, `session_${courseId}`) });
  });

  if (!courses.length) {
    fs.writeFileSync('debug_courses.html', html, 'utf8');
    log.warn('No courses parsed. Raw HTML saved to debug_courses.html.');
  } else {
    log.ok(`Found ${courses.length} course(s).`);
    for (const { courseId, name } of courses) log.info(`  [${courseId}] ${name}`);
  }
  return courses;
}
