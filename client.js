/**
 * dsh-zotero —— Client 半（侧边栏面板）
 *
 * 承载面 A：dsh-better-sidebar 的 ctx.betterSidebar.registerTab()，渲染进 DSH 原生右侧栏。
 *
 * 界面布局（按用户要求）：
 *   ┌ 状态头 ────────────────────────────────┐
 *   ├ 检索行 ────────────────────────────────┤
 *   ├ 分类（左列，可滚动）│ 操作条 + 条目列表 ┤
 *   │                     │  ▸ 点击条目在其下方内联展开操作
 *   └─────────────────────┴──────────────────┘
 *   文献池操作条在**列表上方**，不在最底下。
 *
 * 数据经 Host 半的同源路由：
 *   POST /dsh-zotero/api/<method>    查询 / 会话状态
 *   GET  /dsh-zotero/file?key=<附件>  附件字节流（面板内嵌 PDF 阅读，支持 Range）
 *
 * 纯 JS + React.createElement，无构建步骤；样式只用 --dsw-alias-* 主题令牌。
 * 范围：只读浏览 + 分类树 + 文献池 + 引用到会话 + 面板内文档阅读；不含高亮创建。
 */

window.__ModuleLoader__.load({
  id: 'dsh-zotero',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = '/dsh-zotero/api/';
    const FILE = '/dsh-zotero/file?key=';

    const TYPE_LABEL = {
      journalArticle: '期刊', conferencePaper: '会议', book: '图书', bookSection: '章节',
      thesis: '学位论文', preprint: '预印本', webpage: '网页', report: '报告',
      patent: '专利', manuscript: '手稿', document: '文档', attachment: '附件', note: '笔记',
    };
    const typeLabel = (t) => TYPE_LABEL[t] ?? t ?? '';

    async function call(method, payload) {
      const res = await fetch(API + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });
      let json = null;
      try { json = await res.json(); } catch { /* noop */ }
      if (!json || json.ok !== true) throw new Error(json?.error?.message ?? `请求失败（HTTP ${res.status}）`);
      return json.value;
    }

    // ─────────────── 侧栏宿主桥接（dsh-better-sidebar 是**可选**依赖） ───────────────
    //
    // 为什么这么写：better-sidebar 曾经是硬依赖（package.json 的 dsh.client.inject +
    // 插件级 inject: ['betterSidebar']）。DSH 的 client-modules 会先把被注入模块拉进图里，
    // 它一旦加载失败就把错误级联成 "dsh-zotero not loaded because dependency
    // dsh-better-sidebar failed" —— 表现就是"better-sidebar 一更新，本插件打不开"。
    // 现在改成：不硬 inject，运行时动态取服务；服务缺失/异常只降级不抛错；
    // 用 cordis 的 ctx.inject 在服务（重新）出现时自动重挂，升级/降级后无需重启。
    const SIDEBAR_SERVICE_NAMES = ['betterSidebar'];

    /** 最近一次解析到的侧栏服务（面板里「DSH 预览」等能力用它，不再直接摸 ctx）。 */
    const sidebarRef = { current: null };

    /** 最近一次挂载诊断，供 /dsh-zotero/api/panel.report 上报。 */
    let lastAttach = { attached: false, reason: '尚未初始化' };

    const featureFlag = (service, name) => {
      const list = service?.features;
      if (!Array.isArray(list)) return null;          // 老版本没有能力清单 → 不做门控
      return list.includes(name);
    };

    /** 把面板挂到侧栏服务上；任何异常都只记诊断，绝不上抛。 */
    function attachSidebar(service, scopedCtx, descriptor, opts = {}) {
      const label = opts.label ?? 'dsh-zotero: library tab';
      if (!service || typeof service.registerTab !== 'function') {
        lastAttach = { attached: false, reason: '侧栏服务不可用（缺少 registerTab）', ...opts.meta };
        return { attached: false, reason: lastAttach.reason };
      }
      try {
        const register = () => service.registerTab(descriptor);
        const ctx = scopedCtx ?? {};
        const disposer = typeof ctx.effect === 'function' ? ctx.effect(register, label) : register();
        sidebarRef.current = service;
        lastAttach = {
          attached: true,
          reason: '',
          serviceVersion: typeof service.version === 'string' ? service.version : null,
          features: Array.isArray(service.features) ? [...service.features] : null,
          ...opts.meta,
        };
        return { attached: true, disposer };
      } catch (e) {
        sidebarRef.current = null;
        lastAttach = { attached: false, reason: `注册失败：${e?.message ?? String(e)}`, ...opts.meta };
        return { attached: false, reason: lastAttach.reason };
      }
    }

    /**
     * 解析侧栏服务并挂载面板。
     * - 服务已在 → 立即挂；
     * - 还没出现 → ctx.inject 等待；服务变化时 cordis 会卸载并重跑回调 → 自动重挂。
     */
    function resolveSidebarService(ctx, descriptor, opts = {}) {
      const { onResult } = opts;
      const report = (result) => { try { onResult?.(result, lastAttach); } catch { /* noop */ } };

      const attachNow = (service, scopedCtx) => {
        const result = attachSidebar(service, scopedCtx, descriptor, opts);
        report(result);
        return result;
      };

      try {
        const existing = typeof ctx?.get === 'function' ? ctx.get(SIDEBAR_SERVICE_NAMES[0]) : undefined;
        if (existing) return attachNow(existing, ctx);
      } catch (e) {
        lastAttach = { attached: false, reason: `读取服务失败：${e?.message ?? String(e)}` };
      }

      try {
        if (typeof ctx?.inject !== 'function') {
          lastAttach = { attached: false, reason: '宿主不支持动态服务注入（ctx.inject 缺失）' };
          report({ attached: false, reason: lastAttach.reason });
          return { attached: false, reason: lastAttach.reason };
        }
        // 服务出现/变化时回调重跑（cordis 语义：回调随依赖变化卸载再执行）
        ctx.inject(SIDEBAR_SERVICE_NAMES, (scoped) => {
          const service = (typeof scoped?.get === 'function' ? scoped.get(SIDEBAR_SERVICE_NAMES[0]) : undefined) ?? scoped?.[SIDEBAR_SERVICE_NAMES[0]];
          attachNow(service, scoped);
        });
        lastAttach = { attached: false, reason: '等待侧栏服务出现' };
        report({ attached: false, reason: lastAttach.reason });
        return { attached: false, pending: true };
      } catch (e) {
        lastAttach = { attached: false, reason: `等待服务失败：${e?.message ?? String(e)}` };
        report({ attached: false, reason: lastAttach.reason });
        return { attached: false, reason: lastAttach.reason };
      }
    }

    /** 把挂载诊断上报给 Host（面板挂不上时，模型/用户都能看到原因）。 */
    function reportPanelState(payload) {
      try {
        void fetch(`${API}panel.report`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        }).catch(() => {});
      } catch { /* noop */ }
    }

    const creatorLine = (item) => {
      const c = item?.creators ?? [];
      if (c.length === 0) return '佚名';
      return c.length > 3 ? `${c.slice(0, 3).join(', ')} 等` : c.join(', ');
    };

    const sizeText = (bytes) => {
      if (typeof bytes !== 'number' || bytes <= 0) return '';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    };

    /** Zotero 分类是扁平列表 + parentCollection 指针 → 深度优先有序树。 */
    function buildCollectionTree(collections) {
      const byParent = new Map();
      for (const c of collections ?? []) {
        const parent = c.parentCollection && c.parentCollection !== false ? c.parentCollection : '__root__';
        if (!byParent.has(parent)) byParent.set(parent, []);
        byParent.get(parent).push(c);
      }
      const out = [];
      const walk = (parent, depth) => {
        const kids = (byParent.get(parent) ?? []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
        for (const c of kids) {
          out.push({ ...c, depth, hasChildren: (byParent.get(c.key) ?? []).length > 0 });
          walk(c.key, depth + 1);
        }
      };
      walk('__root__', 0);
      return out;
    }

    /** 把文本插入当前会话输入框；失败返回 false（调用方退化到剪贴板）。 */
    function insertIntoComposer(ctx, sessionId, text) {
      try {
        const conversation = ctx.get('conversation');
        if (!conversation?.input) return false;
        const actx = ctx.sessions?.scope ? ctx.sessions.scope(sessionId) : undefined;
        const input = conversation.input.for(actx);
        const draft = input.state.getSnapshot().draft ?? '';
        input.setDraft(draft ? `${draft}\n${text}` : text);
        return true;
      } catch {
        return false;
      }
    }

    /**
     * 面板状态持久化（按会话）。
     * 为什么需要：点「DSH 预览」会把右侧栏切到宿主的文档预览 tab，我们的面板组件被卸载，
     * React 状态全部丢失；切回来时就回到了默认的"最近修改"。因此把当前分类/检索/展开项
     * 存到 localStorage（内存 Map 兜底），重新挂载时按原状态恢复。
     */
    const stateKeyOf = (sessionId) => `dsh-zotero:panel:${sessionId ?? 'global'}`;
    const memoryState = new Map();

    function loadPanelState(sessionId) {
      const key = stateKeyOf(sessionId);
      try {
        const raw = window.localStorage?.getItem(key);
        if (raw) return JSON.parse(raw);
      } catch { /* 隐私模式 / 存储被禁用 */ }
      return memoryState.get(key) ?? null;
    }

    function savePanelState(sessionId, patch) {
      const key = stateKeyOf(sessionId);
      const next = { ...(loadPanelState(sessionId) ?? {}), ...patch, at: Date.now() };
      memoryState.set(key, next);
      try { window.localStorage?.setItem(key, JSON.stringify(next)); } catch { /* noop */ }
    }

    const CSS = `
.dz-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}
.dz-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dz-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.dz-dot.on{background:var(--dsw-alias-state-success-primary,#2ea043)}
.dz-dot.off{background:var(--dsw-alias-state-error-primary,#d64545)}
.dz-status{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px}
.dz-btn{cursor:pointer;border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:3px 7px;font-size:12px;font-family:inherit;white-space:nowrap}
.dz-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dz-btn[disabled]{opacity:.5;cursor:default}
.dz-btn.primary{color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1)}
.dz-btn.sm{padding:1px 6px;font-size:11px}
.dz-search{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;align-items:center}
.dz-input{flex:1;min-width:0;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 8px;font-size:12px;font-family:inherit;outline:none}
.dz-input:focus{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-border-l1))}
.dz-main{display:flex;flex:1;min-height:0}
.dz-side{width:172px;flex:none;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2,transparent)}
.dz-sidehead{padding:6px 10px;color:var(--dsw-alias-label-tertiary);font-size:11px;letter-spacing:.04em;flex:none}
.dz-sidelist{flex:1;min-height:0;overflow:auto;padding-bottom:6px}
.dz-content{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.dz-bar{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap}
.dz-barlabel{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-right:2px}
.dz-crow{display:flex;align-items:center;gap:4px;padding:4px 10px;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;border-radius:0}
.dz-crow:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dz-crow.active{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dz-crow .dz-cname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dz-crow .dz-cn{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dz-list{flex:1;min-height:0;overflow:auto}
.dz-row{display:flex;gap:8px;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:pointer}
.dz-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dz-row.open{background:var(--dsw-alias-interactive-bg-hover)}
.dz-row.sel{box-shadow:inset 2px 0 0 var(--dsw-alias-label-tertiary)}
.dz-check{margin-top:2px;flex:none}
.dz-rowmain{min-width:0;flex:1}
.dz-title{overflow-wrap:anywhere}
.dz-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-top:2px}
.dz-badge{display:inline-block;padding:0 5px;margin-right:5px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px}
.dz-caret{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none;width:10px;text-align:center}
.dz-detail{padding:8px 12px 12px 30px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2,transparent)}
.dz-abs{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;margin:4px 0}
.dz-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;letter-spacing:.04em;margin:8px 0 2px}
.dz-ann{border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 2px 8px;margin:6px 0}
.dz-annq{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dz-att{display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dz-att .dz-attname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dz-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.dz-cite{margin:6px 10px;padding:8px;border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l1);font-size:12px;white-space:pre-wrap;color:var(--dsw-alias-label-secondary)}
.dz-msg{padding:6px 10px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dz-msg.err{color:var(--dsw-alias-state-error-primary,#d64545)}
.dz-msg.warn{color:var(--dsw-alias-state-warn-primary,#b8860b)}
.dz-viewer{display:flex;flex-direction:column;flex:1;min-height:0}
.dz-vbar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dz-vtitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dz-frame{flex:1;min-height:0;width:100%;border:0;background:var(--dsw-alias-bg-document-preview,var(--dsw-alias-bg-layer-1))}
.dz-pv{flex:1;min-height:0;display:flex;flex-direction:column}
.dz-pvtools{display:flex;align-items:center;gap:6px;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap}
.dz-pvinfo{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:auto}
.dz-pvscroll{flex:1;min-height:0;overflow:auto;background:var(--dsw-alias-bg-document-preview,var(--dsw-alias-bg-layer-1));padding:8px 0}
.dz-page{position:relative;margin:0 auto 10px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.18)}
.dz-pagecanvas{display:block}
.dz-overlay{position:absolute;inset:0;pointer-events:none}
.dz-hl{position:absolute;pointer-events:auto;cursor:pointer;border-radius:2px;mix-blend-mode:multiply}
.dz-hl:hover{outline:1px solid var(--dsw-alias-label-secondary);outline-offset:1px}
.dz-hl.commented::after{content:'';position:absolute;right:-3px;top:-3px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#d9a300);border:1px solid #fff}
.dz-pagelabel{position:absolute;left:6px;top:4px;font-size:11px;color:#8a8a8a;pointer-events:none}
.dz-pop{position:absolute;z-index:5;max-width:min(320px,86%);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.22);padding:8px 10px;font-size:12px;line-height:17px}
.dz-pophead{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:11px;margin-bottom:4px}
.dz-poptext{margin:2px 0}
.dz-popcomment{margin:4px 0;padding:6px 8px;border-left:2px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2,transparent);white-space:pre-wrap;border-radius:0 4px 4px 0}
.dz-popacts{display:flex;gap:6px;margin-top:6px;justify-content:flex-end}
`;

    // ─────────────── pdf.js 自绘阅读器：把 Zotero 既有标注渲染到页面上 ───────────────
    // 浏览器原生 PDF 阅读器是独立文档，无法在其上绘制/定位；因此自己用 pdf.js 渲染画布，
    // 再用 viewport.convertToViewportRectangle() 把标注的 PDF 用户空间 rect 换算到画布坐标。
    const PDFJS_BASE = '/dsh-zotero/vendor/build/';
    let pdfjsPromise = null;

    function loadPdfjs() {
      if (!pdfjsPromise) {
        pdfjsPromise = import(`${PDFJS_BASE}pdf.mjs`).then((mod) => {
          mod.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.mjs`;
          return mod;
        }).catch((e) => {
          pdfjsPromise = null;
          throw new Error(`加载 pdf.js 失败（${e.message}）`);
        });
      }
      return pdfjsPromise;
    }

    /** #rrggbb → rgba()，用于高亮底色。 */
    function withAlpha(hex, alpha) {
      const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
      if (!m) return `rgba(255,212,0,${alpha})`;
      const n = parseInt(m[1], 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
    }

    /** Zotero 深链：在该 PDF 的指定标注处打开。 */
    function zoteroAnnotationLink(attachmentKey, annotationKey, pageIndex) {
      const base = `zotero://open-pdf/library/items/${attachmentKey}`;
      const params = [];
      if (typeof pageIndex === 'number') params.push(`page=${pageIndex + 1}`);
      if (annotationKey) params.push(`annotation=${annotationKey}`);
      return params.length ? `${base}?${params.join('&')}` : base;
    }

    /**
     * 单个 rect（PDF 用户空间、左下原点、相对 MediaBox）→ 画布坐标框。
     *
     * ⚠️ 不要用 `viewport.convertToViewportRectangle()`：**pdf.js 6.x 已移除该方法**
     * （实测 6.3.289 的 PageViewport 只有 `convertToViewportPoint` 与 `transform`）。
     * 之前正是因为它不存在而抛错——旧代码在 try 里被吞成"第 N 页渲染失败"，
     * 而那一页恰好是第一个带标注的页（前面几页没标注，所以从没触发过）。
     *
     * `viewport.transform` 是 [a,b,c,d,e,f] 的 2×3 仿射矩阵（已含 viewBox 偏移、缩放、/Rotate、userUnit），
     * 映射方式与 pdf.js 内部的 Util.applyTransform 一致：
     *   X = a·x + c·y + e      Y = b·x + d·y + f
     */
    function rectToViewportBox(viewport, rect) {
      if (!viewport) throw new Error('viewport 未就绪');
      const [x1, y1, x2, y2] = rect;
      // 老版本 pdf.js 提供该方法；有就用（与宿主实现保持一致），没有就走矩阵
      if (typeof viewport.convertToViewportRectangle === 'function') {
        const r = viewport.convertToViewportRectangle(rect);
        if (Array.isArray(r) && r.length === 4 && r.every((n) => Number.isFinite(n))) {
          return { left: Math.min(r[0], r[2]), top: Math.min(r[1], r[3]), width: Math.abs(r[2] - r[0]), height: Math.abs(r[3] - r[1]) };
        }
      }
      const t = viewport.transform;
      if (!Array.isArray(t) || t.length < 6) throw new Error('viewport 缺少 transform 矩阵');
      const [a, b, c, d, e, f] = t;
      const map = (x, y) => [a * x + c * y + e, b * x + d * y + f];
      // 取四角求包围盒：对仿射变换等价于映射对角两点，但对旋转页更直观可靠
      const pts = [map(x1, y1), map(x2, y1), map(x2, y2), map(x1, y2)];
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
    }

    /**
     * 把某页标注换算成覆盖框，返回 `{ boxes, problems }`。
     * 单个 rect 出问题只跳过并记入 problems，绝不让整页/整个面板崩掉（这条是踩过坑的）。
     */
    function computeOverlay(viewport, annotations, pageNumber) {
      const boxes = [];
      const problems = [];
      for (const ann of (annotations ?? [])) {
        if (ann?.pageIndex !== pageNumber - 1) continue;
        for (const rect of (ann.rects ?? [])) {
          try {
            const box = rectToViewportBox(viewport, rect);
            if (Number.isFinite(box.left) && Number.isFinite(box.top) && box.width > 0 && box.height > 0) {
              boxes.push({ ann, ...box });
            } else {
              problems.push(`${ann.key}: 换算结果非法`);
            }
          } catch (e) {
            problems.push(`${ann.key}: ${e.message}`);
          }
        }
      }
      return { boxes, problems };
    }

    /** 兼容旧签名：只要框数组。 */
    function overlayBoxes(viewport, annotations, pageNumber) {
      return computeOverlay(viewport, annotations, pageNumber).boxes;
    }

    /**
     * 单页：滚动到位才渲染；覆盖框**由 viewport 派生**（不依赖渲染时机）。
     *
     * ⚠️ 这里曾经是个真 bug：覆盖框只在"渲染"effect 里算一次。标注是另一个 HTTP 请求，
     * 若它晚于页面渲染到达，那次渲染捕获到的是空数组，而后续重算又被 `status !== 'render'`
     * 挡住 —— 结果是首屏页永远没有高亮（滚出来的页反倒正常）。
     * 现在 viewport 存进 state，boxes 用 useMemo 从 (viewport, annotations, pageNumber) 派生，
     * 标注什么时候到都能立刻画出来，也不必重绘画布。
     */
    function PdfPage({ pdf, pageNumber, scale, annotations, popup, attachmentKey, onPick, onClosePopup, onReportBoxes }) {
      const wrapRef = React.useRef(null);
      const canvasRef = React.useRef(null);
      const renderTaskRef = React.useRef(null);
      const [status, setStatus] = React.useState('idle');
      const [size, setSize] = React.useState(null);
      const [viewport, setViewport] = React.useState(null);
      const [renderError, setRenderError] = React.useState('');

      const { boxes, problems } = React.useMemo(
        () => (viewport ? computeOverlay(viewport, annotations, pageNumber) : { boxes: [], problems: [] }),
        [viewport, annotations, pageNumber],
      );

      // 只叠加"Zotero 内创建"的标注（external=false）；PDF 自带（如 Acrobat 高亮）已由 pdf.js 画在画布上
      React.useEffect(() => { onReportBoxes?.(pageNumber, boxes.length); }, [boxes.length, pageNumber, onReportBoxes]);

      React.useEffect(() => {
        if (status !== 'idle' || !pdf) return undefined;
        const node = wrapRef.current;
        if (!node || typeof IntersectionObserver === 'undefined') { setStatus('render'); return undefined; }
        const io = new IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting)) { setStatus('render'); io.disconnect(); }
        }, { rootMargin: '400px 0px' });
        io.observe(node);
        return () => io.disconnect();
      }, [pdf, status]);

      React.useEffect(() => {
        if (status !== 'render' || !pdf) return undefined;
        let cancelled = false;
        (async () => {
          try {
            const page = await pdf.getPage(pageNumber);
            if (cancelled) return;
            const vp = page.getViewport({ scale });
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const canvas = canvasRef.current;
            if (!canvas) return;
            canvas.width = Math.floor(vp.width * dpr);
            canvas.height = Math.floor(vp.height * dpr);
            canvas.style.width = `${Math.floor(vp.width)}px`;
            canvas.style.height = `${Math.floor(vp.height)}px`;
            const ctx2d = canvas.getContext('2d');
            // 同一 canvas 上并发 render() 会让 pdf.js 抛错（React 严格模式会跑两次 effect）→ 先取消上一个
            try { renderTaskRef.current?.cancel(); } catch { /* noop */ }
            const task = page.render({
              canvasContext: ctx2d,
              viewport: vp,
              transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
            });
            renderTaskRef.current = task;
            await task.promise;
            if (cancelled) return;
            setViewport(vp);                                  // ← 覆盖框从这里派生
            setSize({ width: Math.floor(vp.width), height: Math.floor(vp.height) });
            setStatus('done');
          } catch (e) {
            if (cancelled) return;
            const msg = e?.message ?? String(e);
            if (/cancel/i.test(msg)) return;                  // 主动取消不算失败
            setRenderError(msg);
            setStatus('error');
          }
        })();
        return () => {
          cancelled = true;
          try { renderTaskRef.current?.cancel(); } catch { /* noop */ }
        };
      }, [status, pdf, pageNumber, scale]);

      const isUnderline = (ann) => ann.type === 'underline';
      const popupHere = popup && popup.pageNumber === pageNumber ? popup : null;

      return h('div', {
        ref: wrapRef, className: 'dz-page', 'data-page': pageNumber,
        style: size ? { width: size.width, height: size.height } : { width: '92%', minHeight: '50vh' },
      }, [
        status === 'error'
          ? h('div', { key: 'err', className: 'dz-msg err' }, [
            `第 ${pageNumber} 页渲染失败${renderError ? `：${renderError}` : ''}`,
            h('button', {
              key: 'retry', className: 'dz-btn sm', style: { marginLeft: 6 },
              onClick: (e) => { e.stopPropagation(); setRenderError(''); setStatus('idle'); },
            }, '重试'),
          ])
          : (status !== 'done' ? h('div', { key: 'ph', className: 'dz-msg' },
            status === 'idle' ? `第 ${pageNumber} 页（滚动到此处时渲染）` : `第 ${pageNumber} 页渲染中…`) : null),
        h('canvas', { key: 'c', ref: canvasRef, className: 'dz-pagecanvas' }),
        h('div', { key: 'o', className: 'dz-overlay' }, boxes.map((b, i) => h('div', {
          key: `${b.ann.key}-${i}`,
          className: `dz-hl${b.ann.commentText ? ' commented' : ''}`,
          title: b.ann.text || b.ann.commentText || '',
          style: {
            left: b.left,
            top: isUnderline(b.ann) ? b.top + b.height - 2 : b.top,
            width: b.width,
            height: isUnderline(b.ann) ? 2 : b.height,
            background: withAlpha(b.ann.color, isUnderline(b.ann) ? 1 : 0.32),
          },
          onClick: (e) => { e.stopPropagation(); onPick(b); },
        }))),
        problems.length
          ? h('div', { key: 'prob', className: 'dz-msg warn', style: { position: 'absolute', left: 6, bottom: 4 } },
            `本页 ${problems.length} 个标注换算失败：${problems.slice(0, 2).join('；')}`)
          : null,
        h('div', { key: 'n', className: 'dz-pagelabel' }, `第 ${pageNumber} 页`),
        popupHere ? h('div', {
          key: 'pop', className: 'dz-pop',
          style: {
            left: Math.max(4, Math.min(popupHere.left, (size?.width ?? 400) - 300)),
            top: Math.min(popupHere.top + popupHere.height + 6, Math.max(4, (size?.height ?? 400) - 120)),
          },
          onClick: (e) => e.stopPropagation(),
        }, [
          h('div', { key: 'h', className: 'dz-pophead' }, [
            `p.${popupHere.ann.pageLabel ?? (popupHere.ann.pageIndex + 1)}`,
            h('span', { key: 't' }, popupHere.ann.type),
            h('span', { key: 'k', style: { marginLeft: 'auto' } }, popupHere.ann.key),
          ]),
          popupHere.ann.text ? h('div', { key: 't', className: 'dz-poptext' }, `「${popupHere.ann.text}」`) : null,
          popupHere.ann.commentText ? h('div', { key: 'c', className: 'dz-popcomment' }, popupHere.ann.commentText) : null,
          !popupHere.ann.commentText && !popupHere.ann.text ? h('div', { key: 'e', className: 'dz-poptext' }, '（这条标注没有内容）') : null,
          popupHere.ann.tags?.length ? h('div', { key: 'g', className: 'dz-pophead' }, `标签：${popupHere.ann.tags.join('、')}`) : null,
          h('div', { key: 'a', className: 'dz-popacts' }, [
            h('button', {
              key: 'zotero', className: 'dz-btn sm',
              onClick: () => { try { window.location.href = zoteroAnnotationLink(attachmentKey, popupHere.ann.key, popupHere.ann.pageIndex); } catch { /* noop */ } },
            }, '在 Zotero 中打开'),
            h('button', {
              key: 'copy', className: 'dz-btn sm',
              onClick: () => { try { navigator.clipboard?.writeText(`${popupHere.ann.text}\n${popupHere.ann.commentText ?? ''}`.trim()); } catch { /* noop */ } },
            }, '复制'),
            h('button', { key: 'close', className: 'dz-btn sm', onClick: () => onClosePopup() }, '关闭'),
          ]),
        ]) : null,
      ]);
    }

    /** 阅读器：工具栏（缩放/翻页）+ 连续滚动页面 + 标注小窗。 */
    function PdfViewer({ fileKey, title, size, onClose, onOpenHost, onNewWindow }) {
      const [pdf, setPdf] = React.useState(null);
      const [numPages, setNumPages] = React.useState(0);
      const [scale, setScale] = React.useState(1.2);
      const [annotations, setAnnotations] = React.useState([]);
      const [error, setError] = React.useState('');
      const [loading, setLoading] = React.useState(true);
      const [popup, setPopup] = React.useState(null);
      const [current, setCurrent] = React.useState(1);
      const [annError, setAnnError] = React.useState('');
      const [boxTotal, setBoxTotal] = React.useState(0);
      const scrollRef = React.useRef(null);
      const boxMapRef = React.useRef(new Map());

      /** 汇总各页已画出的覆盖框数（自检用）。回调保持稳定，避免子组件反复触发。 */
      const reportBoxes = React.useCallback((pageNumber, count) => {
        const prev = boxMapRef.current.get(pageNumber) ?? 0;
        if (prev === count) return;
        boxMapRef.current.set(pageNumber, count);
        let sum = 0;
        for (const v of boxMapRef.current.values()) sum += v;
        setBoxTotal(sum);
      }, []);

      // 只叠加 Zotero 内创建的标注；PDF 自带的（如先在 Acrobat 标好再导入）已由 pdf.js 画在画布上
      const overlayAnns = React.useMemo(() => (annotations ?? []).filter((a) => a.external !== true), [annotations]);
      const externalCount = (annotations ?? []).length - overlayAnns.length;
      const withRects = overlayAnns.filter((a) => Array.isArray(a.rects) && a.rects.length > 0).length;

      React.useEffect(() => {
        let cancelled = false;
        let doc = null;
        (async () => {
          setLoading(true);
          setError('');
          try {
            const pdfjs = await loadPdfjs();
            const res = await fetch(FILE + encodeURIComponent(fileKey));
            if (!res.ok) throw new Error(`读取 PDF 失败（HTTP ${res.status}）`);
            const data = await res.arrayBuffer();
            doc = await pdfjs.getDocument({
              data,
              cMapUrl: '/dsh-zotero/vendor/cmaps/',
              cMapPacked: true,
              standardFontDataUrl: '/dsh-zotero/vendor/standard_fonts/',
              wasmUrl: '/dsh-zotero/vendor/wasm/',
            }).promise;
            if (cancelled) { try { doc.destroy(); } catch { /* noop */ } return; }
            setPdf(doc);
            setNumPages(doc.numPages);
          } catch (e) {
            if (!cancelled) setError(e.message ?? String(e));
          } finally {
            if (!cancelled) setLoading(false);
          }
        })();
        return () => { cancelled = true; if (doc) { try { doc.destroy(); } catch { /* noop */ } } };
      }, [fileKey]);

      React.useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const v = await call('annotations', { key: fileKey, maxCommentChars: 4000 });
            if (!cancelled) { setAnnotations(v.annotations ?? []); setAnnError(''); }
          } catch (e) {
            // 以前这里静默吞掉，导致"标注 0 条"无从判断原因
            if (!cancelled) setAnnError(e.message ?? String(e));
          }
        })();
        return () => { cancelled = true; };
      }, [fileKey]);

      React.useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') setPopup(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);

      const scrollToPage = (n) => {
        const target = Math.min(Math.max(1, n), numPages || 1);
        const node = scrollRef.current?.querySelector(`[data-page="${target}"]`);
        if (node?.scrollIntoView) node.scrollIntoView({ block: 'start' });
        setCurrent(target);
      };

      const fitWidth = async () => {
        try {
          if (!pdf || !scrollRef.current) return;
          const page = await pdf.getPage(1);
          const unscaled = page.getViewport({ scale: 1 });
          const width = scrollRef.current.clientWidth - 24;
          setScale(Math.max(0.4, Math.min(3, width / unscaled.width)));
        } catch { /* noop */ }
      };

      return h('div', { className: 'dz-pv' }, [
        h('div', { className: 'dz-pvtools', key: 'tools' }, [
          h('button', { key: 'back', className: 'dz-btn primary', onClick: onClose }, '返回列表'),
          h('button', { key: 'prev', className: 'dz-btn', disabled: current <= 1, onClick: () => scrollToPage(current - 1) }, '上一页'),
          h('button', { key: 'next', className: 'dz-btn', disabled: numPages > 0 && current >= numPages, onClick: () => scrollToPage(current + 1) }, '下一页'),
          h('button', { key: 'zo', className: 'dz-btn', title: '缩小', onClick: () => setScale((s) => Math.max(0.4, +(s - 0.15).toFixed(2))) }, '−'),
          h('button', { key: 'zi', className: 'dz-btn', title: '放大', onClick: () => setScale((s) => Math.min(3, +(s + 0.15).toFixed(2))) }, '+'),
          h('button', { key: 'fit', className: 'dz-btn', onClick: fitWidth }, '适应宽度'),
          h('button', { key: 'host', className: 'dz-btn', onClick: onOpenHost }, 'DSH 预览'),
          h('button', { key: 'new', className: 'dz-btn', onClick: onNewWindow }, '新窗口'),
          h('span', { key: 'info', className: 'dz-pvinfo' },
            `${loading ? '加载中…' : `第 ${current}/${numPages || '?'} 页`} · 标注 ${annotations.length} 条`
            + `（叠加 ${withRects} · 自带 ${externalCount}）· 已画框 ${boxTotal} · ${Math.round(scale * 100)}%${size ? ` · ${sizeText(size)}` : ''}`),
        ]),
        error ? h('div', { key: 'err', className: 'dz-msg err' }, `${error}（已回退可用按钮：DSH 预览 / 新窗口）`) : null,
        annError ? h('div', { key: 'annerr', className: 'dz-msg err' }, `读取标注失败：${annError}`) : null,
        h('div', {
          key: 'scroll', ref: scrollRef, className: 'dz-pvscroll',
          onClick: () => setPopup(null),
          onScroll: (e) => {
            const top = e.currentTarget.scrollTop;
            const nodes = [...e.currentTarget.querySelectorAll('[data-page]')];
            let best = 1;
            for (const n of nodes) { if (n.offsetTop - 40 <= top) best = Number(n.dataset.page) || best; }
            setCurrent(best);
          },
        }, pdf
          ? Array.from({ length: numPages }, (_, i) => h(PdfPage, {
            key: `${i + 1}:${scale}`,
            pdf, pageNumber: i + 1, scale, annotations: overlayAnns, popup, attachmentKey: fileKey,
            onPick: (box) => setPopup({ ...box, pageNumber: i + 1 }),
            onClosePopup: () => setPopup(null),
            onReportBoxes: reportBoxes,
          }))
          : h('div', { className: 'dz-msg' }, loading ? '正在加载 PDF 与 pdf.js…' : '暂无内容')),
      ]);
    }

    function ZoteroPanel(props) {
      const { ctx, scope, visible } = props;
      const sessionId = scope?.sessionId;

      // 上次的面板状态（分类/检索/展开项）——用于从 DSH 预览切回来时恢复现场
      const saved = React.useMemo(() => loadPanelState(sessionId) ?? {}, [sessionId]);

      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState('');
      const [flash, setFlash] = React.useState('');
      const [collections, setCollections] = React.useState([]);
      const [items, setItems] = React.useState([]);
      const [listInfo, setListInfo] = React.useState({ label: '最近修改', collection: null, mode: 'recent' });
      const [query, setQuery] = React.useState(saved.query ?? '');
      const [busy, setBusy] = React.useState(false);
      const [expandedKey, setExpandedKey] = React.useState(null);
      const [expanded, setExpanded] = React.useState(null);
      const [expandedBusy, setExpandedBusy] = React.useState(false);
      const [pool, setPool] = React.useState(() => new Map());
      const [citation, setCitation] = React.useState('');
      const [viewer, setViewer] = React.useState(saved.viewer ?? null);

      const poolRef = React.useRef(pool);
      poolRef.current = pool;

      const run = React.useCallback(async (fn) => {
        setBusy(true);
        setError('');
        try { return await fn(); } catch (e) { setError(e.message ?? String(e)); return null; } finally { setBusy(false); }
      }, []);

      const loadRecent = React.useCallback(async () => {
        const v = await run(() => call('items', { limit: 100 }));
        if (v) {
          setItems(v.items ?? []);
          setListInfo({ label: '最近修改', collection: null, mode: 'recent' });
          setExpandedKey(null);
          setExpanded(null);
          savePanelState(sessionId, { mode: 'recent', collection: null, label: '最近修改', expandedKey: null });
        }
      }, [run, sessionId]);

      const loadStatus = React.useCallback(async () => {
        const s = await run(() => call('status'));
        if (s) setStatus(s);
        return s;
      }, [run]);

      // 挂载 / 面板重新可见：按上次状态恢复现场（分类 → 检索 → 最近修改）
      React.useEffect(() => {
        if (!visible) return undefined;
        let cancelled = false;
        (async () => {
          const s = await call('status').catch((e) => { if (!cancelled) setError(e.message); return null; });
          if (cancelled || !s) return;
          setStatus(s);
          if (!s.connected) return;

          const cols = await call('collections', {}).catch(() => ({ collections: [] }));
          if (cancelled) return;
          const list = cols.collections ?? [];
          setCollections(list);

          const want = loadPanelState(sessionId) ?? {};
          const target = want.mode === 'collection' && want.collection ? list.find((c) => c.key === want.collection) : null;

          let loaded;
          let info;
          if (target) {
            loaded = await call('items', { collection: target.key, limit: 200 }).catch(() => ({ items: [] }));
            info = { label: target.name, collection: target.key, mode: 'collection' };
          } else if (want.mode === 'search' && want.query) {
            loaded = await call('search', { query: want.query, limit: 40 }).catch(() => ({ items: [] }));
            info = { label: `检索「${want.query}」`, collection: null, mode: 'search' };
            setQuery(want.query);
          } else {
            loaded = await call('items', { limit: 100 }).catch(() => ({ items: [] }));
            info = { label: '最近修改', collection: null, mode: 'recent' };
          }
          if (cancelled) return;
          setItems(loaded.items ?? []);
          setListInfo(info);

          // 恢复上次展开的条目（仅当它仍在当前列表里）
          if (want.expandedKey && (loaded.items ?? []).some((x) => x.key === want.expandedKey)) {
            await toggleDetail(want.expandedKey);
          }
        })();
        return () => { cancelled = true; };
      }, [visible, sessionId]);

      const onSearch = async () => {
        const q = query.trim();
        if (q === '') { await loadRecent(); return; }
        const v = await run(() => call('search', { query: q, limit: 40 }));
        if (v) {
          setItems(v.items ?? []);
          setListInfo({ label: `检索「${q}」`, collection: null, mode: 'search' });
          setExpandedKey(null);
          setExpanded(null);
          savePanelState(sessionId, { mode: 'search', collection: null, label: `检索「${q}」`, query: q, expandedKey: null });
        }
      };

      const onCollection = async (col) => {
        const v = await run(() => call('items', { collection: col.key, limit: 200 }));
        if (v) {
          setItems(v.items ?? []);
          setListInfo({ label: col.name, collection: col.key, mode: 'collection' });
          setExpandedKey(null);
          setExpanded(null);
          savePanelState(sessionId, { mode: 'collection', collection: col.key, label: col.name, expandedKey: null });
        }
      };

      /** 展开某条目：在其行下方内联显示操作与详情。 */
      const toggleDetail = async (key) => {
        if (expandedKey === key) {
          setExpandedKey(null);
          setExpanded(null);
          savePanelState(sessionId, { expandedKey: null });
          return;
        }
        setExpandedKey(key);
        setExpanded(null);
        setExpandedBusy(true);
        savePanelState(sessionId, { expandedKey: key });
        try {
          const v = await call('item', { key });
          const isChild = Boolean(v.self);
          let attachments = v.attachments ?? [];
          if (!isChild) {
            attachments = await Promise.all(attachments.map(async (a) => {
              if (!/pdf|epub|html|image/.test(a.contentType ?? '')) return a;
              try {
                const info = await call('fileinfo', { key: a.key });
                return { ...a, size: info.size, exists: info.exists, viewable: info.viewable, path: info.path };
              } catch { return a; }
            }));
          }
          const anns = await call('annotations', { key, maxCommentChars: 800 }).catch(() => ({ annotations: [] }));
          setExpanded({
            key,
            item: v.item,
            self: v.self,
            parent: v.parent,
            attachments,
            notes: v.notes ?? [],
            annotations: anns.annotations ?? [],
          });
        } catch (e) {
          setError(e.message ?? String(e));
        } finally {
          setExpandedBusy(false);
        }
      };

      const togglePool = (item) => {
        if (!item?.key) return;
        setPool((prev) => {
          const next = new Map(prev);
          if (next.has(item.key)) next.delete(item.key); else next.set(item.key, item);
          return next;
        });
      };

      const syncPoolToSession = async () => {
        const itemsInPool = [...poolRef.current.values()];
        if (itemsInPool.length === 0) { setFlash('文献池为空'); return; }
        const v = await run(() => call('selection.set', { sessionId, items: itemsInPool, note: '' }));
        if (v) setFlash(`已把 ${itemsInPool.length} 条推送到会话（模型可用 zotero_selection 读到）`);
      };

      const clearPool = async () => {
        setPool(new Map());
        await run(() => call('selection.clear', { sessionId }));
        setFlash('文献池已清空');
      };

      const makeCitation = async () => {
        const keys = [...poolRef.current.keys()];
        if (keys.length === 0) { setFlash('先勾选条目'); return; }
        const v = await run(() => call('citation', { keys: keys.join(','), style: 'apa', locale: 'zh-CN' }));
        if (v) setCitation([...v.citations.map((c) => `[${c.key}] ${c.citation}`), '', v.bibliography].join('\n'));
      };

      const sendCitation = () => {
        if (citation === '') { setFlash('先生成引用'); return; }
        if (insertIntoComposer(ctx, sessionId, citation)) setFlash('已插入当前会话输入框');
        else if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(citation); setFlash('无法写入输入框，已复制到剪贴板'); }
        else setFlash('无法写入输入框');
      };

      const openViewer = (att) => {
        const next = { key: att.key, title: att.title || att.filename || att.key, contentType: att.contentType, size: att.size };
        setViewer(next);
        savePanelState(sessionId, { viewer: next });
      };

      const closeViewer = () => {
        setViewer(null);
        savePanelState(sessionId, { viewer: null });
      };

      const openInHostPreview = async (att) => {
        const service = sidebarRef.current;
        if (!service) {
          setFlash('侧栏服务不可用（dsh-better-sidebar 未启用或未就绪），请用「新窗口」打开');
          return;
        }
        if (typeof service.openFile !== 'function' || featureFlag(service, 'openFile') === false) {
          setFlash('当前侧栏版本不支持 openFile，请用「新窗口」或升级 dsh-better-sidebar');
          return;
        }
        const info = await call('fileinfo', { key: att.key }).catch(() => null);
        if (!info?.path || !info.exists) { setFlash('拿不到该附件的本地路径'); return; }
        try {
          service.openFile(scope, info.path, att.title || info.filename);
          // 提示：面板状态已持久化，切回 Zotero 标签会回到当前分类与展开项
          setFlash('已在 DSH 文档预览中打开；点右侧栏的 Zotero 标签可回到原分类与展开项');
        } catch (e) { setFlash(`打开失败：${e.message}`); }
      };

      const tree = React.useMemo(() => buildCollectionTree(collections), [collections]);
      const connected = status?.connected === true;

      /**
       * 附件操作行：打开 / DSH 预览 / 新窗口，并说明为何打不开。
       * 名字规则：Zotero 里附件常叫 "PDF"/"Full Text PDF"，看不出属于哪篇论文 ——
       * 因此标题与文件名不同时**两个都显示**（"PDF（周颖 等 - 2025 - ….pdf）"）。
       */
      const fileActions = (att, { big = false } = {}) => {
        const isPdf = /pdf/.test(att.contentType ?? '');
        const known = att.exists !== false;
        const name = att.title && att.filename && att.title !== att.filename
          ? `${att.title}（${att.filename}）`
          : (att.title || att.filename || att.key);
        return [
          h('div', { key: 'line', className: 'dz-att' }, [
            h('span', { key: 'n', className: 'dz-attname', title: att.path ?? att.filename ?? att.key },
              `${name}${att.size ? ` · ${sizeText(att.size)}` : ''}${att.contentType ? ` · ${att.contentType}` : ''}`),
            isPdf ? h('button', {
              key: 'open', className: `dz-btn ${big ? 'primary' : 'sm'}`, disabled: !known,
              onClick: (e) => { e.stopPropagation(); openViewer(att); },
            }, '打开') : null,
            h('button', { key: 'host', className: `dz-btn ${big ? '' : 'sm'}`, disabled: !known, onClick: (e) => { e.stopPropagation(); openInHostPreview(att); } }, 'DSH 预览'),
            h('button', {
              key: 'raw', className: `dz-btn ${big ? '' : 'sm'}`, disabled: !known,
              onClick: (e) => { e.stopPropagation(); window.open(FILE + encodeURIComponent(att.key), '_blank', 'noopener'); },
            }, '新窗口'),
          ]),
          known ? null : h('div', { key: 'warn', className: 'dz-msg warn' },
            '该附件在本地没有可用文件（可能是链接型附件、网页快照未落盘，或文件尚未从云端同步）。'),
        ];
      };

      const annotList = (anns) => (anns.length === 0
        ? [h('div', { key: 'none', className: 'dz-msg' }, '没有标注。')]
        : anns.map((a) => h('div', { key: a.key, className: 'dz-ann' }, [
          h('div', { key: 'x', className: 'dz-annq' }, `p.${a.pageLabel ?? a.pageIndex ?? '?'} · ${a.type}`),
          h('div', { key: 't' }, a.text || '(无选中文字)'),
          a.commentText ? h('div', { key: 'c', className: 'dz-annq' }, a.commentText) : null,
        ])));

      /** 展开区：文献条目 vs 子对象（附件）两种形态。 */
      const detailBlock = () => {
        if (expandedBusy) return h('div', { className: 'dz-msg', key: 'busy' }, '读取详情…');
        if (!expanded || expanded.key !== expandedKey) return null;
        const { item, self, parent } = expanded;
        const d = item?.data ?? {};

        // ① 选中的本身就是子对象（附件）：直接操作它自己的文件
        if (self) {
          return h('div', { className: 'dz-detail', key: `det-${expandedKey}` }, [
            h('div', { key: 't', className: 'dz-title' }, self.title || self.filename || self.key),
            parent ? h('div', { key: 'p', className: 'dz-meta' }, [
              '属于：',
              h('a', {
                key: 'a', href: '#', style: { color: 'inherit' },
                onClick: (e) => { e.preventDefault(); e.stopPropagation(); toggleDetail(parent.key); },
              }, parent.title ?? parent.key),
              h('span', { key: 'k', style: { color: 'var(--dsw-alias-label-tertiary)' } }, `（${typeLabel(parent.itemType)}）`),
            ]) : h('div', { key: 'p', className: 'dz-meta' }, '独立附件（没有父条目）'),
            self.itemType === 'attachment' ? h('div', { key: 'fa' }, [
              h('div', { key: 'h', className: 'dz-sub' }, '文件'),
              ...fileActions({ key: self.key, title: self.title, filename: self.filename, contentType: self.contentType, size: self.file?.size, exists: self.file?.exists, path: self.file?.path }, { big: true }),
            ]) : null,
            h('div', { key: 'an', className: 'dz-sub' }, `标注 ${expanded.annotations.length} 条`),
            ...annotList(expanded.annotations),
            h('div', { key: 'acts', className: 'dz-acts' }, [
              h('button', { key: 'pool', className: 'dz-btn', onClick: (e) => { e.stopPropagation(); togglePool({ key: self.key, title: self.title }); } },
                pool.has(self.key) ? '移出文献池' : '加入文献池'),
            ]),
          ]);
        }

        // ② 文献条目
        return h('div', { className: 'dz-detail', key: `det-${expandedKey}` }, [
          h('div', { key: 'meta', className: 'dz-meta' },
            `${typeLabel(d.itemType)}${d.DOI ? ` · DOI ${d.DOI}` : ''} · 附件 ${expanded.attachments.length} · 笔记 ${expanded.notes.length} · 标注 ${expanded.annotations.length}`),
          d.abstractNote ? h('div', { key: 'abs', className: 'dz-abs' }, String(d.abstractNote).slice(0, 900)) : null,

          expanded.attachments.length > 0 ? h('div', { key: 'atts' }, [
            h('div', { key: 'h', className: 'dz-sub' }, '附件'),
            ...expanded.attachments.flatMap((a) => fileActions(a)),
          ]) : h('div', { key: 'noatt', className: 'dz-msg' }, '该条目没有附件。'),

          h('div', { key: 'anh', className: 'dz-sub' }, `标注 ${expanded.annotations.length} 条`),
          ...annotList(expanded.annotations),

          h('div', { key: 'acts', className: 'dz-acts' }, [
            h('button', { key: 'p', className: 'dz-btn', onClick: (e) => { e.stopPropagation(); togglePool({ key: item.key, title: d.title ?? null }); } },
              pool.has(item.key) ? '移出文献池' : '加入文献池'),
            h('button', { key: 'c', className: 'dz-btn', disabled: busy, onClick: (e) => { e.stopPropagation(); makeCitation(); } }, '生成 APA 引用'),
            h('button', { key: 'i', className: 'dz-btn', disabled: !citation, onClick: (e) => { e.stopPropagation(); sendCitation(); } }, '插入输入框'),
          ]),
        ]);
      };

      // ── 阅读模式 ──
      if (viewer) {
        const isPdf = /pdf/.test(viewer.contentType ?? '');
        const usePdfjs = isPdf && status?.pdfjs?.available === true;
        const openNewWindow = () => window.open(FILE + encodeURIComponent(viewer.key), '_blank', 'noopener');

        // 首选：pdf.js 自绘 + Zotero 标注叠加（高亮可见、点在标注上弹小窗）
        if (usePdfjs) {
          return h('div', { className: 'dz-root' }, [
            h('style', { key: 'css' }, CSS),
            h(PdfViewer, {
              key: `pv-${viewer.key}`,
              fileKey: viewer.key,
              title: viewer.title,
              size: viewer.size,
              onClose: closeViewer,
              onOpenHost: () => openInHostPreview(viewer),
              onNewWindow: openNewWindow,
            }),
          ]);
        }

        // 回退：浏览器原生阅读器（pdf.js 不可用时；标注叠加不可用）
        return h('div', { className: 'dz-root' }, [
          h('style', { key: 'css' }, CSS),
          h('div', { className: 'dz-head', key: 'head' }, [
            h('span', { key: 'dot', className: `dz-dot ${connected ? 'on' : 'off'}` }),
            h('span', { key: 'st', className: 'dz-status', title: viewer.title }, viewer.title),
            h('button', { key: 'back', className: 'dz-btn primary', onClick: closeViewer }, '返回列表'),
          ]),
          h('div', { className: 'dz-viewer', key: 'viewer' }, [
            h('div', { className: 'dz-vbar', key: 'bar' }, [
              h('span', { key: 't', className: 'dz-vtitle' },
                isPdf
                  ? `PDF${viewer.size ? ` · ${sizeText(viewer.size)}` : ''}${isPdf && status?.pdfjs?.available === false ? ' · pdf.js 不可用，标注叠加已停用' : ''}`
                  : (viewer.contentType ?? '')),
              h('button', { key: 'new', className: 'dz-btn', onClick: openNewWindow }, '新窗口'),
              h('button', { key: 'host', className: 'dz-btn', onClick: () => openInHostPreview(viewer) }, 'DSH 预览'),
            ]),
            isPdf
              ? h('iframe', { key: 'f', className: 'dz-frame', src: FILE + encodeURIComponent(viewer.key), title: viewer.title })
              : h('div', { key: 'n', className: 'dz-msg' }, `该类型（${viewer.contentType ?? '未知'}）无法在面板内嵌显示，请用「新窗口」或「DSH 预览」打开。`),
          ]),
        ]);
      }

      return h('div', { className: 'dz-root' }, [
        h('style', { key: 'css' }, CSS),

        h('div', { className: 'dz-head', key: 'head' }, [
          h('span', { key: 'dot', className: `dz-dot ${connected ? 'on' : status ? 'off' : ''}` }),
          h('span', { key: 'st', className: 'dz-status', title: status?.message ?? '' },
            connected
              ? `Zotero ${status.zoteroVersion ?? ''} · 库版本 ${status.libraryVersion ?? '?'} · 写回${status.writeEnabled ? '开' : '关'}`
              : (status ? (status.message ?? '未连接') : '正在检查 Zotero…')),
          h('button', { key: 'refresh', className: 'dz-btn', disabled: busy, onClick: async () => { const s = await loadStatus(); if (s?.connected) await loadRecent(); } }, '刷新'),
        ]),

        h('div', { className: 'dz-search', key: 'search' }, [
          h('input', {
            key: 'q', className: 'dz-input', placeholder: '检索题名/作者/全文…', value: query,
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') onSearch(); },
          }),
          h('button', { key: 'go', className: 'dz-btn', disabled: busy || !connected, onClick: onSearch }, '搜索'),
          h('button', { key: 'recent', className: 'dz-btn', disabled: busy || !connected, onClick: loadRecent }, '最近'),
        ]),

        error ? h('div', { className: 'dz-msg err', key: 'err' }, error) : null,
        flash ? h('div', { className: 'dz-msg', key: 'flash' }, flash) : null,

        h('div', { className: 'dz-main', key: 'main' }, [
          // ── 左列：分类 ──
          h('div', { className: 'dz-side', key: 'side' }, [
            h('div', { className: 'dz-sidehead', key: 'h' }, `分类（${collections.length}）`),
            h('div', { className: 'dz-sidelist', key: 'l' }, [
              h('div', {
                key: 'recent', className: `dz-crow ${listInfo.mode === 'recent' ? 'active' : ''}`,
                onClick: loadRecent,
              }, [h('span', { key: 'n', className: 'dz-cname' }, '最近修改')]),
              ...tree.map((c) => h('div', {
                key: c.key, className: `dz-crow ${listInfo.collection === c.key ? 'active' : ''}`,
                style: { paddingLeft: 10 + c.depth * 12 },
                title: `${c.name}（${c.itemCount ?? '?'} 条）`,
                onClick: () => onCollection(c),
              }, [
                h('span', { key: 'n', className: 'dz-cname' }, `${c.hasChildren ? '▾ ' : ''}${c.name}`),
                h('span', { key: 'c', className: 'dz-cn' }, c.itemCount ?? ''),
              ])),
            ]),
          ]),

          // ── 右列：操作条 + 列表（详情内联展开在行下方）──
          h('div', { className: 'dz-content', key: 'content' }, [
            h('div', { className: 'dz-bar', key: 'bar' }, [
              h('span', { key: 'n', className: 'dz-barlabel' }, `文献池 ${pool.size}`),
              h('button', { key: 'sync', className: 'dz-btn', disabled: busy, onClick: syncPoolToSession }, '同步到会话'),
              h('button', { key: 'cite', className: 'dz-btn', disabled: busy || pool.size === 0, onClick: makeCitation }, '引用'),
              h('button', { key: 'send', className: 'dz-btn', disabled: !citation, onClick: sendCitation }, '插入输入框'),
              h('button', { key: 'clear', className: 'dz-btn', disabled: busy || pool.size === 0, onClick: clearPool }, '清空'),
            ]),
            citation ? h('div', { key: 'cite', className: 'dz-cite' }, citation) : null,
            h('div', { className: 'dz-list', key: 'list' }, [
              h('div', { className: 'dz-msg', key: 'scope' },
                `${listInfo.label}${items.length ? ` · ${items.length} 条` : ''}`),
              items.length === 0
                ? h('div', { className: 'dz-msg', key: 'empty' }, connected ? '没有条目。' : '等待 Zotero 连接…')
                : items.flatMap((item) => {
                  const isOpen = expandedKey === item.key;
                  const row = h('div', {
                    key: `row-${item.key}`, className: `dz-row ${isOpen ? 'open' : ''} ${pool.has(item.key) ? 'sel' : ''}`,
                    onClick: () => toggleDetail(item.key),
                  }, [
                    h('span', { key: 'caret', className: 'dz-caret' }, isOpen ? '▾' : '▸'),
                    h('input', {
                      key: 'cb', className: 'dz-check', type: 'checkbox', checked: pool.has(item.key),
                      onClick: (e) => e.stopPropagation(),
                      onChange: () => togglePool(item),
                    }),
                    h('div', { key: 'main', className: 'dz-rowmain' }, [
                      h('div', { key: 't', className: 'dz-title' }, item.title ?? '(无标题)'),
                      h('div', { key: 'm', className: 'dz-meta' }, [
                        h('span', { key: 'b', className: 'dz-badge' }, typeLabel(item.itemType)),
                        `${creatorLine(item)} · ${item.year ?? 'n.d.'}${item.publication ? ` · ${item.publication}` : ''}`,
                        item.matchedAttachments?.length ? ` · 全文命中附件 ${item.matchedAttachments.map((x) => x.title || x.key).join('/')}` : '',
                      ]),
                    ]),
                  ]);
                  return isOpen ? [row, detailBlock()] : [row];
                }),
            ]),
          ]),
        ]),
      ]);
    }

    /** Zotero 图标（线性，跟随主题色）。 */
    function ZoteroIcon(size) {
      const s = size ?? 16;
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', 'aria-hidden': true, style: { display: 'block' } }, [
        h('rect', { key: 'r', x: 2.5, y: 2.5, width: 19, height: 19, rx: 3.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { key: 'z', d: 'M6.5 8.2h11l-8.2 7.6h8.2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ]);
    }

    /**
     * 面板的 tab 描述符：只用 better-sidebar 的稳定字段
     * （id / title / description / icon / order / single / component）。
     */
    function buildTabDescriptor() {
      return {
        id: 'dsh-zotero:library',
        title: () => 'Zotero',
        description: () => '左列分类、行内展开操作，支持面板内阅读 PDF 并引用到会话',
        icon: (size) => ZoteroIcon(size),
        order: 40,
        single: true,
        component: ZoteroPanel,
      };
    }

    return {
      // 不声明任何硬服务依赖：better-sidebar 缺失/改名/更新失败都不该牵连本插件
      inject: [],
      apply(ctx) {
        resolveSidebarService(ctx, buildTabDescriptor(), {
          label: 'dsh-zotero: library tab',
          onResult: (_result, attach) => reportPanelState(attach),
        });
      },
      __test: {
        buildCollectionTree, sizeText, creatorLine, typeLabel, ZoteroPanel, FILE,
        loadPanelState, savePanelState, stateKeyOf, withAlpha, zoteroAnnotationLink,
        overlayBoxes, computeOverlay, rectToViewportBox, PdfViewer, PdfPage,
        buildTabDescriptor, resolveSidebarService, attachSidebar, featureFlag,
        SIDEBAR_SERVICE_NAMES, sidebarRef, lastAttach: () => lastAttach,
      },
    };
  },
});
