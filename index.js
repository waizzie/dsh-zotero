/**
 * dsh-zotero —— Host 半
 *
 * 让 DSH 里的模型能够检索本机 Zotero 文献库、读取标注/笔记/全文/题录，
 * 并把摘录写成子笔记；同时为侧边栏面板提供同源 HTTP 路由。
 *
 * 范围（按用户决定）：只读能力 + 子笔记写回。
 * 高亮/标注创建本轮不实现（调研结论见 docs/zotero-api-spec.md §4.4/§5）。
 *
 * 契约依据：docs/zotero-api-spec.md（Phase 0 实测）。
 */

import { createZoteroClient, DEFAULT_BASE_URL } from './lib/zotero-client.js';
import { createKeyStore } from './lib/key-store.js';
import { createSessionState } from './lib/session-state.js';
import { createTools } from './lib/tools.js';
import { registerRoutes } from './lib/routes.js';
import { PROMPT_SECTION } from './lib/prompt.js';

export const name = 'dsh-zotero';
export const inject = ['webServer', 'tools', 'systemPrompt'];

export function apply(ctx, config = {}) {
  const settings = {
    baseUrl: String(config.baseUrl ?? DEFAULT_BASE_URL),
    allowWrite: config.allowWrite === true,
    appName: String(config.appName ?? 'DSH Zotero'),
    maxFulltextChars: Number(config.maxFulltextChars ?? 20000),
  };

  const log = (msg) => { try { ctx.logger?.info?.(`[dsh-zotero] ${msg}`); } catch { /* 日志非必需 */ } };

  const keyStore = createKeyStore(ctx, log);
  const sessionState = createSessionState();
  // 面板挂载诊断：client 半通过 /api/panel.report 写入，status 与 zotero_status 回显
  const panelState = { last: null };
  const client = createZoteroClient({
    baseUrl: settings.baseUrl,
    appName: settings.appName,
    maxFulltextChars: settings.maxFulltextChars,
    getApiKey: () => keyStore.get(),
    setApiKey: (key) => { keyStore.save(key).catch(() => {}); },
  });

  // 启动时恢复已保存的写授权（不阻塞激活）。
  //
  // 为什么带重试：凭据服务可能比本插件晚就绪，第一次 load() 读不到就再没有第二次
  // 机会——2026-11-11 的故障就是重启后一直「未授权」，建高亮因为每次先 authorize()
  // 才碰巧能用，删除高亮则稳定 401。这里退避重试几次，尽量在用户动手前就恢复。
  (async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const key = await keyStore.load();
        if (key) return;
      } catch { /* load 内部已记日志 */ }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    try { log?.('写密钥未能在启动时恢复；写操作会在首次请求时向 Zotero 重新申请授权'); } catch { /* noop */ }
  })();

  // 1) 工具（模型可见）
  ctx.effect(() => {
    const tools = createTools({ client, sessionState, settings, keyStore, panelState, log });
    const disposers = tools.map((definition) => ctx.tools.register(definition));
    log(`已注册 ${disposers.length} 个工具（写回${settings.allowWrite ? '已开启' : '关闭'}）`);
    return () => { for (const dispose of disposers) { try { dispose(); } catch { /* noop */ } } };
  }, 'dsh-zotero: tools');

  // 2) 系统提示
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:zotero',
    order: 40,
    text: PROMPT_SECTION,
  }), 'dsh-zotero: prompt section');

  // 3) 面板路由
  ctx.effect(() => registerRoutes(ctx, { client, sessionState, settings, keyStore, panelState, log }), 'dsh-zotero: routes');

  log(`已激活（baseUrl=${settings.baseUrl}，写回=${settings.allowWrite}）`);
}
