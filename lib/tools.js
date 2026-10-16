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

export function createTools({ client, sessionState, settings, keyStore, log = () => {} }) {
  const guard = (exec) => { try { exec?.signal?.throwIfAborted?.(); } catch { /* 忽略 */ } };

  const ensureWriteAllowed = () => {
    if (!settings.allowWrite) {
      throw new Error('Zotero 写回当前被关闭：请让用户在 DSH 的插件配置里把 dsh-zotero 的 allowWrite 设为 true（并在 Zotero 弹出授权窗时点「Always Allow」）。');
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
      render: textRender((v) => v.connected
        ? `Zotero ${v.zoteroVersion ?? '(未知版本)'} 已连接 · 本地 API v${v.apiVersion ?? '?'} · 库版本 ${v.libraryVersion ?? '?'} · 写授权：${v.writeAuthorized ? '已授权' : '未授权'}`
        : `未连接：${v.message}`),
    },
    execute: async (_args, exec) => {
      guard(exec);
      const p = await client.probe();
      if (!p.ok) {
        return { connected: false, baseUrl: p.baseUrl, code: p.code, message: p.message, writeAuthorized: false };
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
    description: '把一段内容写成 Zotero 中某条目的子笔记（HTML）。默认只做 dry-run 预览，确认后把 dryRun 设为 false 真正写入。需要插件配置 allowWrite=true 且已授权。',
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

  return tools;
}
