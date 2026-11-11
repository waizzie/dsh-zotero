/**
 * buildTrashBody 的离线纯函数回归测试，不连接 Zotero、不访问网络。
 * 跑法：node spike/annotation-delete-test.mjs
 */
import assert from 'node:assert/strict';
import { buildTrashBody } from '../lib/zotero-client.js';

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(true);
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${name}  — ${e?.message ?? e}`);
  }
};
const expectBadRequest = (fn) => {
  let error;
  try { fn(); } catch (e) { error = e; }
  assert.ok(error, '预期抛错');
  assert.equal(error.code, 'bad-request');
  return error;
};

check('正常标注返回 deleted=1 请求体', () => {
  const body = buildTrashBody([{ key: 'ABCD2345', version: 42, data: { itemType: 'annotation' } }]);
  assert.deepEqual(body, [{ key: 'ABCD2345', version: 42, deleted: 1 }]);
});

check('多条标注保持顺序与条数', () => {
  const body = buildTrashBody([
    { key: 'AAAA1111', version: 1, data: { itemType: 'annotation' } },
    { key: 'BBBB2222', version: 2, data: { itemType: 'annotation' } },
    { key: 'CCCC3333', version: 3, data: { itemType: 'annotation' } },
  ]);
  assert.deepEqual(body, [
    { key: 'AAAA1111', version: 1, deleted: 1 },
    { key: 'BBBB2222', version: 2, deleted: 1 },
    { key: 'CCCC3333', version: 3, deleted: 1 },
  ]);
});

check('journalArticle 被拒绝且 code=bad-request', () => {
  const error = expectBadRequest(() => buildTrashBody([
    { key: 'DOI12345', version: 9, data: { itemType: 'journalArticle' } },
  ]));
  assert.match(error.message, /只能删除标注条目/);
});

check('attachment 被拒绝', () => {
  expectBadRequest(() => buildTrashBody([
    { key: 'FILE1234', version: 8, data: { itemType: 'attachment' } },
  ]));
});

check('缺 version 被拒绝', () => {
  expectBadRequest(() => buildTrashBody([
    { key: 'ABCD2345', data: { itemType: 'annotation' } },
  ]));
});

check('缺 key 被拒绝', () => {
  expectBadRequest(() => buildTrashBody([
    { version: 42, data: { itemType: 'annotation' } },
  ]));
});

check('纯函数不修改入参数组或条目', () => {
  const items = [{ key: 'ABCD2345', version: 42, data: { itemType: 'annotation', annotationText: '原文' } }];
  const before = JSON.stringify(items);
  const body = buildTrashBody(items);
  assert.equal(JSON.stringify(items), before);
  assert.notStrictEqual(body, items);
  assert.notStrictEqual(body[0], items[0]);
});

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
if (failed > 0) process.exit(1);
