/**
 * Zotero 本地 API 客户端（零依赖，仅用 node:http）。
 *
 * 设计依据：docs/zotero-api-spec.md（Phase 0 实测）。
 * 关键约束：
 *  - 响应是 HTTP/1.0 且 body 无 Content-Length → 必须 Connection: close + agent:false。
 *  - 写请求必须带 Zotero-Server-ID；写授权走 POST /api/local/authorize。
 *  - POST /items 的 body 必须是 JSON 数组；HTTP 200 也要逐对象检查 failed。
 *  - 单项状态判断一律走单条直读，列表/聚合结果不可信。
 */

import http from 'node:http';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:23119';

export class ZoteroError extends Error {
  constructor(message, { code = 'zotero-error', status, detail, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ZoteroError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

function httpRequest(url, method, { headers = {}, body, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(new ZoteroError(`无效的 Zotero 地址：${url}`, { code: 'bad-base-url', cause: e })); return; }
    const payload = body === undefined ? undefined
      : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const h = { Connection: 'close', ...headers };
    if (payload !== undefined) h['Content-Length'] = String(payload.length);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method,
      headers: h,
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* 非 JSON（如 BibTeX / 纯文本） */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new ZoteroError('Zotero 本地 API 响应超时', { code: 'timeout' })));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** 把 HTTP 失败映射成带 code 的 ZoteroError（消息直接取自 Zotero 返回体）。 */
function mapError(res) {
  const body = (res.text ?? '').trim().slice(0, 400);
  const status = res.status;
  if (status === 403 && /Local API is not enabled/i.test(body)) {
    return new ZoteroError('Zotero 本地 API 未开启：设置 → 高级 → 勾选「允许其他应用程序与 Zotero 通信」', { code: 'local-api-disabled', status, detail: body });
  }
  if (status === 401) return new ZoteroError('Zotero 写授权无效或已过期，需要重新授权', { code: 'unauthorized', status, detail: body });
  if (status === 403) return new ZoteroError(`Zotero 拒绝写入：${body || 'forbidden'}`, { code: 'forbidden', status, detail: body });
  if (status === 404) return new ZoteroError(`Zotero 中不存在该对象或资源：${body || 404}`, { code: 'not-found', status, detail: body });
  if (status === 412) return new ZoteroError(`前置条件失败（版本或实例不匹配）：${body || 412}`, { code: 'precondition-failed', status, detail: body });
  if (status === 428) return new ZoteroError(`缺少必需的前置条件：${body || 428}`, { code: 'precondition-required', status, detail: body });
  if (status === 429) return new ZoteroError('授权请求过于频繁（每分钟最多 5 次弹窗），请稍后重试', { code: 'rate-limited', status, detail: body });
  return new ZoteroError(`Zotero 返回 ${status}：${body || '无响应体'}`, { code: 'http-error', status, detail: body });
}

const CREATOR_NAME = (c) => c?.name ?? [c?.firstName, c?.lastName].filter(Boolean).join(' ');

function yearOf(date) {
  const m = /(\d{4})/.exec(String(date ?? ''));
  return m ? Number(m[1]) : null;
}

/** 子对象类型：它们不是"文献条目"，在列表里默认不单列（避免出现 PDF / Full Text PDF 这类行）。 */
export const CHILD_ITEM_TYPES = new Set(['attachment', 'note', 'annotation']);

/** 是否是可直接引用的文献条目。 */
export const isBibliographic = (item) => !CHILD_ITEM_TYPES.has(item?.data?.itemType);

/**
 * 列表过滤：丢掉"挂在父条目下的子对象"，但保留独立附件（用户单独存的 PDF）。
 * 依据：Zotero 的集合成员会包含父条目的子附件，直接展示会出现大量无题名的 PDF 行。
 */
export const keepInList = (item, includeChildItems = false) => {
  if (includeChildItems) return true;
  const d = item?.data ?? {};
  if (!CHILD_ITEM_TYPES.has(d.itemType)) return true;
  return !d.parentItem;
};

/** 条目 → 模型友好的摘要（不要直接暴露整个 API JSON，省 token）。 */
export function summarizeItem(item) {
  const d = item?.data ?? {};
  const creators = Array.isArray(d.creators) ? d.creators.map(CREATOR_NAME).filter(Boolean) : [];
  return {
    key: item.key,
    itemType: d.itemType,
    title: d.title ?? null,
    creators,
    year: yearOf(d.date),
    date: d.date ?? null,
    publication: d.publicationTitle ?? d.bookTitle ?? d.proceedingsTitle ?? d.websiteTitle ?? d.publisher ?? null,
    doi: d.DOI ?? null,
    url: d.url ?? null,
    abstractNote: d.abstractNote ? String(d.abstractNote).slice(0, 800) : null,
    tags: Array.isArray(d.tags) ? d.tags.map((t) => t.tag).filter(Boolean) : [],
    collections: d.collections ?? [],
    parentItem: d.parentItem ?? null,
    hasParent: Boolean(d.parentItem),
  };
}

export function summarizeAnnotation(a) {
  const d = a?.data ?? {};
  let position = null;
  if (typeof d.annotationPosition === 'string') {
    try { position = JSON.parse(d.annotationPosition); } catch { position = null; }
  }
  const comment = d.annotationComment ?? '';
  return {
    key: a.key,
    parentItem: d.parentItem ?? null,
    type: d.annotationType ?? null,
    text: d.annotationText ?? '',
    // 评论在 Zotero 里是 HTML（常含 <b>），同时给出纯文本版便于直接阅读/引用
    comment,
    commentText: htmlToText(comment),
    color: d.annotationColor ?? null,
    pageLabel: d.annotationPageLabel ?? null,
    pageIndex: position?.pageIndex ?? null,
    // 页面坐标（PDF 用户空间、左下原点、相对 MediaBox）——面板叠加高亮时按 pdf.js viewport 换算
    rects: Array.isArray(position?.rects) ? position.rects : null,
    sortIndex: d.annotationSortIndex ?? null,
    // true = 该标注来自 PDF 文件本身（例如先在 Acrobat 里标好再导入），pdf.js 会自己把它渲染在画布上；
    // false/缺省 = Zotero 内创建、只存在数据库里，必须由面板叠加渲染。
    external: d.annotationIsExternal === true,
    tags: Array.isArray(d.tags) ? d.tags.map((t) => t.tag).filter(Boolean) : [],
  };
}

export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * CSL 参考文献表 HTML → 纯文本。
 * Zotero 返回的 bibliography 里每一条后面都跟着一个 Z3988 COinS 元数据 span，
 * 对模型是纯噪声，必须剔除；同时把 HTML 实体还原。
 */
export function cleanBibliography(html) {
  return String(html ?? '')
    .replace(/<span[^>]*class="Z3988"[\s\S]*?<\/span>/gi, '')
    .replace(/<span[^>]*class="Z3988"[\s\S]*?\/>/gi, '')
    .replace(/<div[^>]*class="csl-entry"[^>]*>/gi, '')
    .replace(/<\/div>/gi, '\n')
    .replace(/<i>/gi, '')
    .replace(/<\/i>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}


export function createZoteroClient(options = {}) {
  const baseUrl = String(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const appName = options.appName ?? 'DSH Zotero';
  const timeoutMs = Number(options.timeoutMs ?? 15000);
  const getApiKey = options.getApiKey ?? (() => undefined);
  const setApiKey = options.setApiKey ?? (() => {});
  const maxFulltextChars = Number(options.maxFulltextChars ?? 20000);

  const state = { serverId: null, zoteroVersion: null, apiVersion: null, schemaVersion: null, libraryVersion: null };

  async function raw(method, path, { headers, body, auth = false, withServerId = false } = {}) {
    const h = { ...(headers ?? {}) };
    if (withServerId && state.serverId) h['Zotero-Server-ID'] = state.serverId;
    if (auth) {
      const key = getApiKey();
      if (key) h['Zotero-API-Key'] = key;
    }
    let res;
    try {
      res = await httpRequest(baseUrl + path, method, { headers: h, body, timeoutMs });
    } catch (e) {
      if (e instanceof ZoteroError) throw e;
      const code = e?.code ?? e?.cause?.code;
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND') {
        throw new ZoteroError(`Zotero 未运行或本地 API 不可达（${baseUrl}）。请启动 Zotero 桌面端，并在 设置 → 高级 中允许其他应用程序通信。`, { code: 'zotero-down', cause: e });
      }
      throw new ZoteroError(`访问 Zotero 本地 API 失败：${e.message}`, { code: 'network-error', cause: e });
    }
    if (res.status >= 400) throw mapError(res);
    return res;
  }

  async function handshake({ force = false } = {}) {
    if (state.serverId && !force) return { ...state };
    const res = await raw('GET', '/api/');
    state.serverId = res.headers['zotero-server-id'] ?? null;
    state.zoteroVersion = res.headers['x-zotero-version'] ?? null;
    state.apiVersion = res.headers['zotero-api-version'] ?? null;
    state.schemaVersion = res.headers['zotero-schema-version'] ?? null;
    return { ...state };
  }

  async function refreshLibraryVersion() {
    const res = await raw('GET', '/api/users/0/items?limit=1');
    state.libraryVersion = Number(res.headers['last-modified-version'] ?? 0) || null;
    return state.libraryVersion;
  }

  async function probe() {
    try {
      await handshake({ force: true });
      await refreshLibraryVersion();
      return { ok: true, ...state, writeAuthorized: Boolean(getApiKey()) };
    } catch (e) {
      return { ok: false, code: e.code ?? 'error', message: e.message, baseUrl };
    }
  }

  const q = (params) => {
    const entries = Object.entries(params ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (entries.length === 0) return '';
    return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
  };

  /**
   * 批量取条目（≤50）。
   * ⚠️ 不能用 `?itemKey=a,b,c`：实测该参数不是"精确批量取"，传父条目 key 会返回它们的
   * **子对象**（笔记/附件/标注），导致父条目解析失败。改为逐条直读 + 并发限流。
   */
  async function getItems(keys, { concurrency = 8 } = {}) {
    const list = [...new Set((keys ?? []).filter(Boolean))].slice(0, 50);
    const out = [];
    for (let i = 0; i < list.length; i += concurrency) {
      const batch = list.slice(i, i + concurrency);
      const got = await Promise.all(batch.map((k) => getItem(k).catch(() => null)));
      for (const item of got) if (item) out.push(item);
    }
    return out;
  }

  /**
   * 检索。关键处理：`qmode=everything` 的命中大量落在**附件**上（全文匹配），
   * 直接展示会出现一堆 "PDF/Full Text PDF" 行且看不出属于哪篇论文 —— 因此把
   * 挂有父条目的附件命中**归并到父条目**，按父条目去重，并记录命中的附件。
   */
  async function search({ query, itemType, limit = 20, start, sort, direction, excludeItemTypes = ['note', 'annotation'] } = {}) {
    const res = await raw('GET', `/api/users/0/items${q({ q: query, qmode: query ? 'everything' : undefined, itemType, limit, start, sort, direction, format: 'json' })}`);
    const list = Array.isArray(res.json) ? res.json : [];
    const excluded = new Set(itemType ? [] : (excludeItemTypes ?? []));

    // 把命中分成：文献条目 / 挂在父条目下的附件 / 独立附件
    const bib = [];
    const childAttachments = [];
    const standalone = [];
    for (const i of list) {
      if (excluded.has(i.data?.itemType)) continue;
      const d = i.data ?? {};
      if (CHILD_ITEM_TYPES.has(d.itemType) && d.parentItem) childAttachments.push(i);
      else if (CHILD_ITEM_TYPES.has(d.itemType)) standalone.push(i);
      else bib.push(i);
    }

    const parentKeys = [...new Set(childAttachments.map((i) => i.data.parentItem))];
    const parents = await getItems(parentKeys);
    const parentByKey = new Map(parents.map((p) => [p.key, p]));

    const out = [];
    const seen = new Set();
    for (const i of bib) {
      if (seen.has(i.key)) continue;
      seen.add(i.key);
      out.push(summarizeItem(i));
    }
    for (const i of childAttachments) {
      const parent = parentByKey.get(i.data.parentItem);
      const target = parent ?? i;
      if (seen.has(target.key)) {
        // 同一篇论文的多个附件命中：只补充命中附件清单
        const existing = out.find((x) => x.key === target.key);
        if (existing && parent) (existing.matchedAttachments ??= []).push({ key: i.key, title: i.data.title ?? null });
        continue;
      }
      seen.add(target.key);
      const summary = summarizeItem(target);
      summary.matchedAttachments = parent ? [{ key: i.key, title: i.data.title ?? null }] : undefined;
      if (!parent) summary.note = '这是一条独立附件（没有父条目）。';
      out.push(summary);
    }
    for (const i of standalone) {
      if (seen.has(i.key)) continue;
      seen.add(i.key);
      const summary = summarizeItem(i);
      summary.standaloneAttachment = true;
      summary.note = '这是一条独立附件（没有父条目），可直接打开其文件。';
      out.push(summary);
    }

    return {
      totalReported: Number(res.headers['total-results'] ?? list.length),
      count: out.length,
      rawCount: list.length,
      items: out,
    };
  }

  async function listTopItems({ limit = 20, sort = 'dateModified', direction = 'desc', includeChildItems = false } = {}) {
    const res = await raw('GET', `/api/users/0/items/top${q({ limit, sort, direction, format: 'json' })}`);
    const list = (Array.isArray(res.json) ? res.json : []).filter((i) => keepInList(i, includeChildItems));
    return { totalReported: Number(res.headers['total-results'] ?? list.length), count: list.length, items: list.map(summarizeItem) };
  }

  async function listCollections({ limit = 100 } = {}) {
    const res = await raw('GET', `/api/users/0/collections${q({ limit, format: 'json' })}`);
    const list = Array.isArray(res.json) ? res.json : [];
    return list.map((c) => ({ key: c.key, name: c.data?.name ?? '(未命名)', parentCollection: c.data?.parentCollection ?? false, itemCount: c.meta?.numItems ?? null }));
  }

  async function listCollectionItems(collectionKey, { limit = 50, includeChildItems = false } = {}) {
    // 无效集合 key 不会报错（实测返回 200 + 无意义计数）→ 先单条校验
    await raw('GET', `/api/users/0/collections/${collectionKey}${q({ format: 'json' })}`);
    const res = await raw('GET', `/api/users/0/collections/${collectionKey}/items${q({ limit: 200, format: 'json' })}`);
    const all = Array.isArray(res.json) ? res.json : [];
    // 集合成员包含父条目的子附件（实测某分类 77 = 23 期刊 + 45 附件 + 6 笔记）→ 默认只列文献条目
    const items = all.filter((i) => keepInList(i, includeChildItems)).slice(0, limit);
    return { count: items.length, totalMembers: all.length, items: items.map(summarizeItem) };
  }

  async function getItem(key) {
    const res = await raw('GET', `/api/users/0/items/${key}${q({ format: 'json' })}`);
    return res.json;
  }

  async function getChildren(key, itemType) {
    const res = await raw('GET', `/api/users/0/items/${key}/children${q({ itemType, limit: 200, format: 'json' })}`);
    return Array.isArray(res.json) ? res.json : [];
  }

  /** 附件的标注。注意：/children 不带 itemType 时实测返回空，必须显式带上。 */
  async function getAnnotations(key, { types } = {}) {
    let attachments = [key];
    const item = await getItem(key);
    if (item?.data?.itemType !== 'attachment') {
      const kids = await getChildren(key, 'attachment');
      attachments = kids.filter((k) => k.data?.contentType === 'application/pdf' || k.data?.contentType === 'application/epub+zip' || /html/.test(k.data?.contentType ?? '')).map((k) => k.key);
      if (attachments.length === 0) attachments = kids.map((k) => k.key);
    }
    const out = [];
    for (const att of attachments) {
      const anns = await getChildren(att, 'annotation');
      for (const a of anns) {
        const s = summarizeAnnotation(a);
        s.attachmentKey = att;
        if (!types || types.includes(s.type)) out.push(s);
      }
    }
    // 阅读顺序：先按页，再按 sortIndex（Zotero 的页内位置串，零填充可字典序比较），最后按 key 稳定兜底
    out.sort((a, b) => (a.pageIndex ?? 0) - (b.pageIndex ?? 0)
      || String(a.sortIndex ?? '').localeCompare(String(b.sortIndex ?? ''))
      || String(a.key).localeCompare(String(b.key)));
    return { count: out.length, attachments, annotations: out };
  }

  /**
   * 读取笔记。参数可以是**父条目 key**（返回它的全部子笔记），
   * 也可以是**笔记自身的 key**（只返回该条笔记）。
   */
  async function getNotes(key, { maxCharsPerNote = 4000 } = {}) {
    const raw = await getItem(key);
    const isNote = raw?.data?.itemType === 'note';
    const parent = isNote ? (raw.data.parentItem ?? null) : key;
    const children = parent ? await getChildren(parent, 'note') : [];
    const list = isNote && !children.some((n) => n.key === key) ? [raw, ...children] : children;
    return list.map((n) => {
      const html = String(n.data?.note ?? '');
      const text = htmlToText(html);
      return {
        key: n.key,
        parentItem: n.data?.parentItem ?? null,
        htmlChars: html.length,
        textChars: text.length,
        truncated: text.length > maxCharsPerNote,
        text: text.slice(0, maxCharsPerNote),
      };
    });
  }

  async function getFulltext(attachmentKey, { maxChars = maxFulltextChars, offset = 0 } = {}) {
    const res = await raw('GET', `/api/users/0/items/${attachmentKey}/fulltext`);
    const content = String(res.json?.content ?? '');
    const slice = content.slice(Math.max(0, offset), Math.max(0, offset) + maxChars);
    return {
      attachmentKey,
      chars: content.length,
      offset,
      returned: slice.length,
      truncated: offset + slice.length < content.length,
      indexedPages: res.json?.indexedPages ?? null,
      totalPages: res.json?.totalPages ?? null,
      indexedChars: res.json?.indexedChars ?? null,
      totalChars: res.json?.totalChars ?? null,
      content: slice,
    };
  }

  /**
   * 附件信息：解析出本地绝对路径与大小，供面板内嵌阅读（PDF/EPUB/HTML）。
   * 路径来源是 Zotero 的 /file/view/url（file:// URL），API 的条目 JSON 里没有路径字段。
   */
  async function getAttachmentInfo(key) {
    const raw = await getItem(key);
    const data = raw?.data ?? {};
    const isAttachment = data.itemType === 'attachment';
    let fileUrl = null;
    if (isAttachment) {
      try { fileUrl = (await getFileUrl(key)).trim(); } catch { fileUrl = null; }
    }
    let localPath = null;
    if (fileUrl && fileUrl.startsWith('file://')) {
      try { localPath = fileURLToPath(fileUrl); } catch { localPath = null; }
    }
    let size = null;
    let exists = false;
    if (localPath) {
      try {
        const info = await stat(localPath);
        size = info.size;
        exists = info.isFile();
      } catch { exists = false; }
    }
    const contentType = data.contentType ?? null;
    const viewable = Boolean(exists) && (/pdf|epub|html|text\/plain|image\//.test(contentType ?? ''));
    return {
      key,
      found: true,
      itemType: data.itemType ?? null,
      title: data.title ?? null,
      filename: data.filename ?? null,
      contentType,
      linkMode: data.linkMode ?? null,
      fileUrl,
      path: localPath,
      size,
      exists,
      viewable,
    };
  }

  async function getBibtex(key) {
    const res = await raw('GET', `/api/users/0/items/${key}${q({ format: 'bibtex' })}`);
    return res.text;
  }

  async function getCitation(keys, { style = 'apa', locale = 'zh-CN' } = {}) {
    const out = [];
    for (const key of keys) {
      const res = await raw('GET', `/api/users/0/items/${key}${q({ include: 'data,citation', style, locale, format: 'json' })}`);
      out.push({ key, itemType: res.json?.data?.itemType ?? null, title: res.json?.data?.title ?? null, citation: res.json?.citation ?? '' });
    }
    return { style, locale, citations: out };
  }

  async function getBibliography(keys, { style = 'apa', locale = 'zh-CN' } = {}) {
    const res = await raw('GET', `/api/users/0/items${q({ itemKey: keys.join(','), format: 'bib', style, locale })}`);
    return res.text;
  }

  async function getFileUrl(attachmentKey) {
    const res = await raw('GET', `/api/users/0/items/${attachmentKey}/file/view/url`);
    return res.text.trim();
  }

  async function authorize() {
    await handshake();
    const res = await raw('POST', '/api/local/authorize', {
      headers: { 'Content-Type': 'application/json' },
      body: { appName },
      withServerId: true,
    });
    const key = res.json?.key;
    if (!key) throw new ZoteroError('Zotero 未返回授权密钥', { code: 'authorize-failed', detail: res.text });
    setApiKey(key);
    return { authorized: true, remember: res.json?.remember === true, keyLength: key.length };
  }

  /** 写子笔记（Phase 0 实测唯一完全可靠的写通道）。 */
  async function createNotes(notes) {
    await handshake();
    const body = notes.map((n) => ({
      itemType: 'note',
      ...(n.parentItem ? { parentItem: n.parentItem } : {}),
      note: String(n.html ?? ''),
      ...(n.tags?.length ? { tags: n.tags.map((tag) => ({ tag })) } : {}),
    }));
    const res = await raw('POST', '/api/users/0/items', {
      headers: { 'Content-Type': 'application/json' },
      body,
      auth: true,
      withServerId: true,
    });
    const json = res.json ?? {};
    return {
      httpStatus: res.status,
      success: json.success ?? {},
      successful: json.successful ?? {},
      failed: json.failed ?? {},
      unchanged: json.unchanged ?? {},
      lastModifiedVersion: res.headers['last-modified-version'] ?? null,
    };
  }

  return {
    baseUrl,
    state,
    probe,
    handshake,
    refreshLibraryVersion,
    search,
    listTopItems,
    listCollections,
    listCollectionItems,
    getItem,
    getItems,
    getChildren,
    getAnnotations,
    getNotes,
    getFulltext,
    getAttachmentInfo,
    getBibtex,
    getCitation,
    getBibliography,
    getFileUrl,
    authorize,
    createNotes,
  };
}
