/**
 * 凭据记录键格式回归。全离线，不碰真凭据。
 *
 * 背景（2026-11-04 事故）：旧版键写成 `'zotero-local-api-key'`（没有 `/`）。
 * DSH 的写路径不校验键格式，但下次启动 `parseRecords()` → `parseCredentialKey()` 会抛
 * `credential key "…" must be "<scope>/<id>"`，credentials 插件激活失败 → 整机起不来。
 * 这个测试保证常量始终符合 DSH 的 grammar。
 *
 * 跑法：node spike/key-store-test.mjs
 */
import { RECORD_KEY, createKeyStore, assertCredentialKey } from '../lib/key-store.js';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// DSH @deepseek-ai/dsh-credentials 的真实约束：两段各自匹配 KEY_SEGMENT_PATTERN
const SEGMENT = /^[a-z][a-z0-9-]*$/;
const isCredentialKey = (v) => {
  const seg = String(v).split('/');
  return seg.length === 2 && seg.every((s) => SEGMENT.test(s));
};

check('RECORD_KEY 形如 <scope>/<id>', isCredentialKey(RECORD_KEY), RECORD_KEY);
check('scope 取本包名', RECORD_KEY.split('/')[0] === 'dsh-zotero', RECORD_KEY.split('/')[0]);

// 反向断言：把旧值钉成"必须被拒"，避免有人改回去
check('旧值 zotero-local-api-key 会被 DSH 拒绝', !isCredentialKey('zotero-local-api-key'));
check('带大写也会被拒', !isCredentialKey('dsh-zotero/Local-Key'));
check('三段也会被拒', !isCredentialKey('a/b/c'));

// 插件自己的校验函数（与 grammar 同源），并确认激活路径不抛错
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
check('assertCredentialKey 接受 RECORD_KEY', !throws(() => assertCredentialKey(RECORD_KEY)));
check('assertCredentialKey 拒绝旧值', throws(() => assertCredentialKey('zotero-local-api-key')));
check('assertCredentialKey 拒绝大写', throws(() => assertCredentialKey('dsh-zotero/Local')));
check('assertCredentialKey 拒绝三段', throws(() => assertCredentialKey('a/b/c')));
// DSH 要求 apply 不得同步抛错：构造必须永远成功，坏键只降级为"禁用持久化"
check('createKeyStore 构造不抛错（激活路径安全）', !throws(() => createKeyStore({ get: () => null }, () => {})));

// ── 假凭据服务：记录插件实际写出的键 ──────────────────────────
const seen = [];
const fakeCreds = {
  async readRecord(key) { seen.push(['read', key]); return null; },
  async modifyRecord(key, fn) {
    const rec = await fn();
    seen.push(['write', key, rec]);
    return rec;
  },
  async deleteRecord(key) { seen.push(['delete', key]); },
  async describeRecord(key) { seen.push(['describe', key]); return { configured: false, source: 'none' }; },
};
const ctx = { get: (name) => (name === 'credentials' ? fakeCreds : null) };
const store = createKeyStore(ctx);

await store.load();
const secret = 'z'.repeat(40);
await store.save(secret);
await store.describe();
await store.clear();

const keys = seen.map(([op, key]) => key);
check('所有凭据调用都用同一个键', new Set(keys).size === 1, [...new Set(keys)].join(','));
check('写路径的键符合 grammar', keys.every(isCredentialKey), keys[0]);
check('四次调用齐全（load/save/describe/clear）', new Set(seen.map(([op]) => op)).size === 4, seen.map(([op]) => op).join(','));
check('save 后内存里有 key', typeof secret === 'string');
check('clear 后内存清空', store.get() === null);

const written = seen.find(([op]) => op === 'write')?.[2];
check('写入的 record.kind = grant', written?.kind === 'grant', String(written?.kind));
check('payload 里带 key 且不回显在 describe', written?.payload?.key === secret && !JSON.stringify(await store.describe()).includes(secret));

// ── 无凭据服务时降级为内存，不抛错 ─────────────────────────────
const memOnly = createKeyStore({ get: () => null });
await memOnly.save('m'.repeat(40));
check('凭据服务缺失时降级为内存', memOnly.get()?.length === 40);

// ── ensureLoaded：写操作前补读密钥（2026-11-11 重启后 401 的回归）────
// 场景：激活时 load() 早于凭据服务就绪，内存为空；写操作前再要一次应该能拿到。
{
  const stored = 'k'.repeat(36);
  let reads = 0;
  const lateCreds = {
    async readRecord(key) { reads++; return { kind: 'grant', payload: { key: stored } }; },
    async modifyRecord() { return {}; },
    async describeRecord() { return { configured: true }; },
  };
  const lateStore = createKeyStore({ get: (n) => (n === 'credentials' ? lateCreds : null) }, () => {});
  check('ensureLoaded 前内存为空', lateStore.get() === null);
  const got = await lateStore.ensureLoaded();
  check('ensureLoaded 能从凭据服务补到密钥', got === stored, String(got?.length));
  const readsAfterFirst = reads;
  await lateStore.ensureLoaded();
  check('已有密钥时 ensureLoaded 不再重复读', reads === readsAfterFirst, `${reads} vs ${readsAfterFirst}`);
}

// 凭据服务返回空时，ensureLoaded 不抛错、保持未授权（交给上层重新授权）
{
  const emptyStore = createKeyStore({ get: () => ({ readRecord: async () => null }) }, () => {});
  let threw = false;
  try { await emptyStore.ensureLoaded(); } catch { threw = true; }
  check('凭据为空时 ensureLoaded 不抛错', !threw && emptyStore.get() === null);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length === 0 ? 0 : 1);
