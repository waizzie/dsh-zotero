/**
 * 在 PDF 里定位文字 → 生成 Zotero 高亮标注的请求体。
 *
 * 为什么放在 Host 侧：面板里没有文本层（只有 canvas + 标注叠加），做不了"选中文字"；
 * 而 Host 有 pdfjs-dist 依赖、有附件本地路径，直接 getTextContent() 就能拿到每个
 * text item 的 transform（PDF 用户空间，左下原点），几何计算一次到位。
 *
 * 几何公式不是猜的，是用库里 12 条真实标注标定出来的（见 docs/annotation-creation.md）：
 *   fs   = hypot(transform[2], transform[3])
 *   rect = [x1, baseline − 0.25·fs, x2, baseline + 1.0·fs]
 * 8 条干净样本给出的下探/上伸系数是 0.2500 / 1.0000（精确到小数点后 4 位），
 * 与字号（6.376 / 7.173 / 7.97）无关 —— 也就是 Zotero 自己用的就是 1.25 倍行盒。
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const round = (v) => Math.round(v * 1000) / 1000;

let pdfjsPromise = null;

/** 载入 pdfjs-dist（本包依赖；与面板用的是同一版本）。 */
async function loadPdfjs() {
  if (!pdfjsPromise) {
    const pkg = require.resolve('pdfjs-dist/package.json');
    const entry = join(dirname(pkg), 'legacy/build/pdf.mjs').replace(/\\/g, '/');
    pdfjsPromise = import(`file:///${entry}`);
  }
  return pdfjsPromise;
}

/**
 * 打开 PDF。返回 { doc, close }：pdf.js 6.x 的 PDFDocumentProxy 上没有 destroy()，
 * 必须销毁 loadingTask，所以这里把 close 一起交出去，避免调用方摸错对象。
 */
export async function openPdf(pdfPath) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await readFile(pdfPath));
  const task = pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false });
  const doc = await task.promise;
  const close = async () => { try { await task.destroy(); } catch { /* noop */ } };
  return { doc, close };
}

/** 归一化（折叠空白 + 小写），并保留「归一化下标 → 原串下标」的映射。 */
function normWithMap(s) {
  const chars = [];
  const map = [];
  let prevSpace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      if (!prevSpace && chars.length > 0) { chars.push(' '); map.push(i); }
      prevSpace = true;
      continue;
    }
    chars.push(ch.toLowerCase());
    map.push(i);
    prevSpace = false;
  }
  while (chars.length > 0 && chars[chars.length - 1] === ' ') { chars.pop(); map.pop(); }
  return { text: chars.join(''), map };
}

function rectFor(hit) {
  const x1 = Math.min(...hit.map((h) => h.it.transform[4]));
  const x2 = Math.max(...hit.map((h) => h.it.transform[4] + (h.it.width ?? 0)));
  const base = hit[0].it.transform[5];
  const fs = Math.hypot(hit[0].it.transform[2], hit[0].it.transform[3]);

  // 固定 1.25em 行盒：下沿 = baseline − 0.25·fs，上沿 = baseline + 1.0·fs。
  // 依据：12 条真实标注里有 8 条（正文，字号 6.376/7.173/7.97）与该式**逐位吻合**。
  // 已知偏差：个别字体（粗体标题）Zotero 用的是 1.11em 行盒，本式会把高亮上沿抬高
  // 约 1.5pt —— 视觉上可接受，详见 docs/annotation-creation.md「已知偏差」。
  return [round(x1), round(base - 0.25 * fs), round(x2), round(base + 1.0 * fs)];
}

const MAX_CANDIDATES = 20;

/** 候选的一句话上下文（给模型判断"这是不是页眉/参考文献"用）。 */
function contextOf(line, start, end, pad = 28) {
  const from = Math.max(0, start - pad);
  const to = Math.min(line.length, end + pad);
  return `${from > 0 ? '…' : ''}${line.slice(from, to)}${to < line.length ? '…' : ''}`.replace(/\s+/g, ' ');
}

/**
 * 在 PDF 中查找一段文字（单行内匹配）。
 *
 * 关键：**不做"取第一处"**。节标题常会在页眉/参考文献里重复出现，静默取第一处会把
 * 高亮标到错误位置（实测一篇 13 页论文里 "Natural language processing" 出现 12 次，
 * 第 1 处是页眉残片，真正的节标题在第 2 页）。所以：
 *   - 唯一命中 → 直接返回；
 *   - 多处命中 → 返回 { ambiguous, candidates }，由调用方指定 pageIndex / occurrence；
 *   - 找不到 → null。
 *
 * @returns {null | { pageIndex, pageLabel, pageHeight, matchedText, context, rects }
 *                  | { ambiguous: true, candidates: Array<{index, pageIndex, pageLabel, matchedText, context, rects}> }}
 */
export async function locateText(doc, { text, pageIndex, occurrence }) {
  const target = normWithMap(String(text ?? '')).text;
  if (!target) throw new Error('text 不能为空');

  const labels = await doc.getPageLabels().catch(() => null);
  const pages = Number.isInteger(pageIndex) && pageIndex >= 0
    ? [Math.min(pageIndex, doc.numPages - 1)]
    : Array.from({ length: doc.numPages }, (_, i) => i);

  const hits = [];
  for (const p of pages) {
    const page = await doc.getPage(p + 1);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();

    // 同一基线（2pt 容差）归为一行
    const rows = new Map();
    for (const it of tc.items) {
      if (!it.str) continue;
      const key = Math.round(it.transform[5] / 2) * 2;
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(it);
    }

    for (const [, items] of rows) {
      items.sort((a, b) => a.transform[4] - b.transform[4]);
      let acc = '';
      const ranges = [];
      for (const it of items) {
        const start = acc.length;
        acc += it.str;
        ranges.push({ it, start, end: acc.length });
      }
      const n = normWithMap(acc);
      // 同一行内也可能出现多次，逐个收集
      for (let at = n.text.indexOf(target); at >= 0; at = n.text.indexOf(target, at + 1)) {
        const origStart = n.map[at];
        const origEnd = n.map[at + target.length - 1] + 1;
        const hit = ranges.filter((r) => r.end > origStart && r.start < origEnd);
        if (hit.length === 0) continue;
        hits.push({
          pageIndex: p,
          pageLabel: labels?.[p] ?? String(p + 1),
          pageHeight: viewport.height,
          matchedText: acc.slice(origStart, origEnd),
          context: contextOf(acc, origStart, origEnd),
          rects: [rectFor(hit)],
        });
        if (hits.length >= MAX_CANDIDATES) break;
      }
      if (hits.length >= MAX_CANDIDATES) break;
    }
    if (hits.length >= MAX_CANDIDATES) break;
  }

  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];
  if (Number.isInteger(occurrence) && occurrence >= 0 && occurrence < hits.length) return hits[occurrence];

  return {
    ambiguous: true,
    candidates: hits.map((h, index) => ({
      index, pageIndex: h.pageIndex, pageLabel: h.pageLabel, matchedText: h.matchedText, context: h.context, rects: h.rects,
    })),
  };
}

/**
 * 组装 Zotero 标注对象。
 *
 * 踩过的坑（docs/zotero-api-spec.md §4.4）：
 *  - annotationType 必须是**第一个键**，否则 400；
 *  - annotationPosition 是 **JSON 字符串**，不是对象；
 *  - annotationSortIndex / annotationPosition 是 NOT NULL；
 *  - parentItem 必须指向**文件附件**。
 *
 * sortIndex 的格式是 `PPPPP|YYYYYY|XXXXX`。第 1 段经实测就是 pageIndex（218/218 精确），
 * 后两段是阅读器视口坐标（左上原点），无法从 rect 反解 —— 而它只影响标注列表内的排序，
 * 不影响高亮位置（位置只认 annotationPosition），所以这里用单调代理值，用户下次在
 * Zotero 里编辑该标注时 Zotero 会自行重算。
 */
export function buildHighlight({ attachmentKey, located, text, comment, color, tags }) {
  const [x1, , , y2] = located.rects[0];
  const y6 = String(Math.max(0, Math.min(999999, Math.round((located.pageHeight - y2) * 10)))).padStart(6, '0');
  const x5 = String(Math.max(0, Math.min(99999, Math.round(x1 * 10)))).padStart(5, '0');

  return {
    annotationType: 'highlight',
    // 本地 API 与 Web API 一致，**必须**带 itemType，缺它会 400
    // "itemType property not provided"（这是第一次真写时踩到的坑）。
    // 真实标注对象的字段形状（GET /api/users/0/items/<key> 的 data）：
    //   itemType, parentItem, annotationType, annotationText, annotationComment,
    //   annotationColor, annotationPageLabel, annotationSortIndex, annotationPosition, tags, relations
    itemType: 'annotation',
    parentItem: attachmentKey,
    annotationText: String(text ?? located.matchedText),
    annotationComment: String(comment ?? ''),
    annotationColor: String(color || '#ffd400'),
    annotationPageLabel: String(located.pageLabel),
    annotationSortIndex: `${String(located.pageIndex).padStart(5, '0')}|${y6}|${x5}`,
    annotationPosition: JSON.stringify({ pageIndex: located.pageIndex, rects: located.rects }),
    ...(tags?.length ? { tags: tags.map((tag) => ({ tag })) } : {}),
  };
}

/** 把定位结果压成一行人类可读的摘要（工具输出用）。 */
export function describeLocation(located) {
  if (!located) return '未找到该文字';
  return `p.${located.pageLabel}（pageIndex=${located.pageIndex}）rects=${JSON.stringify(located.rects)}`;
}
