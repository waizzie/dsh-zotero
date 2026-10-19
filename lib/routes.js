/**
 * 供侧边栏面板调用的同源路由：
 *   POST /dsh-zotero/api/<method>      查询/会话状态
 *   GET  /dsh-zotero/file?key=<附件>    附件字节流（支持 Range）
 *   GET  /dsh-zotero/vendor/<pdfjs…>   pdf.js 静态资源（面板自绘 PDF + 叠加标注用）
 *
 * 安全约定（Phase 0 教训）：
 *  - 只接受 loopback Host（信任围栏）；
 *  - 只做只读查询 + 面板状态读写；**不做任何 Zotero 侧删除/恢复**；
 *  - 写回 Zotero 只能通过模型工具 zotero_create_note（带 allowWrite 门控与用户确认）。
 */

import { createReadStream } from 'node:fs';
import { cleanBibliography } from './zotero-client.js';
import { createPdfAssets } from './pdf-assets.js';

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(body.length) });
  res.end(body);
}

function sendText(res, status, text) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(body.length) });
  res.end(body);
}

function readJsonBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') { resolve({}); return; }
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(`请求体不是合法 JSON：${e.message}`)); }
    });
    req.on('error', reject);
  });
}

export function registerRoutes(ctx, { client, sessionState, settings, keyStore, panelState, log = () => {} }) {
  const pdfAssets = createPdfAssets();
  if (!pdfAssets.exists()) log(`pdf.js 不可用：${pdfAssets.error ?? '未找到 build/pdf.mjs'}（面板将回退到浏览器原生 PDF 阅读器，标注叠加不可用）`);
  else log(`pdf.js 就绪（pdfjs-dist ${pdfAssets.version}）`);

  // 面板挂载诊断：client 半每次尝试挂载侧栏都会上报，status 里回显最近一次。
  // 用途：better-sidebar 缺失/更新失败导致面板不出现时，能给出确切原因而不是"打不开"。
  const panel = panelState ?? { last: null };

  const methods = {
    async status() {
      const p = await client.probe();
      return {
        connected: p.ok === true,
        baseUrl: client.baseUrl,
        zoteroVersion: p.zoteroVersion ?? null,
        apiVersion: p.apiVersion ?? null,
        schemaVersion: p.schemaVersion ?? null,
        serverId: p.serverId ?? null,
        libraryVersion: p.libraryVersion ?? null,
        writeAuthorized: p.writeAuthorized === true,
        writeEnabled: settings.allowWrite,
        credential: await keyStore.describe(),
        pdfjs: { available: pdfAssets.exists(), version: pdfAssets.version, error: pdfAssets.error ?? null },
        panel: panel.last,
        ...(p.ok ? {} : { code: p.code ?? 'error', message: p.message ?? '未知错误' }),
      };
    },

    /** client 半上报面板挂载结果（只读诊断，不写 Zotero）。 */
    async 'panel.report'({ attached, reason, serviceVersion, features, at, sessionId } = {}) {
      panel.last = {
        attached: attached === true,
        reason: typeof reason === 'string' ? reason : '',
        serviceVersion: typeof serviceVersion === 'string' ? serviceVersion : null,
        features: Array.isArray(features) ? features.filter((f) => typeof f === 'string') : null,
        at: Number.isFinite(at) ? at : Date.now(),
        sessionId: typeof sessionId === 'string' ? sessionId : null,
      };
      return { panel: panel.last };
    },

    async collections({ limit } = {}) {
      return { collections: await client.listCollections({ limit: Number(limit) || 200 }) };
    },

    async fileinfo({ key } = {}) {
      if (!key) throw new Error('缺少 key');
      return client.getAttachmentInfo(key);
    },

    async items({ collection, limit, sort, direction, includeChildItems } = {}) {
      if (collection) return client.listCollectionItems(collection, { limit: Number(limit) || 100, includeChildItems: includeChildItems === true });
      return client.listTopItems({ limit: Number(limit) || 30, sort: sort || 'dateModified', direction: direction || 'desc', includeChildItems: includeChildItems === true });
    },

    async search({ query, itemType, limit } = {}) {
      if (!query) throw new Error('缺少 query');
      return client.search({ query, itemType, limit: Number(limit) || 20 });
    },

    async item({ key } = {}) {
      if (!key) throw new Error('缺少 key');
      const raw = await client.getItem(key);
      const d = raw?.data ?? {};
      const isChild = d.itemType === 'attachment' || d.itemType === 'note' || d.itemType === 'annotation';
      // 子对象（尤其附件）：详情必须能直接对其自身操作，否则界面里没有"打开"入口
      const self = isChild ? {
        key,
        itemType: d.itemType,
        title: d.title ?? null,
        filename: d.filename ?? null,
        contentType: d.contentType ?? null,
        linkMode: d.linkMode ?? null,
        parentItem: d.parentItem ?? null,
        file: d.itemType === 'attachment' ? await client.getAttachmentInfo(key).catch(() => null) : null,
      } : null;
      const parent = isChild && d.parentItem ? (await client.getItem(d.parentItem).catch(() => null)) : null;
      const attachments = isChild ? [] : (await client.getChildren(key, 'attachment')).map((a) => ({
        key: a.key, title: a.data?.title ?? null, filename: a.data?.filename ?? null, contentType: a.data?.contentType ?? null,
      }));
      const notes = (await client.getChildren(key, 'note').catch(() => [])).map((n) => ({
        key: n.key, chars: String(n.data?.note ?? '').length,
      }));
      return {
        item: raw,
        self,
        parent: parent ? { key: parent.key, title: parent.data?.title ?? null, itemType: parent.data?.itemType ?? null } : null,
        attachments,
        notes,
      };
    },

    async annotations({ key, types } = {}) {
      if (!key) throw new Error('缺少 key');
      return client.getAnnotations(key, { types: types ? String(types).split(',').map((s) => s.trim()).filter(Boolean) : undefined });
    },

    async notes({ key, maxCharsPerNote } = {}) {
      if (!key) throw new Error('缺少 key');
      return { notes: await client.getNotes(key, { maxCharsPerNote: Number(maxCharsPerNote) || 4000 }) };
    },

    async fulltext({ key, maxChars, offset } = {}) {
      if (!key) throw new Error('缺少 key');
      return client.getFulltext(key, { maxChars: Number(maxChars) || settings.maxFulltextChars, offset: Number(offset) || 0 });
    },

    async citation({ keys, style, locale } = {}) {
      const list = String(keys ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length === 0) throw new Error('缺少 keys');
      const citations = await client.getCitation(list, { style: style || 'apa', locale: locale || 'zh-CN' });
      let bibliography = '';
      try { bibliography = cleanBibliography(await client.getBibliography(list, { style: style || 'apa', locale: locale || 'zh-CN' })); } catch { /* 可选 */ }
      return { ...citations, bibliography };
    },

    async bibtex({ keys } = {}) {
      const list = String(keys ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length === 0) throw new Error('缺少 keys');
      const entries = [];
      for (const key of list) entries.push({ key, bibtex: await client.getBibtex(key) });
      return { entries };
    },

    async 'selection.get'({ sessionId } = {}) {
      return sessionState.get(sessionId);
    },

    async 'selection.set'({ sessionId, items, annotations, note } = {}) {
      return sessionState.set(sessionId, { items, annotations, note });
    },

    async 'selection.clear'({ sessionId } = {}) {
      sessionState.clear(sessionId);
      return { cleared: true };
    },
  };

  const disposeApi = ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-zotero/api',
    handler: async (req, res) => {
      const host = String(req.headers.host ?? '');
      if (!LOOPBACK_HOST.test(host)) { sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden host' } }); return; }
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: { code: 'method-error', message: 'POST only' } }); return; }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const method = pathname.startsWith('/dsh-zotero/api/') ? pathname.slice('/dsh-zotero/api/'.length) : '';
      if (!method || method.includes('/')) { sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } }); return; }
      const handler = methods[method];
      if (!handler) { sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${method}"` } }); return; }
      try {
        const payload = await readJsonBody(req);
        sendJson(res, 200, { ok: true, value: await handler(payload) });
      } catch (e) {
        log(`zotero route ${method} 失败：${e?.message}`);
        sendJson(res, 200, { ok: false, error: { code: e?.code ?? 'error', message: e?.message ?? String(e) } });
      }
    },
  });

  // ── 附件字节流：面板内嵌阅读（GET，支持 Range 以便 PDF 阅读器按需取页）──
  const disposeFile = ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-zotero/file',
    handler: async (req, res) => {
      if (!LOOPBACK_HOST.test(String(req.headers.host ?? ''))) { sendText(res, 403, 'forbidden host'); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { sendText(res, 405, 'GET only'); return; }
      const url = new URL(req.url ?? '/', 'http://dsh.internal');
      const key = url.searchParams.get('key');
      if (!key) { sendText(res, 400, 'missing key'); return; }
      let info;
      try {
        info = await client.getAttachmentInfo(key);
      } catch (e) {
        sendText(res, 502, `读取附件信息失败：${e?.message ?? e}`);
        return;
      }
      if (!info.exists || !info.path) {
        sendText(res, 404, info.fileUrl ? `附件文件不存在：${info.path ?? ''}` : '该条目没有本地文件（可能是链接型或尚未下载的附件）');
        return;
      }
      const headers = {
        'Content-Type': info.contentType || 'application/octet-stream',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(info.filename || 'attachment')}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      };
      const total = info.size ?? 0;
      let start = 0;
      let end = Math.max(0, total - 1);
      let status = 200;
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
        if (match) {
          if (match[1] === '' && match[2] !== '') { start = Math.max(0, total - Number(match[2])); end = total - 1; }
          else {
            start = Number(match[1]);
            if (match[2] !== '') end = Math.min(Number(match[2]), total - 1);
          }
          if (!Number.isFinite(start) || start >= total || end < start) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` });
            res.end();
            return;
          }
          status = 206;
          headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
        }
      }
      headers['Content-Length'] = String(Math.max(0, end - start + 1));
      res.writeHead(status, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(info.path, { start, end });
      stream.on('error', (e) => {
        log(`附件流读取失败 ${info.path}：${e?.message}`);
        try { res.destroy(); } catch { /* noop */ }
      });
      stream.pipe(res);
    },
  });

  // ── pdf.js 静态资源（面板自绘 PDF 用；白名单 + 路径穿越校验）──
  const disposeVendor = ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-zotero/vendor',
    handler: async (req, res) => {
      if (!LOOPBACK_HOST.test(String(req.headers.host ?? ''))) { sendText(res, 403, 'forbidden host'); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { sendText(res, 405, 'GET only'); return; }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const rel = pathname.startsWith('/dsh-zotero/vendor/') ? pathname.slice('/dsh-zotero/vendor/'.length) : '';
      await pdfAssets.serve(req, res, decodeURIComponent(rel));
    },
  });

  return () => {
    try { disposeApi(); } catch { /* noop */ }
    try { disposeFile(); } catch { /* noop */ }
    try { disposeVendor(); } catch { /* noop */ }
  };
}
