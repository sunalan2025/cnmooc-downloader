import * as cheerio from 'cheerio';
import fs from 'node:fs';
import { BASE_URL, log, sanitizeName } from './utils.js';

// itemType values that represent quizzes/tests with no downloadable resource
const QUIZ_TYPES = new Set(['30', '50', '60']);


export async function fetchChapters(apiContext, courseId) {
  // courseId comes from a user-controllable route param. Convert to an
  // integer first — this both validates and produces a value that CodeQL
  // recognises as path-injection-safe.
  const courseIdNum = Number(courseId);
  if (!Number.isInteger(courseIdNum) || courseIdNum <= 0) {
    throw new Error(`invalid courseId: ${courseId}`);
  }
  const url = `${BASE_URL}/portal/session/unitNavigation/${courseIdNum}.mooc`;
  log.step(`Fetching chapters for course ${courseIdNum}...`);
  const resp = await apiContext.get(url, { failOnStatusCode: false });
  if (resp.status() !== 200) {
    throw new Error(`Chapter request failed for ${courseIdNum}: HTTP ${resp.status()}`);
  }
  const html = await resp.text();
  const $ = cheerio.load(html);

  const chapters = [];
  let currentChapter = null;

  // Walk every element to pick up chapter headings and lecture links in DOM order
  $('*').each((_, el) => {
    const $el = $(el);
    const tag = el.tagName?.toLowerCase();

    // Chapter heading heuristic: dedicated class or block-level heading tags
    const isChapterHeading =
      $el.hasClass('unit-title') ||
      $el.hasClass('chapter-title') ||
      $el.hasClass('section-title') ||
      $el.attr('data-type') === 'chapter' ||
      (tag === 'h2' || tag === 'h3' || tag === 'h4');

    if (isChapterHeading) {
      const title = $el.text().trim();
      if (title) {
        currentChapter = { chapter: sanitizeName(title), items: [] };
        chapters.push(currentChapter);
      }
      return;
    }

    // Lecture item: <a class="lecture-action" itemid="..." title="...">
    const itemId = $el.attr('itemid') || $el.attr('data-itemid');
    if (!itemId) return;
    if (tag !== 'a' && !$el.hasClass('lecture-action')) return;

    const title = sanitizeName($el.attr('title') || $el.text().trim(), `item_${itemId}`);
    // Read itemType directly from the attribute (e.g., itemType="10")
    const itemType = $el.attr('itemtype') || '10';

    // Skip quizzes/tests at parse time — no point in showing or probing them
    if (QUIZ_TYPES.has(itemType)) return;

    if (!currentChapter) {
      currentChapter = { chapter: '未分章节', items: [] };
      chapters.push(currentChapter);
    }
    if (!currentChapter.items.find((i) => i.itemId === itemId)) {
      currentChapter.items.push({ itemId, itemType, title });
    }
  });

  // drop chapters that ended up with no downloadable items
  const filtered = chapters.filter((c) => c.items.length > 0);
  const totalItems = filtered.reduce((s, c) => s + c.items.length, 0);
  if (!totalItems) {
    const debugPath = `debug_chapters_${courseIdNum}.html`;
    fs.writeFileSync(debugPath, html, 'utf8');
    log.warn(`No items found for course ${courseIdNum}. HTML saved to ${debugPath}.`);
  } else {
    log.ok(`${filtered.length} chapter(s), ${totalItems} item(s)`);
  }
  return filtered;
}
