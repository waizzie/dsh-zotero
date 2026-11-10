/**
 * zotero_find_pdf 的客户端契约回归。全离线：起一个假 Zotero 服务器，不碰真库。
 *
 * 覆盖点（都是容易写错、且出错后很难从现象反推的地方）：
 *  - 桥接端点路径与请求体形状（itemKey 大写、可选 flags 只在为 true 时出现）
 *  - 桥接插件没装时 Zotero 回 404 "No endpoint found" → 必须报 bridge-missing，而不是"条目不存在"
 *  - 桥接插件用 4xx/5xx + JSON 表达业务失败 → 必须当结果返回，不能当异常抛
 *  - 已有附件 / 没找到文件 / 下载失败 三种业务返回要能透传
 *
 * 跑法：node spike/find-pdf-test.mjs
 */
import http from 'node:http';
import { createZoteroClient } from '../lib/zotero-client.js';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

let mode = 'ok';
const seen = [];

function route(req, body) {
  if (req.url === '/dsh-zotero/ping') {
    if (mode === 'no-bridge') return [404, 'No endpoint found\n'];
    return [200, {
      ok: true,
      bridge: 'dsh-zotero-bridge',
      version: '0.1.0',
      zoteroVersion: '10.0.7',
      canFindFiles: true,
    }];
  }
  if (req.url === '/dsh-zotero/find-file') {
    if (mode === 'no-bridge') return [404, 'No endpoint found\n'];
    if (mode === 'item-not-found') return [404, { ok: false, error: 'ITEM_NOT_FOUND', itemKey: body?.itemKey }];
    if (mode === 'download-error') return [500, { ok: false, error: 'DOWNLOAD_ERROR', message: 'boom', resolverCount: 2 }];
    if (mode === 'no-file') {
      return [200, { ok: false, error: 'NO_FILE_FOUND', itemKey: body?.itemKey, resolverCount: 3, resolvers: ['doi', 'oa', 'custom'] }];
    }
    if (mode === 'already') {
      return [200, { ok: true, itemKey: body?.itemKey, alreadyHad: true, attachmentKey: 'AAAA1111', contentType: 'application/pdf' }];
    }
    return [200, {
      ok: true,
      itemKey: body?.itemKey,
      attachmentKey: 'BBBB2222',
      attachmentTitle: 'Full Text PDF',
      contentType: 'application/pdf',
      resolverCount: 4,
      resolvers: ['doi', 'url', 'oa', 'custom'],
    }];
  }
  return [404, 'No endpoint found\n'];
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    seen.push({ method: req.method, url: req.url, body: json, contentType: req.headers['content-type'] });
    const [status, payload] = route(req, json);
    const isJson = typeof payload !== 'string';
    res.writeHead(status, { 'Content-Type': isJson ? 'application/json' : 'text/plain' });
    res.end(isJson ? JSON.stringify(payload) : payload);
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const client = createZoteroClient({ baseUrl: `http://127.0.0.1:${port}` });

// ── 1. 探活 ──────────────────────────────────────────────────────────
mode = 'ok';
const ping = await client.bridgeStatus();
check('bridgeStatus 识别已安装', ping.installed === true && ping.bridge === 'dsh-zotero-bridge', ping.version);
check('ping 走 GET /dsh-zotero/ping', seen.at(-1).method === 'GET' && seen.at(-1).url === '/dsh-zotero/ping');

mode = 'no-bridge';
const missing = await client.bridgeStatus();
check('桥未安装时 installed=false', missing.installed === false && missing.reason === 'not-installed', missing.reason);

// ── 2. 正常下载 ──────────────────────────────────────────────────────
mode = 'ok';
seen.length = 0;
const ok = await client.findFile('qb2x8fes');
const req = seen.at(-1);
check('findFile 走 POST /dsh-zotero/find-file', req.method === 'POST' && req.url === '/dsh-zotero/find-file');
check('Content-Type 是 application/json', req.contentType === 'application/json', req.contentType);
check('itemKey 被规范成大写', req.body.itemKey === 'QB2X8FES', req.body.itemKey);
check('默认不带 dryRun/force/methods', !('dryRun' in req.body) && !('force' in req.body) && !('methods' in req.body), JSON.stringify(req.body));
check('成功结果透传 attachmentKey', ok.ok === true && ok.attachmentKey === 'BBBB2222', ok.attachmentKey);
check('成功结果带解析器明细', ok.resolverCount === 4 && ok.resolvers.length === 4);

// ── 3. 可选参数 ──────────────────────────────────────────────────────
seen.length = 0;
await client.findFile('ABCD2345', { dryRun: true, force: true, methods: ['oa'] });
const opt = seen.at(-1).body;
check('dryRun/force 为 true 时下发', opt.dryRun === true && opt.force === true);
check('methods 原样下发', Array.isArray(opt.methods) && opt.methods.length === 1 && opt.methods[0] === 'oa');

// ── 4. 业务失败要当结果返回，不能抛 ─────────────────────────────────
mode = 'no-file';
const noFile = await client.findFile('ABCD2345');
check('NO_FILE_FOUND 不抛异常', noFile.ok === false && noFile.error === 'NO_FILE_FOUND', noFile.error);

mode = 'already';
const already = await client.findFile('ABCD2345');
check('alreadyHad 透传', already.ok === true && already.alreadyHad === true && already.attachmentKey === 'AAAA1111');

mode = 'item-not-found';
const notFound = await client.findFile('ZZZZ9999');
check('404 + JSON 的 ITEM_NOT_FOUND 不抛异常', notFound.ok === false && notFound.error === 'ITEM_NOT_FOUND', notFound.error);
check('ITEM_NOT_FOUND 保留 httpStatus', notFound.httpStatus === 404, String(notFound.httpStatus));

mode = 'download-error';
const dlErr = await client.findFile('ABCD2345');
check('500 + JSON 的 DOWNLOAD_ERROR 不抛异常', dlErr.ok === false && dlErr.error === 'DOWNLOAD_ERROR', dlErr.error);
check('DOWNLOAD_ERROR 带 message', dlErr.message === 'boom');

// ── 5. 桥未安装时必须是明确错误 ──────────────────────────────────────
mode = 'no-bridge';
let bridgeErr;
try {
  await client.findFile('ABCD2345');
} catch (e) {
  bridgeErr = e;
}
check('桥未安装时抛 bridge-missing', bridgeErr?.code === 'bridge-missing', bridgeErr?.code);
check('bridge-missing 的提示指向 bridge/README', /bridge\/README|桥接插件/.test(String(bridgeErr?.message ?? '')));

// ── 6. Zotero 没起来的情况 ───────────────────────────────────────────
const dead = createZoteroClient({ baseUrl: 'http://127.0.0.1:1' });
const deadStatus = await dead.bridgeStatus();
check('Zotero 不可达时 installed=false 且不抛', deadStatus.installed === false && deadStatus.reason === 'zotero-unreachable', deadStatus.reason);

server.close();

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
if (failed > 0) process.exit(1);
