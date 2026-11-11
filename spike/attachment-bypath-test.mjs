/**
 * attachment.byPath 所用内存路径索引的离线回归测试。
 * 不连接 Zotero 或 HTTP 服务，只验证路径归一化、容量淘汰和安全查询。
 *
 * 跑法：node spike/attachment-bypath-test.mjs
 */
import { createPathIndex } from '../lib/routes.js';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ── 1. 记住路径后可查询，Windows 路径大小写不影响命中 ──────────────
const index = createPathIndex();
index.remember('C:\\Users\\Research\\Paper.PDF', {
  key: 'ABCD2345',
  filename: 'Paper.PDF',
  contentType: 'application/pdf',
});
const caseHit = index.lookup('c:/users/research/paper.pdf');
check(
  '记住路径后能查到且忽略大小写',
  caseHit?.key === 'ABCD2345' && caseHit?.filename === 'Paper.PDF' && caseHit?.contentType === 'application/pdf',
  caseHit?.key,
);

// ── 2. 反斜杠与正斜杠混用仍视为同一路径 ────────────────────────────
index.remember('D:/Zotero/storage\\BBBB2222/full text.pdf', {
  key: 'BBBB2222',
  filename: 'full text.pdf',
  contentType: 'application/pdf',
});
const separatorHit = index.lookup('d:\\zotero\\storage/bbbb2222\\full text.pdf');
check('反斜杠与正斜杠混用也能查到', separatorHit?.key === 'BBBB2222', separatorHit?.key);

// ── 3. 未记录的路径不命中 ─────────────────────────────────────────
check('未记录的路径返回 null', index.lookup('E:\\not-recorded.pdf') === null);

// ── 4. 超出容量时淘汰最早插入项，保留最新项 ───────────────────────
const bounded = createPathIndex(2);
bounded.remember('C:\\first.pdf', { key: 'FIRST001', filename: 'first.pdf', contentType: 'application/pdf' });
bounded.remember('C:\\second.pdf', { key: 'SECOND02', filename: 'second.pdf', contentType: 'application/pdf' });
bounded.remember('C:\\third.pdf', { key: 'THIRD003', filename: 'third.pdf', contentType: 'application/pdf' });
check(
  '超过上限时最早项被淘汰且最新项保留',
  bounded.size() === 2 && bounded.lookup('C:\\first.pdf') === null && bounded.lookup('C:\\third.pdf')?.key === 'THIRD003',
  `size=${bounded.size()}`,
);

// ── 5. 同一路径重复记忆只更新内容，不重复占位 ─────────────────────
const duplicate = createPathIndex(3);
duplicate.remember('C:\\same.pdf', { key: 'OLDKEY01', filename: 'same.pdf', contentType: 'application/pdf' });
duplicate.remember('c:/SAME.pdf', { key: 'NEWKEY02', filename: 'same.pdf', contentType: 'application/pdf' });
check(
  'remember 同一路径两次 size 不变',
  duplicate.size() === 1 && duplicate.lookup('C:\\same.pdf')?.key === 'NEWKEY02',
  `size=${duplicate.size()}`,
);

// ── 6. 非法查询值安全返回 null，不抛异常 ──────────────────────────
let lookupError;
let nullResult;
let emptyResult;
try {
  nullResult = index.lookup(null);
  emptyResult = index.lookup('');
} catch (error) {
  lookupError = error;
}
check('lookup(null/空串) 不抛错且返回 null', lookupError === undefined && nullResult === null && emptyResult === null);

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
if (failed > 0) process.exit(1);
