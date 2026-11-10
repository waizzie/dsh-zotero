/**
 * 模型可见的 Zotero 工具。
 *
 * ctx.tools.register() 的契约：普通对象 + output{schema, render}，且 `parameters`
 * 必须是**带根 type:'object' 的 JSON Schema**（registry 原样透传给模型，不做编译）。
 * 所以这里用 params() 把可读的属性表补成合法 JSON Schema —— 因而无需 defineTool，保持零依赖。
 *
 * 范围说明（按用户决定）：只读能力 + **子笔记写回**；
 * 高亮/标注的创建与坐标计算本轮不实现（调研结论保留在 docs/zotero-api-spec.md §4.4/§5）。
 */

const textRender = (fn) => (_args, value) => [{ type: 'text', text: fn(value) }];
const OUT = { type: 'object', additionalProperties: true };

/** 属性表 → JSON Schema 对象根（属性上的 required:true 提取为根 required 数组）。 */
function params(spec) {
  const properties = {};
  const required = [];
  for (const [name, value] of Object.entries(spec ?? {})) {
    const { required: isRequired, ...rest } = value ?? {};
    properties[name] = rest;
    if (isRequired === true) required.push(name);
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

import { summarizeItem, htmlToText, cleanBibliography } from './zotero-client.js';
import { openPdf, locateText, buildHighlight, describeLocation } from './annotations.js';

const creatorsLine = (item) => {
  const c = item.creators ?? [];
  if (c.length === 0) return '佚名';
  return c.length > 3 ? `${c.slice(0, 3).join(', ')} 等` : c.join(', ');
};

const itemLine = (item, index) => {
  const bits = [`[${item.key}]`, `${creatorsLine(item)} (${item.year ?? 'n.d.'})`, item.title ?? '(无标题)'];
  if (item.publication) bits.push(`— ${item.publication}`);
  if (item.doi) bits.push(`DOI ${item.doi}`);
  return `${index === undefined ? '- ' : `${index + 1}. `}${bits.join(' ')}`;
};

export function createTools({ client, sessionState, settings, keyStore, panelState, log = () => {} }) {
  const guard = (exec) => { try { exec?.signal?.throwIfAborted?.(); } catch { /* 忽略 */ } };

  const ensureWriteAllowed = () => {
    if (!settings.allowWrite) {
      throw new Error('Zotero 写回当前被关闭：请让用户点侧栏面板头部的「写回：关」按钮开启（或把插件配置 allowWrite 设为 true）；首次写入时在 Zotero 弹窗点「Always Allow」。');
    }
  };

  const ensureAuthorized = async () => {
    if (keyStore.get()) return;
    // client.authorize() 内部会把 key 交给 setApiKey，由 index.js 接到 keyStore.save
    await client.authorize();
    log('zotero: 已获得写授权');
  };

  const tools = [];

  // ── zotero_status ────────────────────────────────────────────────
  tools.push({
    name: 'zotero_status',
    description: '检查本机 Zotero 本地 API 的连通性、版本与写授权状态。在其它 zotero_* 工具报错时先用它定位原因（Zotero 未运行 / 本地 API 未开启 / 未授权写入）。',
    parameters: params({}),
    output: {
      schema: OUT,
      render: textRender((v) => {
        const base = v.connected
          ? `Zotero ${v.zoteroVersion ?? '(未知版本)'} 已连接 · 本地 API v${v.apiVersion ?? '?'} · 库版本 ${v.libraryVersion ?? '?'} · 写授权：${v.writeAuthorized ? '已授权' : '未授权'}`
          : `未连接：${v.message}`;
        const panel = v.panel
          ? (v.panel.attached
            ? ` · 面板已挂载${v.panel.serviceVersion ? `（侧栏 ${v.panel.serviceVersion}）` : ''}`
            : ` · 面板未挂载：${v.panel.reason || '原因未知'}`)
          : '';
        return base + panel;
      }),
    },
    execute: async (_args, exec) => {
      guard(exec);
      const p = await client.probe();
      const panel = panelState?.last ?? null;
      if (!p.ok) {
        return { connected: false, baseUrl: p.baseUrl, code: p.code, message: p.message, writeAuthorized: false, panel };
      }
      const cred = await keyStore.describe();
      return {
        connected: true,
        baseUrl: client.baseUrl,
        zoteroVersion: p.zoteroVersion,
        apiVersion: p.apiVersion,
        schemaVersion: p.schemaVersion,
        serverId: p.serverId,
        libraryVersion: p.libraryVersion,
        writeAuthorized: Boolean(p.writeAuthorized),
        writeEnabled: settings.allowWrite,
        credential: cred,
        panel,
      };
    },
  });

  // ── zotero_search ────────────────────────────────────────────────
  tools.push({
    name: 'zotero_search',
    description: '检索 Zotero 文献库（默认含全文检索：题名/作者/年份 + PDF 全文内容）。返回条目 key、题录摘要、DOI 等。用于"找和某主题相关的文献"。',
    parameters: params({
      query: { type: 'string', required: true, description: '检索词（题名/作者/全文均可），例如 "deep learning" 或 "climate change"' },
      itemType: { type: 'string', description: '可选：限定条目类型，如 journalArticle / conferencePaper / note / attachment' },
      limit: { type: 'number', description: '返回条数上限，默认 20，最大 50' },
    }),
    output: {
      schema: OUT,
      render: textRender((v) => v.count === 0
        ? `Zotero 中没有匹配「${v.query}」的条目。`
        : `Zotero 检索「${v.query}」：返回 ${v.count} 条（库内报告 ${v.totalReported} 条）\n${v.items.map((i) => itemLine(i)).join('\n')}`),
    },
    execute: async ({ query, itemType, limit }, exec) => {
      guard(exec);
      const res = await client.search({ query, itemType, limit: Math.min(Math.max(Number(limit) || 20, 1), 50) });
      return { query, ...res };
    },
  });

  // ── zotero_item ──────────────────────────────────────────────────
  tools.push({
    name: 'zotero_item',
    description: '读取单条 Zotero 文献的完整元数据，并列出它的附件、笔记与标注数量。用 search 拿到 key 之后再调用。',
    parameters: params({ key: { type: 'string', required: true, description: '条目 key（8 位，如 ABCD2345）' } }),
    output: {
      schema: OUT,
      render: textRender((v) => {
        if (!v.found) return `未找到条目 ${v.key}：${v.message ?? ''}`;
        const lines = [itemLine(v.item), `  类型 ${v.item.itemType}｜标签 ${v.item.tags.join(', ') || '无'}`];
        if (v.attachmentCount !== undefined) lines.push(`  附件 ${v.attachmentCount} 个，标注 ${v.annotationCount} 条，子笔记 ${v.noteCount} 条`);
        for (const a of v.attachments) lines.push(`    · 附件 [${a.key}] ${a.title ?? a.filename ?? ''} (${a.contentType ?? '未知类型'})`);
        if (v.abstractNote) lines.push(`  摘要：${v.abstractNote.slice(0, 300)}${v.abstractNote.length > 300 ? '…' : ''}`);
        return lines.join('\n');
      }),
    },
    execute: async ({ key }, exec) => {
      guard(exec);
      const raw = await client.getItem(key);
      const data = raw?.data ?? {};
      const list = (await client.getChildren(key, 'attachment')).map((a) => ({
        key: a.key, title: a.data?.title ?? null, filename: a.data?.filename ?? null, contentType: a.data?.contentType ?? null,
      }));
      const notes = await client.getChildren(key, 'note');
      let annotationCount = 0;
      for (const att of list) {
        if (/pdf|epub|html/.test(att.contentType ?? '')) annotationCount += (await client.getChildren(att.key, 'annotation')).length;
      }
      return {
        found: true,
        key,
        version: raw?.version ?? null,
        item: summarizeItem(raw),
        abstractNote: data.abstractNote ?? null,
        attachments: list,
        attachmentCount: list.length,
        noteCount: notes.length,
        annotationCount,
      };
    },
  });

  // ── zotero_annotations ───────────────────────────────────────────
  tools.push({
    name: 'zotero_annotations',
    description: '读取某条目（或其 PDF/EPUB 附件）的全部标注：高亮/下划线文字、用户写的评论、页码与颜色。这是理解用户阅读重点最有效的入口。',
    parameters: params({
      key: { type: 'string', required: true, description: '条目 key 或附件 key' },
      types: { type: 'string', description: '可选：逗号分隔的标注类型过滤，如 highlight,underline' },
      maxCommentChars: { type: 'number', description: '单条评论截断长度，默认 1000' },
    }),
    output: {
      schema: OUT,
      render: textRender((v) => {
        if (v.count === 0) return `条目 ${v.key} 没有标注（已检查附件：${(v.attachments ?? []).join(', ') || '无'}）。`;
        return `共 ${v.count} 条标注（按阅读顺序）：\n${v.annotations.map((a) => {
          const head = `- [${a.key}] p.${a.pageLabel ?? a.pageIndex ?? '?'} ${a.type}：${a.text || '(无选中文字)'}`;
          const c = a.commentText ?? a.comment;
          return c ? `${head}\n    评论：${c}` : head;
        }).join('\n')}`;
      }),
    },
    execute: async ({ key, types, maxCommentChars }, exec) => {
      guard(exec);
      const res = await client.getAnnotations(key, { types: types ? String(types).split(',').map((s) => s.trim()).filter(Boolean) : undefined });
      const cap = Math.min(Math.max(Number(maxCommentChars) || 1000, 100), 4000);
      return {
        key,
        types: types ?? null,
        ...res,
        annotations: res.annotations.map((a) => ({
          ...a,
          comment: a.comment.slice(0, cap),
          commentText: (a.commentText ?? '').slice(0, cap),
        })),
      };
    },
  });

  // ── zotero_notes ─────────────────────────────────────────────────
  tools.push({
    name: 'zotero_notes',
    description: '读取某条目的子笔记（HTML 转纯文本），或指定笔记 key 的正文。笔记常包含用户的阅读总结。',
    parameters: params({
      key: { type: 'string', required: true, description: '条目 key，或某条笔记自身的 key' },
      maxCharsPerNote: { type: 'number', description: '单条笔记截断长度，默认 4000' },
    }),
    output: {
      schema: OUT,
      render: textRender((v) => v.notes.length === 0
        ? `条目 ${v.key} 没有笔记。`
        : v.notes.map((n) => `【笔记 ${n.key}】${n.textChars} 字${n.truncated ? '（已截断）' : ''}\n${n.text}`).join('\n\n---\n\n')),
    },
    execute: async ({ key, maxCharsPerNote }, exec) => {
      guard(exec);
      const cap = Math.min(Math.max(Number(maxCharsPerNote) || 4000, 200), 20000);
      // getNotes 同时接受父条目 key 与笔记自身 key
      const notesOut = await client.getNotes(key, { maxCharsPerNote: cap });
      return { key, count: notesOut.length, notes: notesOut };
    },
  });

  // ── zotero_fulltext ──────────────────────────────────────────────
  tools.push({
    name: 'zotero_fulltext',
    description: '读取 PDF/EPUB 附件已被 Zotero 索引的全文文本。长文按 maxChars 截断，可用 offset 续读。注意：索引可能只覆盖部分页；未在 Zotero 中打开过的 PDF 可能没有索引。',
    parameters: params({
      attachmentKey: { type: 'string', required: true, description: '附件 key（可用 zotero_item 结果里的附件 key）' },
      maxChars: { type: 'number', description: '本次返回的最大字符数，默认取插件配置（20000）' },
      offset: { type: 'number', description: '起始字符偏移，默认 0；用于续读' },
    }),
    output: {
      schema: OUT,
      render: textRender((v) => `附件 ${v.attachmentKey} 全文：共 ${v.chars} 字符（索引页 ${v.indexedPages ?? '?'}/${v.totalPages ?? '?'}），本次返回 ${v.returned} 字符（offset ${v.offset}${v.truncated ? '，还有后续' : ''}）。\n\n${v.content}`),
    },
    execute: async ({ attachmentKey, maxChars, offset }, exec) => {
      guard(exec);
      const cap = Math.min(Math.max(Number(maxChars) || settings.maxFulltextChars, 1000), 60000);
      return client.getFulltext(attachmentKey, { maxChars: cap, offset: Math.max(Number(offset) || 0, 0) });
    },
  });

  // ── zotero_find_pdf ──────────────────────────────────────────────
  tools.push({
    name: 'zotero_find_pdf',
    description: '调用 Zotero 内置的「查找可用文件」为条目自动下载并挂上 PDF/EPUB，效果等同于在 Zotero 里右键条目选「查找可用的 PDF」。解析在 Zotero 进程内完成（DOI / URL / 开放获取 / 自定义解析器），需要先安装配套的 Zotero 桥接插件。条目已有文件时默认跳过；dryRun=true 只探测可用解析器，不下载。会向 Zotero 库添加附件，需开启「写回」开关。',
    parameters: params({
      key: { type: 'string', required: true, description: '条目 key（8 位，如 QB2X8FES）' },
      dryRun: { type: 'boolean', description: '只探测可用解析器数量，不实际下载' },
      force: { type: 'boolean', description: '即使条目已有 PDF 也再找一次' },
      methods: { type: 'array', items: { type: 'string' }, description: "解析器类型，默认 ['doi','url','oa','custom']；只想要开放获取可传 ['oa']" },
    }),
    output: {
      schema: OUT,
      render: textRender((v) => {
        if (v.ok === false) {
          const known = {
            NO_RESOLVERS: '该条目没有任何可用解析器（既没有 DOI/URL，也没有开放获取来源）。',
            NO_FILE_FOUND: `试过 ${v.resolverCount} 个解析器，都没拿到文件（可能需要机构订阅，或站点要验证码）。`,
            ITEM_NOT_FOUND: `Zotero 里找不到条目 ${v.itemKey}。`,
            NOT_REGULAR_ITEM: `条目 ${v.itemKey} 的类型是 ${v.itemType}，不是文献条目，无法查找原文。`,
            DOWNLOAD_ERROR: `下载失败：${v.message ?? '未知错误'}`,
            BAD_ITEM_KEY: '条目 key 格式不对（应为 8 位字母数字）。',
          };
          return known[v.error] ?? `查找失败：${v.error}${v.message ? `（${v.message}）` : ''}`;
        }
        if (v.dryRun) {
          return `条目 ${v.itemKey}：可用解析器 ${v.resolverCount} 个（${(v.resolvers ?? []).join(', ')}）。未下载。`;
        }
        if (v.alreadyHad) {
          return `条目 ${v.itemKey} 已有文件：${v.attachmentTitle || v.attachmentKey}（${v.contentType || '未知类型'}）。要重试请加 force=true。`;
        }
        return `已为条目 ${v.itemKey} 挂上文件：${v.attachmentTitle || v.attachmentKey}（${v.contentType || '未知类型'}）。\n试过 ${v.resolverCount} 个解析器（${(v.resolvers ?? []).join(', ')}）。\n附件 key：${v.attachmentKey} —— 可用 zotero_fulltext 读全文。`;
      }),
    },
    execute: async ({ key, dryRun, force, methods }, exec) => {
      guard(exec);
      ensureWriteAllowed();
      const status = await client.bridgeStatus();
      if (!status.installed) {
        if (status.reason === 'zotero-unreachable') {
          throw new Error(status.message ?? 'Zotero 不可达，无法调用查找原文。');
        }
        throw new Error('未检测到 Zotero 桥接插件「DSH Zotero Bridge」，无法调用 Zotero 内置的查找原文能力。安装：Zotero → 工具 → 插件 → 齿轮 → 从文件安装插件，选择 dsh-zotero-bridge-*.xpi（在 dsh-zotero 仓库的 bridge/ 目录下，用 node bridge/build.mjs 生成），然后重启 Zotero。');
      }
      if (status.canFindFiles === false) {
        throw new Error(`当前 Zotero（${status.zoteroVersion ?? '未知版本'}）缺少 getFileResolvers/addFileFromURLs，桥接插件无法工作。`);
      }
      return client.findFile(String(key).trim().toUpperCase(), {
        dryRun: dryRun === true,
        force: force === true,
        methods: Array.isArray(methods) && methods.length > 0 ? methods : undefined,
      });
    },
  });

  // ── zotero_citation ──────────────────────────────────────────────
  tools.push({
    name: 'zotero_citation',
    description: '为若干条目生成文内引用与参考文献（CSL 风格，默认 APA + zh-CN）。也可以取 BibTeX（把 format 设为 bibtex）。',
    parameters: params({
      keys: { type: 'string', required: true, description: '逗号分隔的条目 key，最多 20 个' },
      style: { type: 'string', description: 'CSL 风格 id，如 apa / chicago-author-date / gb-t-7714-2015-numeric，默认 apa' },
      locale: { type: 'string', description: '语言，默认 zh-CN' },
      format: { type: 'string', description: 'citation（默认，文内引用+参考文献表）或 bibtex' },
    }),
    output: {
      schema: OUT,
      render: textRender((v) => {
        if (v.format === 'bibtex') return `BibTeX（${v.entries.length} 条）：\n\n${v.entries.map((e) => e.bibtex).join('\n')}`;
        const cites = v.citations.map((c) => `- [${c.key}] ${c.title ?? ''} → ${c.citation || '(该条目类型不产生引用，例如附件/笔记)'}`).join('\n');
        return `风格 ${v.style} / ${v.locale}\n文内引用：\n${cites}${v.bibliography ? `\n\n参考文献表：\n${v.bibliography}` : ''}`;
      }),
    },
    execute: async ({ keys, style, locale, format }, exec) => {
      guard(exec);
      const list = String(keys).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
      const st = style || 'apa';
      const lc = locale || 'zh-CN';
      if (String(format ?? 'citation') === 'bibtex') {
        const entries = [];
        for (const key of list) entries.push({ key, bibtex: await client.getBibtex(key) });
        return { format: 'bibtex', entries };
      }
      const { style: usedStyle, locale: usedLocale, citations } = await client.getCitation(list, { style: st, locale: lc });
      let bibliography = '';
      // Zotero 的 bibliography 是 CSL HTML（含 Z3988 COinS 噪声）→ 转成干净的纯文本条目
      try { bibliography = cleanBibliography(await client.getBibliography(list, { style: st, locale: lc })); } catch { bibliography = ''; }
      return { format: 'citation', style: usedStyle, locale: usedLocale, citations, bibliography };
    },
  });

  // ── zotero_collections ───────────────────────────────────────────
  tools.push({
    name: 'zotero_collections',
    description: '列出 Zotero 的分类（集合），可用于按分类范围检索文献。',
    parameters: params({ limit: { type: 'number', description: '最多返回分类数，默认 100' } }),
    output: { schema: OUT, render: textRender((v) => v.collections.length === 0 ? '没有分类。' : v.collections.map((c) => `- [${c.key}] ${c.name}${c.parentCollection ? '（子分类）' : ''}`).join('\n')) },
    execute: async ({ limit }, exec) => {
      guard(exec);
      const collections = await client.listCollections({ limit: Math.min(Math.max(Number(limit) || 100, 1), 300) });
      return { count: collections.length, collections };
    },
  });

  // ── zotero_selection ─────────────────────────────────────────────
  tools.push({
    name: 'zotero_selection',
    description: '读取用户在 Zotero 面板里当前勾选的条目/标注（以及备注）。当用户说"我选中的这几篇""这个标注"时用它。',
    parameters: params({}),
    output: {
      schema: OUT,
      render: textRender((v) => {
        if ((v.items?.length ?? 0) === 0 && (v.annotations?.length ?? 0) === 0) return '用户当前没有在 Zotero 面板里选中任何条目或标注。';
        const lines = [];
        if (v.items.length) lines.push(`选中条目 ${v.items.length} 条：`, ...v.items.map((i, n) => itemLine(i, n)));
        if (v.annotations.length) lines.push(`选中标注 ${v.annotations.length} 条：`, ...v.annotations.map((a) => `- [${a.key}] p.${a.pageLabel ?? '?'}：${a.text || '(无文字)'}${a.comment ? `｜评论：${a.comment}` : ''}`));
        if (v.note) lines.push(`用户备注：${v.note}`);
        return lines.join('\n');
      }),
    },
    execute: async (_args, exec) => {
      guard(exec);
      const sessionId = sessionState.sessionIdOf(exec);
      return { sessionId, ...sessionState.get(sessionId) };
    },
  });

  // ── zotero_authorize ─────────────────────────────────────────────
  tools.push({
    name: 'zotero_authorize',
    description: '向 Zotero 申请本地写权限（会在 Zotero 窗口弹出授权确认框，用户需点 Always Allow）。仅在用户明确要求写回 Zotero 时调用。',
    parameters: params({}),
    output: { schema: OUT, render: textRender((v) => v.authorized ? `已获得 Zotero 写授权（长期有效：${v.remember ? '是' : '否'}）。` : `授权未完成：${v.message ?? ''}`) },
    execute: async (_args, exec) => {
      guard(exec);
      try {
        // client.authorize() 会把 key 交给 setApiKey（index.js 已接到 keyStore.save）
        return await client.authorize();
      } catch (e) {
        return { authorized: false, message: e.message };
      }
    },
  });

  // ── zotero_create_note ──────────────────────────────────────────
  tools.push({
    name: 'zotero_create_note',
    description: '把一段内容写成 Zotero 中某条目的子笔记（HTML）。默认只做 dry-run 预览，确认后把 dryRun 设为 false 真正写入。需要写回开关已开启（侧栏面板头部「写回」按钮）且已授权。',
    parameters: params({
      parentItem: { type: 'string', required: true, description: '父条目 key（笔记会挂在它的"笔记"栏）' },
      html: { type: 'string', required: true, description: '笔记正文（HTML 片段，支持 p/br/strong/em/ul/ol/li/h1-h3/blockquote/code/pre/a/img）' },
      tags: { type: 'string', description: '可选：逗号分隔的标签' },
      dryRun: { type: 'boolean', description: '默认 true（只预览不写入）；确认后传 false 才真正写入' },
    }),
    output: {
      schema: OUT,
      render: textRender((v) => {
        if (v.dryRun) return `[dry-run] 将要写入的请求体（未发送）：\n${JSON.stringify(v.payload, null, 2)}`;
        if (v.ok) return `已写入子笔记：key=${v.noteKeys.join(', ')}（库版本 ${v.lastModifiedVersion ?? '?'}）`;
        return `写入未完成：${JSON.stringify(v.failed, null, 2)}`;
      }),
    },
    execute: async ({ parentItem, html, tags, dryRun }, exec) => {
      guard(exec);
      const payload = [{
        itemType: 'note',
        parentItem,
        note: String(html ?? ''),
        ...(tags ? { tags: String(tags).split(',').map((s) => ({ tag: s.trim() })).filter((t) => t.tag) } : {}),
      }];
      // dry-run 只做预览，不需要写权限（便于用户先审 payload 再开启写入）
      if (dryRun !== false) return { dryRun: true, payload };
      ensureWriteAllowed();
      await ensureAuthorized();
      const res = await client.createNotes([{ parentItem, html: String(html ?? ''), tags: tags ? String(tags).split(',').map((s) => s.trim()).filter(Boolean) : undefined }]);
      const noteKeys = Object.values(res.success ?? {});
      return {
        dryRun: false,
        ok: noteKeys.length > 0 && Object.keys(res.failed ?? {}).length === 0,
        noteKeys,
        failed: res.failed,
        unchanged: res.unchanged,
        lastModifiedVersion: res.lastModifiedVersion,
      };
    },
  });

  // ── zotero_highlight ────────────────────────────────────────────
  tools.push({
    name: 'zotero_highlight',
    description: '在 Zotero 某 PDF 附件的指定文字上创建高亮标注（可带评论）。默认 dry-run：只做 PDF 内定位并返回将要发送的请求体；确认后 dryRun=false 才真正写入。需要写回开关已开启（侧栏面板头部「写回」按钮）且已授权。',
    parameters: params({
      attachmentKey: { type: 'string', required: true, description: 'PDF 附件 key（不是父条目 key）' },
      text: { type: 'string', required: true, description: '要高亮的原文片段；需与 PDF 中文字一致，且落在同一行内（章节标题、句子片段都可以）' },
      comment: { type: 'string', description: '标注评论，显示在高亮旁的小窗里' },
      color: { type: 'string', description: '颜色，默认黄色 #ffd400' },
      pageIndex: { type: 'number', description: '限定页码（0 起）；省略则在全文查找' },
      occurrence: { type: 'number', description: '多处命中时取第几处（0 起，按页码先后）；配合 pageIndex 用于同页重复' },
      tags: { type: 'string', description: '可选：逗号分隔的标签' },
      dryRun: { type: 'boolean', description: '默认 true（只预览不写入）；确认后传 false 才真正写入' },
    }),
    output: {
      schema: OUT,
      render: textRender((v) => {
        if (v.ambiguous) {
          const rows = v.candidates.map((c) => `  [${c.index}] p.${c.pageLabel}（pageIndex=${c.pageIndex}） ${c.context}`);
          return `[歧义] 这段文字命中 ${v.candidates.length} 处，未写入。请用 pageIndex（同页重复再加 occurrence）指定：\n${rows.join('\n')}`;
        }
        if (v.dryRun) return `[dry-run] 定位：${v.location}\n将要写入的请求体（未发送）：\n${JSON.stringify(v.payload, null, 2)}`;
        if (v.ok) return `已创建高亮：key=${v.annotationKeys.join(', ')}（${v.location}）`;
        return `写入未完成：${JSON.stringify(v.failed, null, 2)}`;
      }),
    },
    execute: async ({ attachmentKey, text, comment, color, pageIndex, occurrence, tags, dryRun }, exec) => {
      guard(exec);
      const info = await client.getAttachmentInfo(attachmentKey);
      if (!info?.exists || !info.path) throw new Error(`附件 ${attachmentKey} 没有本地 PDF 文件（${info?.path ?? '无路径'}）`);
      if (info.contentType && !/pdf/i.test(String(info.contentType))) throw new Error(`附件 ${attachmentKey} 不是 PDF（${info.contentType}）`);

      const { doc, close } = await openPdf(info.path);
      let located;
      try {
        located = await locateText(doc, {
          text,
          pageIndex: Number.isFinite(pageIndex) ? Number(pageIndex) : undefined,
          occurrence: Number.isFinite(occurrence) ? Number(occurrence) : undefined,
        });
      } finally {
        await close();
      }
      if (!located) throw new Error(`在 PDF 里没找到这段文字（按单行匹配）：${text}`);
      // 多处命中不猜：把候选摊开给模型看，指定页码后再来（避免把高亮标到页眉/参考文献）
      if (located.ambiguous) return { ambiguous: true, candidates: located.candidates };

      const payload = buildHighlight({
        attachmentKey,
        located,
        text,
        comment,
        color,
        tags: tags ? String(tags).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      });
      const location = describeLocation(located);

      // dry-run 不需要写权限：先让用户看清"高亮到哪儿、写什么评论"
      if (dryRun !== false) return { dryRun: true, location, located, payload };

      ensureWriteAllowed();
      await ensureAuthorized();
      const res = await client.createAnnotations([payload]);
      const annotationKeys = Object.values(res.success ?? {});
      return {
        dryRun: false,
        ok: annotationKeys.length > 0 && Object.keys(res.failed ?? {}).length === 0,
        location,
        annotationKeys,
        failed: res.failed,
        lastModifiedVersion: res.lastModifiedVersion,
      };
    },
  });

  return tools;
}
