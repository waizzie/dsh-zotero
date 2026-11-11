/**
 * annotation.create 请求校验与 payload 组装的离线回归测试。
 * 不启动 HTTP、不联网、不碰 Zotero，直接测试 routes.js 导出的纯函数。
 *
 * 跑法：node spike/annotation-route-test.mjs
 */
import { buildAnnotationRequest } from '../lib/routes.js';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const validInput = {
  attachmentKey: 'ABCD2345',
  text: 'PDF 原文',
  comment: '测试评论',
  color: '#ffd400',
  pageIndex: 2,
  pageHeight: 792,
  rects: [[10, 20, 110, 32]],
};

function expectBadRequest(name, input, field) {
  let error;
  try {
    buildAnnotationRequest(input);
  } catch (e) {
    error = e;
  }
  const message = String(error?.message ?? '未抛错');
  check(name, error?.code === 'bad-request' && message.includes(field), `${error?.code ?? 'none'}: ${message}`);
}

// ── 1. 缺 attachmentKey ────────────────────────────────────────────
{
  const { attachmentKey, ...input } = validInput;
  void attachmentKey;
  expectBadRequest('缺 attachmentKey → bad-request', input, 'attachmentKey');
}

// ── 2. attachmentKey 格式错误 ──────────────────────────────────────
expectBadRequest('attachmentKey 格式错误 → bad-request', { ...validInput, attachmentKey: 'abc' }, 'attachmentKey');

// ── 3. rects 为空数组 ──────────────────────────────────────────────
expectBadRequest('rects 为空数组 → bad-request', { ...validInput, rects: [] }, 'rects');

// ── 4. rects 含非数字 ──────────────────────────────────────────────
expectBadRequest('rects 含非数字 → bad-request', { ...validInput, rects: [['a', 1, 2, 3]] }, 'rects');

// ── 5. pageIndex 为负 ──────────────────────────────────────────────
expectBadRequest('pageIndex 为负 → bad-request', { ...validInput, pageIndex: -1 }, 'pageIndex');

// ── 6. 正常入参与 buildHighlight 契约 ───────────────────────────────
{
  const result = buildAnnotationRequest(validInput);
  const payload = result.payload;
  const position = JSON.parse(payload.annotationPosition);
  const ok = Object.keys(payload)[0] === 'annotationType'
    && Boolean(payload.annotationType)
    && typeof payload.annotationPosition === 'string'
    && position.pageIndex === validInput.pageIndex
    && payload.parentItem === validInput.attachmentKey
    && payload.annotationText === validInput.text
    && payload.annotationComment === validInput.comment;
  check('正常入参生成正确的 highlight payload', ok, JSON.stringify({ firstKey: Object.keys(payload)[0], position }));
}

// ── 7. pageLabel 缺省 ──────────────────────────────────────────────
{
  const result = buildAnnotationRequest({ ...validInput, pageIndex: 4 });
  check('不传 pageLabel 时默认为 String(pageIndex + 1)', result.pageLabel === '5', result.pageLabel);
}

// ── 8. attachmentKey 统一大写 ──────────────────────────────────────
{
  const result = buildAnnotationRequest({ ...validInput, attachmentKey: 'abcd2345' });
  check('小写 attachmentKey 输入 → 返回大写', result.attachmentKey === 'ABCD2345', result.attachmentKey);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed === 0 ? 0 : 1);
