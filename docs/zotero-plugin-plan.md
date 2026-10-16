# Zotero × DSH 插件实施计划（v1，待评审）

> 目标：把 Zotero 文献库接入 DeepSeek Harness（DSH），服务"文章撰写 + 文献应用"。
> 状态：**Phase 0 完成**（笔记/高亮双向同步均实测可行）；**Phase 1 Host 半已实现并安装**（11 个模型工具 + 提示词 + 面板路由）；**Phase 3 Client 半（侧边栏面板，承载面 A）已实现并通过离屏验证**（24/24），等待重启 DSH 后做界面验收。写回仅子笔记，`allowWrite` 默认关闭。接口规范见 [`docs/zotero-api-spec.md`](zotero-api-spec.md)，检验记录见 [`docs/phase0-test-plan.md`](phase0-test-plan.md)。
> **范围调整（用户决定）**：高亮/标注的创建与坐标计算**暂缓实现**，调研结论保留在规范 §4.4/§5。
> 工作目录：`<项目目录>`
> 交付目录：`<插件包目录>`（已装为 `link:` 依赖，改代码后重载即生效）

---

## 0. 需求拆解与验收口径

| 编号 | 需求 | 验收口径（可观测） |
|---|---|---|
| G1-a | DSH 侧边栏展示 Zotero 内容 | 侧边栏出现「Zotero」入口，可浏览集合 → 条目 → 标注/笔记 |
| G1-b | 选中标记并同步到 Zotero | 面板里选中文本/标注 → 点「同步」→ **Zotero 客户端 UI 立即出现**对应笔记或标注，并显示 successful/unchanged/failed |
| G2-a | 大模型能看到 Zotero 文章内容 | 会话中让模型"读某条目/某 PDF 的标注与全文"，返回内容与 Zotero 一致 |
| G2-b | 大模型能用文献写文章 | 模型可检索、给格式化的文内引用与参考文献表，题录无编造 |

非目标（首版）：不接 zotero.org 云端 API；不做 Word 插件替代；不自研 Zotero XPI（仅在标注写回被实测否决时再评估）。

---

## 1. 现场事实（已实测/已读源码，决定方案形状）

### 1.1 DSH 宿主

| 项 | 事实 | 依据 |
|---|---|---|
| 版本 | `@deepseek-ai/dsh` **0.2.0-rc.2**；profile = `web`（`<DSH profile 目录>`） | 本机 `package.json`、`DSH_PROFILE_DIR` |
| 已装第三方 bundle | `dsh-better-sidebar@0.24.1`、`dsh-whale-widget` | profile `package.json` → `dsh.profile.bundles` |
| 插件包契约 | `package.json` 需 `dsh.bundle.patch`；声明 `dsh.client` 时 **必须**有 `exports["./client"]`，否则宿主启动报错 | `@deepseek-ai/dsh-client-modules/lib/index.js:713-731` |
| 客户端 bundle 格式 | `window.__ModuleLoader__.load({ id, factory(require) { … return { inject, apply } } })`；`react` 由模块表提供；**纯 JS 无需构建链** | skill 模板 `templates/decoration/client.js` |
| UI 依赖约束 | 不得打包/引用任何 `@deepseek-ai/dsh-client-ui-*` 包（宿主运行时提供；profile 的 `node_modules/@deepseek-ai` 实际只有 `cosmokit`/`schemastery`） | skill `references/practices.md`、profile 实测 |
| Host 侧能力 | `ctx.webServer.register({kind:'prefix'|'exact', path, handler})`（同源 HTTP 路由 + 信任围栏）<br>`ctx.tools.register(defineTool({name,description,parameters,output,execute}))`<br>`ctx.systemPrompt.section({name,order,text})`<br>`ctx.agents.get(id).inject(...)`<br>`ctx.credentials.readRecord/modifyRecord/deleteRecord` | `dsh-better-sidebar/src/index.ts:895`；`src/agent-opens.ts:198-264`；`dsh-system-prompt/README.md:59`；`dsh-agent/README.md:32,118`；`dsh-credentials/README.md:55-78` |
| 安装通道 | `dsh plugin --profile web add <pkg|link:绝对路径>`（官方 CLI，包自带 patch 完成挂载）；GUI 插件页与 `plugin_manager` 的 `install_bundle` 是另两条等价通道 | `dsh --help`；`dsh-better-sidebar/cordis.patch.yml:1-17`、`scripts/install.ps1:173-197` |
| ⚠️ 本会话限制 | 我的工具表里**没有** `plugin_manager` / `cordis_inspect_query`（web profile 把 `tool-plugin-manager` 作为 preset 行，本 preset 未挂）。安装需走 CLI/GUI，且要写 profile 目录 → **每次写入都要你批准** | `dsh-web-app/cordis.patch.yml:447`、`dsh-base/cordis.patch.yml:16-22` |

### 1.2 侧边栏承载面（三个候选，已核实差异）

| 面 | 机制 | 由谁提供 | 特点 |
|---|---|---|---|
| **A. 消费 dsh-better-sidebar** | `ctx.betterSidebar.registerTab({id,title,icon,order,single,component,…})` | 第三方插件 `dsh-better-sidebar`（**已装 0.24.1**） | 注册即进 **DSH 原生右侧栏**；白拿 tab 条/分栏/关闭/会话级持久化、i18n、设置页行、`features/version` 能力探测；生态已有 24+ 插件走此路 |
| **B. 原生右侧栏 tab** | 宿主 `ctx.sidebarRightTabs` 注册 tab 类型 + 注册 `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` 槽 | DSH 本体 | 不依赖任何第三方插件；但该服务本地只有编译产物，契约要自行确认，接线更多 |
| **C. 主面板页 + 左栏图标** | `ctx.slots.inject('main', …)` 注册 keyed 页（如 key `zotero`）+ `ctx.slots.inject('sidebar.panellist', …)` 注册图标 | DSH 本体 | 即 DSH 自带「插件 / 计划任务」页那种形态：**左栏图标 → 主内容区整页**，不是随会话的窄栏；无第三方依赖 |

**重要更正**：`dsh-better-sidebar` **不接管左栏、不注册 `main` / `sidebar.panellist`**；它自有 UI 是会话中列底部的「底部工作台」，右列内容全部走宿主原生右侧栏。因此"左栏塞一格"没有第三方入口，只有 DSH 本体的方案 C。

### 1.3 Zotero 侧

| 项 | 事实 | 依据 |
|---|---|---|
| 版本/路径 | 桌面版 **10.0.5**（`<Zotero 安装目录>/app/application.ini`），数据目录 `<数据目录>`（`zotero.sqlite`），当前**未运行** | 本机实测 |
| 本地 API 开关 | `extensions.zotero.httpServer.localAPI.enabled = true`（已开启） | profile `prefs.js` |
| 读 | `http://127.0.0.1:23119/api/`，**无需鉴权**：items / collections / tags / searches / `items/<key>/children` / `items/<att>/fulltext` / `items?format=bibtex` / `?include=data,citation&style=` / `items/<att>/file/view/url`；**默认不分页（一次返回全库）** | [Local API](https://www.zotero.org/support/dev/web_api/v3/local_api) |
| 写（Zotero 10+） | `POST/PUT/PATCH/DELETE` items/collections/searches。流程：`GET /api/` 取 `Zotero-Server-ID` → `POST /api/local/authorize {appName}` → 用户弹窗 → `{key, remember}` → 写请求带 `Zotero-API-Key` + `Zotero-Server-ID`。`remember:false` 时 key **单次有效**；弹窗类请求 5 次/分钟（429）；401 需重新授权；428=缺 Server-ID，412=版本/实例不匹配 | 同上 |
| 写文档边界 | 官方写文档覆盖 items/collections/searches/tags；**子笔记**明确支持（`itemType:"note"` + `parentItem`）；**annotation 类型没有任何写入说明** | [Write Requests](https://www.zotero.org/support/dev/web_api/v3/write_requests) |

> Zotero 把 PDF 标注的权威数据放在**附件文件本身**，数据库里的 annotation 条目是派生视图。因此"通过 API 创建标注"存在被客户端忽略/覆盖的可能 —— 这是全plan唯一的高风险未知项，必须在 Phase 0 用真机实测定性。

---

## 2. 架构

```
┌───────────── Zotero 10 桌面（127.0.0.1:23119，本地 API）─────────────┐
│ 唯一数据源：条目 / 集合 / 标注 / 笔记 / 全文 / 题录 / 写入            │
└───────────────────────────────▲──────────────────────────────────────┘
                                │ HTTP/JSON（Node 侧 fetch，不经浏览器）
┌───────────────────────────────┴──────── @local/dsh-zotero（Host 半）──┐
│ zotero-client  读写封装：Server-ID、版本前置条件、412/401/429/ECONNREFUSED │
│ cache          内存 LRU + since/versions 增量，按 Server-ID 分区        │
│ auth           /api/local/authorize；key 存 ctx.credentials 记录        │
│ tools          zotero_* 工具（模型可见）                                │
│ prompt         ctx.systemPrompt.section：工具用法 + 引用键约定 + 禁止编造 │
│ routes         POST /dsh-zotero/api/*（同源 + 信任围栏，面板调用）       │
│ selection      sessionId → 当前选中条目/标注/文献池                     │
└───────────────────────────────▲──────────────────────────────────────┘
                                │ 同源 fetch（无 CORS，密钥不进页面）
┌───────────────────────────────┴──────────────── Client 半 ───────────┐
│ 主：ctx.betterSidebar.registerTab({id:'dsh-zotero:library', …})        │
│ 备：main(key 'zotero') + sidebar.panellist 图标（better-sidebar 缺失） │
│ 视图：集合树 / 条目列表 / 详情(题录+摘要+标注+笔记) / 文献池 / 回写      │
└───────────────────────────────────────────────────────────────────────┘
```

**为什么必须 Host 中转**：① 浏览器直连 `127.0.0.1:23119` 的跨域行为无官方保证；② 写入密钥不能进页面；③ 模型工具与面板必须共用同一份数据层与授权状态；④ 本地 API 的无鉴权读取只该对同源可信请求开放。

---

## 3. 交付物清单

`<插件包目录>`

| 文件 | 作用 |
|---|---|
| `package.json` | name `@local/dsh-zotero`；`dsh.bundle.patch`；`dsh.client{platform:'web', immediately:true, inject:[…]}`；`exports{".":"./index.js", "./client":"./client.js"}`；`icon`；`meta.title/description`；`peerDependenciesMeta` 把 `dsh-better-sidebar` 标 optional |
| `cordis.patch.yml` | `- insert: [{ id: zotero, name: '@local/dsh-zotero', config: {…} }]`（Config：base URL、`allowWrite`、默认引用风格、缓存上限） |
| `index.js` | Host 半 `apply(ctx, config)`：路由 + 工具 + 提示词 + 授权，全部 `ctx.effect(...)` 持有 disposer |
| `lib/zotero-client.js` | 读/写 HTTP 封装、错误归一、Server-ID、版本前置条件、写 token |
| `lib/auth.js` | authorize 流程 + credentials 记录 + 401 重授权 + 429 退避 |
| `lib/cache.js` | 内存 LRU + 增量刷新（按 Server-ID 分区） |
| `lib/tools.js` | 全部 `zotero_*` 工具定义 |
| `lib/routes.js` | `/dsh-zotero/api/*` 路由与方法分发（信任围栏 + method 白名单） |
| `lib/selection.js` | sessionId → 选中项/文献池 |
| `client.js` | Client 半 ModuleLoader factory；能力探测后选 A 或 C 承载面；视图组件 |
| `locale/zh.json`、`locale/en.json` | 文案（`ctx.locale`，含 `dsh.client.inject` 里的 locale 包） |
| `icon.svg`、`README.md`、`docs/spike-findings.md`、`docs/usage.md` | 图标 / 说明 / Phase 0 实测记录（原始请求响应） / 安装授权排障 |
| `spike/probe.mjs` | Phase 0 只读探测脚本（可直接 `node` 运行） |

---

## 4. 分期计划

### Phase 0 — 可行性 spike（0.5 天 · 阻塞后续设计）
前提：你启动 Zotero（`C:\Program Files\Zotero\zotero.exe`）并保持运行。

1. 只读探测：`GET /api/`（Server-ID 与版本）、全库条目数、一个含 PDF 附件的条目、其 `children`、annotation 子项全字段、`fulltext`、`?format=bibtex`、`?include=data,citation&style=apa`、`file/view/url`。
2. 写授权实测：`POST /api/local/authorize`（`appName:"DSH Zotero"`）→ 弹窗 → 用返回 key 给**测试条目**创建一条子笔记 → 在 Zotero UI 确认。
3. **标注写回实测（关键）**：POST 一个 `itemType:"annotation"`（`parentItem`=PDF 附件，带 `annotationType/annotationText/annotationComment/annotationColor/annotationPageLabel/annotationPosition`）→ 记录 HTTP 状态与响应；再在 Zotero 打开该 PDF、重启 Zotero，观察是否仍在。
4. 产出 `docs/spike-findings.md`，据此把 G1-b 的回写通道定为：**A 子笔记 / B 标注 / C 两者**。

### Phase 1 — Host 数据层 + 模型工具（G2-a）
- `zotero-client` 读接口 + 错误归一（`ECONNREFUSED` → "Zotero 未运行"；403 → "本地 API 未开启"）。
- 缓存：条目详情/标注/全文 LRU；`since` + `format=versions` 增量；按 Server-ID 分区（Zotero 10 本地版本号与云端无关）。
- 工具（`defineTool`，模型可见）：
  | 工具 | 作用 | 关键约束 |
  |---|---|---|
  | `zotero_search` | 关键词/集合/类型检索 | 强制 `limit`，默认只回 key+题录摘要 |
  | `zotero_item` | 单条目完整元数据 + 子项清单 | — |
  | `zotero_annotations` | 标注列表（文本/评论/颜色/页码） | — |
  | `zotero_fulltext` | 附件已索引全文 | 按字符/页截断，防 token 爆炸 |
  | `zotero_citation` | bibtex / CSL JSON / CSL 风格文内引用与参考文献 | — |
  | `zotero_selection` | 读用户当前选中的条目/标注/文献池 | 读 session 级状态 |
  | `zotero_create_note` | 写：条目子笔记（HTML） | dry-run 预览；`Config.allowWrite` 门控 |
  | `zotero_create_annotation` | 写：创建标注 | **仅 Phase 0 通过才注册** |
- `ctx.systemPrompt.section({name:'plugin:zotero', order, text})`：说明何时用哪个工具、引用键约定（建议 `[@itemKey]`）、**不得编造题录**、写操作前须用户确认。
- 验收：会话里"检索某主题 → 读标注 → 给 APA 引用"，人工与 Zotero 对照。

### Phase 2 — 授权与回写（G1-b）
- 授权：Host 侧 `POST /api/local/authorize`；key 用 `ctx.credentials.modifyRecord('zotero-local-api-key', …)`（`kind:'grant'`）持久化，`describeRecord` 报状态（永不回显值）；401 自动重授权重试一次；429 指数退避并提示选「Always Allow」。
- 写幂等：`Zotero-Write-Token`（32 位随机，本地缓存 12h 内存）；412 时重取 version 再试。
- 通道：子笔记（保证可行）+ 标注（Phase 0 结论）。
- UI：每个写操作 = 显式按钮 + 预写 JSON 预览 + 结果回执。
- 验收：面板写一条 → Zotero 窗口立即出现（本地 API 写入是普通本地改动）。

### Phase 3 — 侧边栏面板（G1-a）
- 数据桥：`POST /dsh-zotero/api/{status,collections,items,item,annotations,selection,note,annotation,authorize}`（信任围栏 + method 白名单）。
- 承载面主选 **A**：`ctx.effect(() => ctx.betterSidebar.registerTab({id:'dsh-zotero:library', title, icon, order, single:true, settings:{pluginToggles:[…]}, component}))`。
- 回退 **C**（当 `ctx.betterSidebar` 不存在或被禁用）：`ctx.slots.inject('main', …)` 注册 key `zotero` 页 + `ctx.slots.inject('sidebar.panellist', …)` 注册图标、`ctx.layout.selectPanel('zotero')`。
- 视图：集合树 → 条目列表（可搜索）→ 详情（题录、摘要、标注列表、笔记）；勾选进「文献池」；选中标注/文本 → 「同步到 Zotero」；「发送到会话」。
- 规范：只用 `--dsw-alias-*` 令牌；**不 import 任何 `@deepseek-ai/dsh-client-ui-*`**；文案走 locale；`visible===false` 时暂停轮询；资源全包 `ctx.effect`。
- ⚠️ 「选中文本 → 输入框」的现成函数（`appendToDraft`/`referenceInChat`）**不在** `dsh-better-sidebar` 的 `exports` 里，不能 value-import；用 ~10 行自行复刻：`ctx.sessions.scope(sessionId)` + `ctx.conversation.input.for(actx).setDraft(...)`，或在 Host 侧用 `ctx.agents.get(sessionId).inject(...)` 注入（记为 `agent/inbox/spliced`）。

### Phase 4 — 写作支持（"便于文章撰写"）
- 文献池 → 会话上下文（注入 + `zotero_selection` 双通道）；「插入引用」把 `[@key]` / 格式化引用送进输入框。
- 可选：文献池一键导出 BibTeX / 参考文献表（Markdown 或 CSL 格式化文本）到工作区文件。
- 验收：给定选题，模型产出带引用段落 + 参考文献表，逐条与 Zotero 题录核对。

### Phase 5 — 安装与交付
- 安装：`dsh plugin --profile web add "<插件包目录>"`（或在 GUI 插件页安装）。本地开发可用 `link:<绝对路径>`；client 改动热加载，**host 半改动需重启 DSH**。
- 回滚：从 profile 的 `package.json` / `cordis.patch.yml` 移除该行，或 `remove_bundle`；插件自身零 profile 外写入。
- 文档：安装、授权、排障（Zotero 未运行 / 未开 localAPI / 授权被拒 / 429 / DSH 版本升级）。

---

## 5. 关键设计决策

| 决策点 | 结论 | 依据 |
|---|---|---|
| 面板承载面 | ✅ **A：接入 `dsh-better-sidebar` tab**（注册即进 DSH 原生右侧栏，白拿 tab 条/分栏/会话级持久化/i18n/设置页）；`ctx.betterSidebar` 缺失时回退 C（`main` + `sidebar.panellist` 主面板页） | Phase 0 调研 + 你已确认 |
| 回写通道 | ✅ **笔记 + 高亮/下划线都要**（两者均已实测可行）；**image/ink 降级为笔记**（可写但不渲染） | Phase 0 T4/T5/T5.11 |
| 密钥存储 | `ctx.credentials` 记录（`zotero-local-api-key`）；引导用户点一次 Always Allow | Phase 0 T3 |
| 大库策略 | 搜索优先 + 强制 `limit`；只缓存"最近/文献池/当前会话"；**所有状态判断走单条直读**（聚合不可信） | Phase 0 T6 + 数据审计 |
| 写安全 | `Config.allowWrite` 默认关 + dry-run 预览 + 显式确认；回收范围只限本会话登记的 key | Phase 0 事故教训 |
| 标注坐标 | 精确对齐公式已固化（Helvetica 行盒 + AFM 字宽）；**"DSH 侧选中文字→rect"的三条实现路径待 Phase 2 选定**（复用既有标注位置 / 按页锚定 / 引入 PDF 文本层解析） | Phase 0 §5 + spec §5 |

---

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **annotation 无法通过 API 可靠写入** | G1-b 的"标记"语义 | Phase 0 实测定性；否决则退化为「子笔记（结构化文本 + 评论）」，并提供"复制标注 → 在 Zotero 粘贴"的半自动路径；仍不满足再评估 Zotero XPI |
| Zotero 未运行 / localAPI 未开 | 面板与工具全废 | 探测 `/api/`；面板给出明确引导（启动 Zotero / 设置→高级→允许其他应用通信）；403 单独提示 |
| 授权弹窗频繁（单次 key + 5 次/分钟） | 写体验差 | 首次引导选「Always Allow」并持久化；429 退避；写前检查 key 有效性 |
| 大库全量响应 | 工具结果爆炸、响应慢 | 工具强制 `limit`；默认只回 key+题录；全文按页/字符截断 |
| `dsh-better-sidebar` 版本漂移 | 面板注册失败 | 声明 optional peer `^0.24.x`；用 `features`/`version` 能力探测；缺服务时回退方案 C |
| 本会话缺 `plugin_manager`/`cordis_inspect_query` | 安装与契约校验受限 | 用官方 CLI 安装（需批准）；设计期以已安装包 `lib/types/*.d.ts` 与 `dsh-better-sidebar/src` 为准 |
| 本地库无鉴权读取 | 隐私面 | 路由加信任围栏（Host 头 loopback）；**绝不转发 23119**；写默认关闭 |
| DSH 版本升级 | 私有接口失效 | 只用文档化 API（webServer / tools / systemPrompt / slots / credentials）；不碰未公开内部服务 |

---

## 7. 端到端验收清单

**G2**
1. 「检索 Zotero 里关于 X 的文献，列 5 条并给 APA 引用」→ 工具调用可见、题录与 Zotero 一致、无编造。
2. 打开某条目 →「总结这篇 PDF 的标注与全文要点」→ 标注文本/页码来自 `zotero_annotations`、全文来自 `zotero_fulltext`。
3. `zotero_selection` 能读到刚在面板里选中的 3 条文献。

**G1**
4. 侧边栏出现「Zotero」入口；能浏览集合/条目/标注；切会话状态正确。
5. 勾选 2 条 → 文献池；刷新/切会话后行为符合设计。
6. 选中文本/标注 →「同步到 Zotero」→ Zotero UI 立即出现；回执显示 successful/unchanged/failed。
7. 关闭 Zotero 后操作 → 面板显示"Zotero 未运行"而非崩溃。

**回归**：卸载后 DSH 正常启动、无残留行；`dsh --profile web --dump-config` 可核对插入行。

---

## 8. 需要你确认的 4 个选择（不回答按推荐执行）

1. **面板位置**：A better-sidebar 右侧栏 tab（推荐）／ B 原生右侧栏 tab ／ C 左栏图标 + 主面板页。
2. **"同步"语义**：子笔记（保证可行）／ PDF 高亮标注（待实测）／ 两者（推荐）。
3. **首版是否含写作功能**：文献池 + 引用插入 + 参考文献表导出（推荐含）。
4. **安装方式**：允许我用 `dsh plugin --profile web add`（会请求批准写 profile 目录）／ 你在 GUI 插件页手动安装。

---

## 9. 工作量与并行拆分

| 阶段 | 估时 | 并行性 |
|---|---|---|
| Phase 0 spike | 0.5 天 | 需你先启动 Zotero |
| Phase 1 Host + 工具 | 1.5–2 天 | 与 Phase 3 面板骨架并行（先冻结 `docs/interface.md`） |
| Phase 2 授权 + 回写 | 1 天 | 依赖 Phase 0 结论 |
| Phase 3 面板（A + 回退 C） | 2–3 天 | 可与 Phase 1 并行 |
| Phase 4 写作支持 | 1 天 | — |
| Phase 5 安装 + 端到端验收 | 0.5 天 | — |

若需加速：拆成「Host 数据层/工具」「Client 面板」「Zotero 实测与验收」三条互不重叠写路径（先冻结接口文档），由我集成并做最终端到端验收。

---

## 附：本计划引用的关键源码/文档位置

- 插件开发规范：`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`（含 4 文件模板与 `references/*.md`）
- 面板注册范例（主面板页）：`@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js:3652-3775`
- Host 路由 + 模型工具范例：`dsh-better-sidebar/src/index.ts:895`、`src/agent-opens.ts:198-264`
- better-sidebar 扩展指南（生态权威）：`dsh-better-sidebar/README.md:251-393`、`docs/external-plugin-guide.md`
- Zotero：[Local API](https://www.zotero.org/support/dev/web_api/v3/local_api)、[Write Requests](https://www.zotero.org/support/dev/web_api/v3/write_requests)
