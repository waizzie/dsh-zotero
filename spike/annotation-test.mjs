/**
 * 高亮创建能力的离线回归。不需要 DSH 在跑，也不写 Zotero。
 *
 * 两类断言：
 *  1) 几何：拿库里**已有标注**的 rects 当标准答案，验 locateText 算出的位置对不对。
 *     真值放在 `spike/cases.local.json`——**不入库**（见 .gitignore）。否则会把用户的
 *     附件 key 与论文原文句子写进公开仓库。缺这个文件时跳过几何部分，只跑结构断言。
 *  2) 结构：buildHighlight 产出的 payload 形状（不依赖任何库数据）。
 *
 * 跑法：node spike/annotation-test.mjs
 * 准备真值：cp spike/cases.example.json spike/cases.local.json 后按注释填写。
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPdf, locateText, buildHighlight } from '../lib/annotations.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const STORAGE = join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'Zotero', 'storage');
const CASES_FILE = join(HERE, 'cases.local.json');

let CASES = [];
if (existsSync(CASES_FILE)) {
  const raw = (await readFile(CASES_FILE, 'utf8')).replace(/^\uFEFF/, '');
  try {
    CASES = JSON.parse(raw).cases ?? [];
  } catch (e) {
    check('读取 cases.local.json', false, e.message);
  }
} else {
  console.log('（跳过几何断言：未找到 spike/cases.local.json，见 cases.example.json）\n');
}

const findPdf = async (att) => {
  const dir = join(STORAGE, att);
  const files = await readdir(dir);
  const name = files.find((f) => f.toLowerCase().endsWith('.pdf'));
  if (!name) throw new Error(`${att} 目录下没有 PDF`);
  return join(dir, name);
};

for (const c of CASES) {
  let opened;
  try {
    opened = await openPdf(await findPdf(c.att));
  } catch (e) {
    check(`${c.att} 打开 PDF`, false, e.message);
    continue;
  }

  // 1) 全文查找：多处命中必须报歧义，而不是静默取第一处
  //    （实测同一串文字在一篇 13 页论文里出现 12 次，第 1 处是页眉残片，真节标题在第 2 页）
  const loose = await locateText(opened.doc, { text: c.text });
  const pool = loose?.ambiguous
    ? loose.candidates
    : (loose ? [{ index: 0, pageIndex: loose.pageIndex, pageLabel: loose.pageLabel, rects: loose.rects }] : []);
  check(
    `${c.att} 全文查找给出候选（不静默取第一处）`,
    pool.length > 0 && (pool.length === 1 || loose?.ambiguous === true),
    loose?.ambiguous ? `${pool.length} 处候选` : '唯一命中',
  );

  // 2) 限定到真值所在页，再在候选里按 x1 挑出真值那一处显式复算
  const onPage = await locateText(opened.doc, { text: c.text, pageIndex: c.pageIndex });
  const pagePool = onPage?.ambiguous
    ? onPage.candidates
    : (onPage ? [{ index: 0, pageIndex: onPage.pageIndex, pageLabel: onPage.pageLabel, rects: onPage.rects, matchedText: onPage.matchedText }] : []);
  const idx = pagePool.findIndex((x) => Math.abs(x.rects[0][0] - c.rect[0]) < 0.02);
  check(
    `${c.att} p.${c.pageIndex} 候选含真值位置`,
    idx >= 0,
    pagePool.map((x) => `x1=${x.rects[0][0]}`).join(' '),
  );

  const located = idx < 0
    ? null
    : (pagePool.length === 1
      ? onPage
      : await locateText(opened.doc, { text: c.text, pageIndex: c.pageIndex, occurrence: idx }));
  await opened.close();
  if (!located || located.ambiguous) { check(`${c.att} 定位「${c.text.slice(0, 28)}…」`, false, '未找到'); continue; }

  const [x1, y1, x2, y2] = located.rects[0];
  const [tx1, ty1, tx2, ty2] = c.rect;
  // x 与 y1/y2 用紧公差；粗体标题 Zotero 用的是 1.11em 行盒，本式固定 1.25em →
  // 整框上移 1.5–2.6pt，属已知偏差（docs/annotation-creation.md §3），故 y 方向放宽。
  const ok = Math.abs(x1 - tx1) < 0.02 && Math.abs(y1 - ty1) < 1.6 && Math.abs(y2 - ty2) < 2.7 && Math.abs(x2 - tx2) < 4.5;
  check(
    `${c.att} p.${c.pageIndex} 定位「${c.text.slice(0, 28)}…」`,
    ok,
    `算得 [${x1}, ${y1}, ${x2}, ${y2}] / 真值 [${tx1}, ${ty1}, ${tx2}, ${ty2}]`,
  );
  check(`  └ pageLabel=${c.label}`, located.pageLabel === c.label, `实际 ${located.pageLabel}`);
  check('  └ 回读文字与原文一致', located.matchedText === c.text, located.matchedText);
}

// ── payload 结构（不需要库数据）────────────────────────────────
{
  const payload = buildHighlight({
    attachmentKey: 'ATTACH01',
    located: { pageIndex: 1, pageLabel: '2', pageHeight: 792, rects: [[75.296, 677.135, 198.428, 687.098]], matchedText: '一段示例原文' },
    comment: '测试评论',
  });
  const keys = Object.keys(payload);
  check('annotationType 是第一个键（服务端键序未复现，保留防回归）', keys[0] === 'annotationType', keys.slice(0, 3).join(','));
  // 首次真写时踩到：缺 itemType → 400 "itemType property not provided"
  check('itemType=annotation（缺它必 400）', payload.itemType === 'annotation', String(payload.itemType));
  check('annotationPosition 是 JSON 字符串', typeof payload.annotationPosition === 'string' && JSON.parse(payload.annotationPosition).rects.length === 1);
  check('annotationSortIndex 首段等于 pageIndex', payload.annotationSortIndex.split('|')[0] === '00001', payload.annotationSortIndex);
  check('sortIndex 形如 PPPPP|YYYYYY|XXXXX', /^\d{5}\|\d{6}\|\d{5}$/.test(payload.annotationSortIndex), payload.annotationSortIndex);
  check('默认黄色', payload.annotationColor === '#ffd400');
  check('parentItem 指向附件', payload.parentItem === 'ATTACH01');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length === 0 ? 0 : 1);
