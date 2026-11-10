/* DSH Zotero Bridge — bootstrap.js
 *
 * 作用：把 Zotero 内置的「查找可用文件 / Find Available File」暴露成两个本地 HTTP 端点，
 * 供 DeepSeek Harness 的 dsh-zotero 插件调用。
 *
 *   GET  /dsh-zotero/ping       探活 + 版本 + 能力
 *   POST /dsh-zotero/find-file  为某条目下载并挂上 PDF/EPUB
 *
 * 为什么需要这个插件：Zotero 的本地 API（/api/...）没有任何「查找原文」端点，
 * 真正的解析逻辑（Zotero.Attachments.getFileResolvers / addFileFromURLs）只在
 * Zotero 进程内的 JS 上下文里可用，外部进程调不到。本插件只是把这个内置能力
 * 用 Zotero.Server.Endpoints 转成一个端点，不自己实现任何抓取逻辑。
 *
 * 安全：端点只随 Zotero 的本地服务监听 127.0.0.1:23119，不对外网开放。
 * 如需额外防护，可在 Zotero 高级设置里加一条字符串偏好
 *   extensions.zotero.dshBridge.token = <随机串>
 * 之后所有请求必须带 X-DSH-Bridge-Token 头，否则返回 403。
 */

/* global Zotero */

const BRIDGE_VERSION = '0.1.2';
const PING_PATH = '/dsh-zotero/ping';
const FIND_PATH = '/dsh-zotero/find-file';
const TOKEN_PREF = 'extensions.zotero.dshBridge.token';
// 与 Zotero.Attachments.FIND_AVAILABLE_FILE_TYPES 保持一致
const FILE_TYPES = ['application/pdf', 'application/epub+zip'];

let registeredPaths = [];

function log(msg) {
  try {
    Zotero.debug(`[dsh-zotero-bridge] ${msg}`);
  }
  catch {
    // 日志失败不能影响端点
  }
}

function json(status, payload) {
  return [status, 'application/json', JSON.stringify(payload)];
}

function tokenAccepted(headers) {
  let expected = '';
  try {
    expected = String(Zotero.Prefs.get(TOKEN_PREF) ?? '');
  }
  catch {
    expected = '';
  }
  if (!expected) return true;
  return headers?.['x-dsh-bridge-token'] === expected;
}

function describeResolver(resolver) {
  if (typeof resolver === 'function') return 'custom';
  return resolver?.accessMethod ?? resolver?.pageURL ?? 'unknown';
}

function findExistingFile(item) {
  try {
    for (const id of item.getAttachments() ?? []) {
      const att = Zotero.Items.get(id);
      if (att && att.isFileAttachment() && FILE_TYPES.includes(att.attachmentContentType)) {
        return att;
      }
    }
  }
  catch (e) {
    log(`existing-attachment check failed: ${e}`);
  }
  return null;
}

class PingEndpoint {
  supportedMethods = ['GET', 'POST'];

  supportedDataTypes = ['application/json'];

  init({ headers }) {
    if (!tokenAccepted(headers)) return json(403, { ok: false, error: 'BAD_TOKEN' });
    return json(200, {
      ok: true,
      bridge: 'dsh-zotero-bridge',
      version: BRIDGE_VERSION,
      zoteroVersion: Zotero.version,
      supportedFileTypes: FILE_TYPES,
      canFindFiles: typeof Zotero.Attachments?.getFileResolvers === 'function'
        && typeof Zotero.Attachments?.addFileFromURLs === 'function',
    });
  }
}

class FindFileEndpoint {
  supportedMethods = ['POST'];

  supportedDataTypes = ['application/json'];

  async init({ data, headers }) {
    if (!tokenAccepted(headers)) return json(403, { ok: false, error: 'BAD_TOKEN' });

    let body = data;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      }
      catch {
        return json(400, { ok: false, error: 'BAD_JSON' });
      }
    }
    if (!body || typeof body !== 'object') return json(400, { ok: false, error: 'BAD_BODY' });

    const itemKey = String(body.itemKey ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(itemKey)) {
      return json(400, { ok: false, error: 'BAD_ITEM_KEY', itemKey });
    }

    const libraryID = Number.isInteger(body.libraryID)
      ? body.libraryID
      : Zotero.Libraries.userLibraryID;

    let item;
    try {
      item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
    }
    catch (e) {
      return json(500, { ok: false, error: 'LOOKUP_FAILED', message: String(e?.message ?? e) });
    }
    if (!item) return json(404, { ok: false, error: 'ITEM_NOT_FOUND', itemKey });
    if (!item.isRegularItem()) {
      return json(400, {
        ok: false,
        error: 'NOT_REGULAR_ITEM',
        itemKey,
        itemType: Zotero.ItemTypes.getName(item.itemTypeID),
      });
    }

    // 已有 PDF/EPUB 就不重复下载（force=true 可强制再试）
    const existing = findExistingFile(item);
    if (existing && body.force !== true) {
      return json(200, {
        ok: true,
        itemKey,
        alreadyHad: true,
        attachmentKey: existing.key,
        attachmentTitle: existing.getField('title') ?? '',
        contentType: existing.attachmentContentType ?? '',
        resolverCount: 0,
      });
    }

    const methods = Array.isArray(body.methods) && body.methods.length > 0
      ? body.methods.map(String)
      : ['doi', 'url', 'oa', 'custom'];

    let resolvers = [];
    try {
      resolvers = Zotero.Attachments.getFileResolvers(item, methods, body.automatic !== false) || [];
    }
    catch (e) {
      return json(500, { ok: false, error: 'RESOLVER_ERROR', message: String(e?.message ?? e) });
    }

    const labels = resolvers.map(describeResolver);
    if (resolvers.length === 0) {
      return json(200, { ok: false, error: 'NO_RESOLVERS', itemKey, methods, resolverCount: 0 });
    }
    if (body.dryRun === true) {
      return json(200, {
        ok: true,
        dryRun: true,
        itemKey,
        methods,
        resolverCount: resolvers.length,
        resolvers: labels,
      });
    }

    let attachment = false;
    try {
      attachment = await Zotero.Attachments.addFileFromURLs(item, resolvers);
    }
    catch (e) {
      log(`addFileFromURLs failed: ${e}`);
      return json(500, {
        ok: false,
        error: 'DOWNLOAD_ERROR',
        message: String(e?.message ?? e),
        resolverCount: resolvers.length,
        resolvers: labels,
      });
    }

    if (!attachment) {
      return json(200, {
        ok: false,
        error: 'NO_FILE_FOUND',
        itemKey,
        resolverCount: resolvers.length,
        resolvers: labels,
      });
    }

    return json(200, {
      ok: true,
      itemKey,
      attachmentKey: attachment.key,
      attachmentTitle: attachment.getField('title') ?? '',
      contentType: attachment.attachmentContentType ?? '',
      resolverCount: resolvers.length,
      resolvers: labels,
    });
  }
}

async function startup({ version } = {}) {
  try {
    await Zotero.initializationPromise;
  }
  catch (e) {
    log(`waiting for Zotero init failed: ${e}`);
  }

  if (!Zotero.Server?.Endpoints) {
    log('Zotero.Server 不可用，端点未注册');
    return;
  }

  registeredPaths = [PING_PATH, FIND_PATH];
  Zotero.Server.Endpoints[PING_PATH] = PingEndpoint;
  Zotero.Server.Endpoints[FIND_PATH] = FindFileEndpoint;
  log(`v${version ?? BRIDGE_VERSION} 已注册 ${PING_PATH} 与 ${FIND_PATH}`);
}

function shutdown() {
  for (const path of registeredPaths) {
    try {
      delete Zotero.Server.Endpoints[path];
    }
    catch {
      // 忽略
    }
  }
  registeredPaths = [];
  log('端点已注销');
}

function install() {}

function uninstall() {}
