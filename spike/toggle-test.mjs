/**
 * 写回开关路由的离屏冒烟测试（不需要 DSH 在跑、不碰 Zotero）。
 *
 * 目的：在重启 DSH 之前，先把「面板按钮 → /dsh-zotero/api/write → settings + configEditor」
 * 这条链路的真实行为验一遍，避免"改完代码重启才发现路由写错"。
 *
 * 跑法：node spike/toggle-test.mjs
 */
import { registerRoutes } from '../lib/routes.js';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ── 假的 configEditor：记录被写入的配置 ──────────────────────────
// 形状严格照抄 app.asar/.../dsh-config-editor/lib/index.js：entries() 返回的是
// **Loader entry**（配置挂在 options 上），不是 {id, patchId, name}。
const edits = [];
const fakeEntry = {
  options: {
    id: 'dsh-zotero',
    name: 'dsh-zotero',
    config: { baseUrl: 'http://127.0.0.1:23119', allowWrite: true, appName: 'DSH Zotero', maxFulltextChars: 20000 },
  },
  fiber: { state: 2 },
};
const fakeEditor = {
  entries: () => [fakeEntry, { options: { id: 'other', name: 'other' }, fiber: { state: 2 } }],
  edit: async (entry, change) => {
    const current = { baseUrl: 'http://127.0.0.1:23119', allowWrite: false, appName: 'DSH Zotero', maxFulltextChars: 20000 };
    const inherited = { baseUrl: 'http://127.0.0.1:23119', allowWrite: false, appName: 'DSH Zotero', maxFulltextChars: 20000 };
    edits.push({ entryId: entry?.options?.id, next: change(current, inherited) });
  },
};

// ── 假 ctx / client ─────────────────────────────────────────────
const routes = [];
let editorMode = 'ok';           // ok | missing | throws
const ctx = {
  get: (name) => {
    if (name !== 'configEditor') return undefined;
    if (editorMode === 'missing') return undefined;
    if (editorMode === 'throws') return { entries: () => { throw new Error('boom'); }, edit: async () => {} };
    if (editorMode === 'no-match') return { entries: () => [{ options: { id: 'other', name: 'other' } }], edit: async () => { throw new Error('不该被调用'); } };
    return fakeEditor;
  },
  webServer: { register: (r) => { routes.push(r); return () => {}; } },
};
const client = {
  baseUrl: 'http://127.0.0.1:23119',
  probe: async () => ({ ok: true, zoteroVersion: 'test', libraryVersion: 1, writeAuthorized: false }),
};
const settings = { allowWrite: true, maxFulltextChars: 20000, appName: 'DSH Zotero', baseUrl: 'http://127.0.0.1:23119' };
const keyStore = { describe: async () => ({ configured: false }), get: () => undefined };

registerRoutes(ctx, { client, sessionState: {}, settings, keyStore, panelState: { last: null }, log: () => {} });

const api = routes.find((r) => r.path === '/dsh-zotero/api');
check('注册了 /dsh-zotero/api 前缀路由', Boolean(api?.handler));

/** 调一次 API：返回 { status, json } */
function callApi(method, payload) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
    const listeners = {};
    const req = {
      method: 'POST',
      headers: { host: '127.0.0.1:14988' },
      url: `/dsh-zotero/api/${method}`,
      on: (ev, fn) => { listeners[ev] = fn; return req; },
    };
    const chunks = [];
    const res = {
      writeHead: (status) => { res.status = status; },
      end: (text) => { resolve({ status: res.status, json: JSON.parse(text || '{}') }); },
    };
    api.handler(req, res).then(() => {
      // handler 内部已 await readJsonBody；把 body 塞进去触发
      listeners.data?.(body);
      listeners.end?.();
    });
    // 先把 body 事件喂进去（readJsonBody 在 handler 里 await）
    setTimeout(() => { listeners.data?.(body); listeners.end?.(); }, 0);
    void chunks;
  });
}

// ── 用例 ────────────────────────────────────────────────────────
{
  const r = await callApi('status');
  check('status 回显 writeEnabled', r.json?.value?.writeEnabled === true, `writeEnabled=${r.json?.value?.writeEnabled}`);
}

{
  settings.allowWrite = true;
  const r = await callApi('write', { enabled: false });
  check('关闭：settings 立刻变 false', settings.allowWrite === false);
  check('关闭：返回 changed/persisted', r.json?.value?.changed === true && r.json?.value?.persisted === true, JSON.stringify(r.json?.value));
  check('关闭：configEditor 收到 allowWrite=false', edits.at(-1)?.next?.allowWrite === false);
  check('关闭：命中正确的配置条目', edits.at(-1)?.entryId === 'dsh-zotero', edits.at(-1)?.entryId);
  check('关闭：其余字段被保留', edits.at(-1)?.next?.baseUrl === 'http://127.0.0.1:23119' && edits.at(-1)?.next?.maxFulltextChars === 20000);
}

{
  const before = edits.length;
  const r = await callApi('write', { enabled: true });
  check('开启：settings 变回 true', settings.allowWrite === true);
  check('开启：持久化一次', edits.length === before + 1 && edits.at(-1)?.next?.allowWrite === true);
  check('开启：返回值 writeEnabled=true', r.json?.value?.writeEnabled === true);
}

{
  const before = edits.length;
  const r = await callApi('write', { enabled: true });
  check('幂等：同值不重复落盘', edits.length === before && r.json?.value?.changed === false, JSON.stringify(r.json?.value));
}

{
  editorMode = 'missing';
  const r = await callApi('write', { enabled: false });
  check('configEditor 缺失：运行时仍生效', settings.allowWrite === false);
  check('configEditor 缺失：persisted=false 且给出原因', r.json?.value?.persisted === false && /configEditor/.test(r.json?.value?.warning ?? ''), r.json?.value?.warning);
}

{
  editorMode = 'throws';
  settings.allowWrite = true;
  const r = await callApi('write', { enabled: false });
  check('configEditor 抛错：运行时仍生效', settings.allowWrite === false);
  check('configEditor 抛错：persisted=false 且带 warning', r.json?.value?.persisted === false && Boolean(r.json?.value?.warning), r.json?.value?.warning);
}

{
  editorMode = 'no-match';
  settings.allowWrite = true;
  const r = await callApi('write', { enabled: false });
  check('条目未命中：运行时仍生效', settings.allowWrite === false);
  check('条目未命中：返回 entriesSeen 便于诊断', Array.isArray(r.json?.value?.entriesSeen) && r.json.value.entriesSeen.length === 1, JSON.stringify(r.json?.value?.entriesSeen));
}

{
  editorMode = 'ok';
  const r = await callApi('nope');
  check('未知方法仍返回 404', r.status === 404);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length === 0 ? 0 : 1);
