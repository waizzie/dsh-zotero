# dsh-zotero

把本机 **Zotero 文献库**接进 DeepSeek Harness：**侧边栏面板**可浏览条目/标注/笔记并引用到会话；**模型工具**可检索条目、读取标注与笔记正文、拉取 PDF 全文、生成题录引用，并把讨论小结写成子笔记、把章节标题标成高亮。

> 能力边界：面板**只读**——不创建、不修改、不删除任何 Zotero 对象；**写入只走模型工具**，且受「写回」开关、Zotero 授权、默认 dry-run 三重门控。
> 可写对象只有两类：**子笔记**（`zotero_create_note`）与**高亮/下划线标注**（`zotero_highlight`，见[标注创建](#标注创建高亮)与 [docs/annotation-creation.md](docs/annotation-creation.md)）。

## 侧边栏面板（承载面 A）

面板通过 `dsh-better-sidebar` 的 `ctx.betterSidebar.registerTab()` 注册，渲染在 **DSH 原生右侧栏**（tab 条 / 分栏 / 会话级持久化由插件与宿主提供）。

> **`dsh-better-sidebar` 是可选依赖**（`peerDependenciesMeta.optional`）。本插件**不硬注入**它的客户端模块，插件体也不 `inject` 它的服务：运行时动态解析 `ctx.get('betterSidebar')`，缺失或异常只降级不抛错；服务**出现或被替换**时由 cordis 的 `ctx.inject` 自动重挂。因此它升级/降级/更新失败都**不会**拖垮本插件——12 个工具在任何情况下都可用。面板挂不上时，`zotero_status` 会返回 `panel: { attached, reason, serviceVersion, features }` 说明原因。

打开方式：右侧栏 **`+` → Zotero**（或已有 tab 时点 Zotero 图标）。

界面布局：

```
┌ 状态头（Zotero 版本 · 库版本 · 写回开关 · 刷新）──────────┐
├ 检索行（题名/作者/全文 ｜ 搜索 ｜ 最近）─────────────────┤
├ 分类（左列，可滚动）      │ 文献池操作条（同步/引用/插入/清空）┤
│  · 最近修改              │ 条目列表 ────────────────────────┤
│  · 机器学习 26           │  ▸ 期刊 作者 (年) 题名            │
│  · 城市交通规划 9         │  ▾ 期刊 作者 (年) 题名            │
│  · …                     │     ├ 摘要 / 附件（含大小）/ 标注   │
│                          │     └ 打开 · DSH 预览 · 新窗口      │
└──────────────────────────┴──────────────────────────────────┘
```

| 区域 | 能力 |
|---|---|
| 头部 | 连接状态（Zotero 版本 / 库版本）+ **写回开关**（真按钮：点一下即开/关，并持久化到 profile 配置）+ 刷新 |
| 检索 | 题名/作者/**全文**检索；「最近」回到最近修改 |
| **左列分类** | 同步 Zotero 自建分类（含**子分类层级**与**每类条目数**），点击即在该类范围内列出文献 |
| **行内展开** | 点条目在其**下方**展开操作与详情（摘要、附件、标注、加入文献池、引用），不再堆到面板底部 |
| 文献池操作条 | 位于**列表上方**：计数 · 同步到会话 · 引用 · 插入输入框 · 清空 |
| **文档阅读** | 附件行「打开」→ **pdf.js 自绘阅读器**，把 Zotero 既有**高亮/下划线叠加在页面上**，点标注在**原位弹小窗**看评论；另有「DSH 预览」（宿主文档预览）与「新窗口」 |

## 标注渲染（本轮新增）

需求：把 Zotero 里**已有的**高亮渲染到预览中，并在高亮处用小窗展示对应评论。

**为什么不能用浏览器原生阅读器**：原生 PDF 阅读器是独立文档，我们既不能在其上绘制，也拿不到页面几何来对齐。因此面板改为**自己用 pdf.js 渲染**：

```
Zotero 标注 rects（PDF 用户空间、左下原点、相对 MediaBox）
        │  X = a·x + c·y + e ; Y = b·x + d·y + f   （viewport.transform 矩阵，取四角求包围盒）
        ▼
画布坐标（左上原点，含缩放/旋转）→ 绝对定位的覆盖层 div
```

> ⚠️ **不要用 `viewport.convertToViewportRectangle()`**：pdf.js 6.x 已移除该方法（实测 6.3.289 只有 `convertToViewportPoint` 与 `transform`）。用它会在"有标注的那一页"抛 `is not a function`，而不带标注的页看起来一切正常——这个坑踩过，详见 [docs/annotation-storage.md](docs/annotation-storage.md) §7。

| 环节 | 实现 |
|---|---|
| pdf.js 来源 | 作为本包依赖安装（`pdfjs-dist@6.3.289`，与 DSH 自带版本一致），Host 经 `GET /dsh-zotero/vendor/**` 白名单供给；客户端 `import('/dsh-zotero/vendor/build/pdf.mjs')` |
| 中文 PDF | 同时供给 `cmaps/`（`cMapUrl` + `cMapPacked`）与 `standard_fonts/`，否则未内嵌字体的中文可能缺字 |
| 渲染策略 | 连续滚动 + `IntersectionObserver` 懒渲染（滚到哪页画哪页），`devicePixelRatio` 适配高清屏；渲染前取消同 canvas 的上一任务，失败时显示**具体原因**并给「重试」 |
| 高亮样式 | 底色取标注颜色（`#rrggbb` + 32% alpha，`mix-blend-mode: multiply`）；`underline` 类型只画 2px 下划线；**有评论的标注右上角带提示点** |
| 覆盖框时机 | 由 `(viewport, annotations, 页码)` **useMemo 派生**——标注（另一个请求）晚到也会立刻画出，不依赖页面渲染时机 |
| 外部标注 | `annotationIsExternal === true`（PDF 自带，例如**先在 Acrobat 标好再导入**）**不叠加**：pdf.js 渲染画布时已画出，再叠会颜色变深 |
| 定位小窗 | 点高亮 → 在该矩形下方弹出卡片：页码/类型/标注 key、「高亮文字」、评论正文、标签，按钮：**在 Zotero 中打开**（`zotero://open-pdf/library/items/<附件>?page=N&annotation=<key>`）/ 复制 / 关闭；`Esc` 或点空白关闭，位置自动避让页面边缘 |
| 工具栏 | 返回列表 · 上一页/下一页 · 缩放 −/+ · 适应宽度 · DSH 预览 · 新窗口 · 自检行 `第 X/Y 页 · 标注 N 条（叠加 M · 自带 K）· 已画框 P · 缩放%` |
| 回退 | `status.pdfjs.available === false`（未装依赖等）时自动退回原生 `<iframe>` 阅读器，并说明"标注叠加已停用" |

> 面板侧**只渲染已有标注**，不创建、不修改、不删除任何 Zotero 对象。创建高亮是模型工具的职责，见下一节。

### 列表只显示"文献"，不显示子附件

Zotero 的集合成员**包含父条目的子附件与笔记**（实测某分类 77 个成员 = 23 期刊 + 45 附件 + 6 笔记 + 2 预印本 + 1 学位论文），全文检索的命中也主要落在附件上。因此：

- 分类/最近列表**过滤掉挂在父条目下的子对象**（独立附件仍保留）；
- 检索把**附件命中归并到父条目并按父条目去重**，行内标注「命中附件：PDF」；
- 附件名同时显示**标题与文件名**（如 `PDF（周颖 等 - 2025 - ….pdf）`），避免"PDF / Full Text PDF 看不出属于哪篇论文"；
- 选中附件行时，展开区直接给出该附件自身的**打开 / DSH 预览 / 新窗口**，并显示「属于：<父条目>」可跳转；若本地无文件则给出原因。

「插入输入框」优先使用 DSH 的 composer 草稿接口；不可用时自动退化为复制到剪贴板。

> 面板与工具共用 Host 半的同源路由 `POST /dsh-zotero/api/*`；附件字节走 `GET /dsh-zotero/file?key=<附件key>`（`Content-Type` 取自 Zotero，`Range`/`206` 已支持，便于 PDF 阅读器按需取页）。
> 两条路由都只接受 **loopback Host**；浏览器**不直连** Zotero 23119（Zotero 只对硬编码来源发 CORS 头，且会断连浏览器特征请求）。

**为什么 PDF 要经 Host 中转**：Zotero 的 `/items/<key>/file/view` 只会 302 到 `file:///…`，浏览器无法从 http 页面读取 `file://`；因此由 Host 解析附件真实路径（Host 侧实测：`file/view/url` → `%USERPROFILE%\Zotero\storage\<key>\<file>.pdf`）并流式回传。

## 标注创建（高亮）

`zotero_highlight` 能在 PDF 上创建**黄色高亮**并附评论。面板里的 PDF 是 canvas 自绘、没有文本层，做不了"选中文字算坐标"，所以定位全部放在 **Host 侧**：直接读附件本地文件，用 `page.getTextContent()` 拿到每个 text item 的 `transform`（PDF 用户空间、左下原点）。

几何公式不是猜的，是用库里 **12 条真实标注**的 `annotationPosition` 反解标定出来的：

```
fs   = hypot(transform[2], transform[3])        // 该 text item 的字号
rect = [x1, baseline − 0.25·fs, x2, baseline + 1.0·fs]     // Zotero 用 1.25em 行盒
```

8 条正文样本（字号 6.376 / 7.173 / 7.97）与该式**逐位吻合**，下探 0.2500、上伸 1.0000，精确到小数点后四位。

| 环节 | 做法 |
|---|---|
| 定位 | 按基线（2pt 容差）归行 → 对行文本与目标文本做同一套归一化（折叠空白 + 小写）→ `indexOf` → 映射回原串区间，取相交 text item 的并集 |
| **歧义** | 命中 ≥2 处**不猜**：不写入，返回候选（页码 + 一行上下文），由模型补 `pageIndex`（同页仍重复再加 `occurrence`）重跑 |
| 文字来源 | `annotationText` 取 PDF **原串切片**，不接受模型改写；跨行片段直接报错 |
| 门控 | 默认 `dry-run`（只定位、不发请求）；`dryRun:false` 才依次过**写回开关**与**Zotero 授权** |

> ⚠️ **为什么必须"不猜"**：实测一篇 13 页论文里同一串文字出现 **12 次**，第 1 处是页眉残片，真正的节标题在第 2 页。早期版本取第一处就返回，高亮会静默标到错误位置——界面上"有高亮"，很难发现。
> ⚠️ **payload 必须带 `itemType: "annotation"`**：缺了它 Zotero 直接回 `400 itemType property not provided`（第一次真写时四条全被拒）。完整字段形状、sortIndex 规则与已知几何偏差见 [docs/annotation-creation.md](docs/annotation-creation.md)。

## 排障（面板）

| 现象 | 处理 |
|---|---|
| 右侧栏 `+` 菜单里没有 Zotero | 面板依赖的可选插件 `dsh-better-sidebar` 未启用、版本不兼容或自身加载失败。**此时 12 个工具仍可用**；用 `zotero_status` 看 `panel.reason` 定位原因，装好/修好后**无需改本插件**，服务一出现会自动重挂（改了 `package.json`/`client.js` 才需要重启 DSH） |
| 面板显示「未连接」 | 按上面的前置条件检查 Zotero 是否运行、本地 API 是否开启 |
| 点「插入输入框」提示已复制 | 该 DSH 版本的 composer 接口不可用，退化为剪贴板，属于预期降级 |


## 前置条件

1. DSH 侧**可选**启用 **`dsh-better-sidebar`**（提供右侧栏面板宿主）。
   - 未启用时：文献工具照常工作；面板不出现，`zotero_status` 的 `panel.attached = false` 会给出原因。
   - **版本要与 DSH 匹配**（错配时侧栏会 `pending`，面板不出现，但本插件不受影响）：

     | DSH | better-sidebar | 侧栏要的服务 |
     |---|---|---|
     | `0.2.1-rc.x`（当前实测） | **`0.28.0`** | `webServer, sessions, connection, tools` |
     | `0.2.0-rc.x` 及更早 | `0.24.1` | `webServer, sessions, webRuntime, tools` |

     排查：启动日志出现 `pending (waiting for service: …)` 时，按括号里的服务名对照上表换版本；DSH 升级后 `webRuntime` 已被移除，旧版侧栏会永久 pending。
   - 运行时能力用 `service.features` 门控（`registerTab` 必需）；面板挂不上时先看 `zotero_status` 的 `panel.reason`。
2. 本机安装了 **Zotero 7+ 桌面端**（实测 10.0.7），并保持**运行中**。
3. Zotero 中开启本地 API：**设置 → 高级 → 勾选「允许其他应用程序与 Zotero 通信」**。
   - 未开启时所有工具会返回可读的 403 提示。
4. 端口 23119 仅本机可达，**不要转发**。

## 安装

```powershell
# 1) （可选）面板承载者：只影响侧边栏面板；不装时文献工具照常工作
dsh plugin --profile web add dsh-better-sidebar

# 2) 装本插件
dsh plugin --profile web add "github:waizzie/dsh-zotero"           # 跟随 main（含最新功能与修复）

# 3) 重启 dsh web（host 半改动只在重启后生效）
```

> ⚠️ **不要安装 `v0.2.2` 及更早的 tag。** 那些版本有会让 DSH **起不来**的凭据键 bug（见下方
> 「已知致命问题」），修复目前只在 `main` 上，尚未打新 tag。

> 目前**没有带二进制资产的 Release**，所以不提供 `.tgz` 直链。需要离线分发时，自行打包后从本地安装
> （文件名以 `npm pack` 的输出为准）：
>
> ```powershell
> git clone https://github.com/waizzie/dsh-zotero.git; cd dsh-zotero; npm install; npm pack
> dsh plugin --profile web add "C:\路径\dsh-zotero-<版本>.tgz"
> ```

> 从 git 或 registry 来源安装时无需手工装依赖：包管理器会按 `dependencies` 自动装上 `pdfjs-dist`
> （面板用它把 Zotero 标注叠加在自绘 PDF 上；缺失时自动退回原生 `<iframe>` 阅读器）。
> 只有**本地路径 `link:` 安装**例外——DSH 不会替被链接的包装依赖，需先在该包目录内执行一次
> `npm install`（或 `pnpm add pdfjs-dist@6.3.289`），再用 `dsh plugin add` 指向它。

## ⚠️ 已知致命问题：≤ 0.2.2 会让 DSH 起不来

**现象**：写入过一次 Zotero 授权之后，**下一次启动 DSH** 直接 `dsh: startup failed`——`credentials`
插件激活失败，依赖它的 `connection`、`deepseek-account`、`better-sidebar` 等 12 个插件全部 pending。
普通启动每次必挂，只有 safe mode 能进。日志关键行：

```
credential key "zotero-local-api-key" must be "<scope>/<id>"
```

**根因**：旧版 `lib/key-store.js` 把凭据记录键写成了 `zotero-local-api-key`。DSH 的凭据记录键必须是
`<scope>/<id>`，且两段各自匹配 `/^[a-z][a-z0-9-]*$/`（`@deepseek-ai/dsh-credentials` 的
`KEY_SEGMENT_PATTERN`）。DSH 的**写路径**只校验 payload、不校验键格式，所以写入当时毫无异常；
**读路径**（`parseRecords()` → `parseCredentialKey()`）要到下次启动才抛错。

**已修复**：`main` 上键已改为 `dsh-zotero/local-api-key`，并在模块加载时做格式自检——写错会立刻
报错，而不是先落盘、等下次开机才炸。回归测试：`node spike/key-store-test.mjs`。

**已经中招怎么办**（**不需要** factory reset）：

1. 编辑 `%USERPROFILE%\.dsh\.credentials.yaml`；
2. 在 `records:` 下删掉整个 `zotero-local-api-key:` 块（连带它的 `kind` / `payload` 子行）；
3. 重新启动 DSH，再授权一次（弹窗点 Always Allow），密钥会以新键名重新写入。

> 这条来自实测事故（2026-11-04）：写入正常、关机正常，重启才炸；当时未定位到根因，做了 factory
> reset，整个旧 `~/.dsh` 被归档到 `~/.dsh/recovery/`（数据没丢，但配置全没了）。

## 配置

`cordis.patch.yml` 里的 `config`（也可在 DSH 设置里按 load 行 id `dsh-zotero` 覆盖）：

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:23119` | Zotero 本地 API 基址 |
| `allowWrite` | `false` | 是否允许 `zotero_create_note` 写回；**面板头部的「写回」按钮就是它的运行时开关**，点一下即生效并写回 profile 配置（不用重启） |
| `appName` | `DSH Zotero` | 出现在授权窗与凭据记录里的名字 |
| `maxFulltextChars` | `20000` | 单次全文返回上限 |

### 写回开关（面板头部那颗按钮）

以前 `allowWrite` 只能改配置文件 + 重启 DSH 才生效。现在它是一个**真开关**：

```
点击「写回：关」
   → POST /dsh-zotero/api/write {enabled:true}
   → ① 立刻改运行时 settings（工具与路由共用同一对象 → 本进程马上生效）
     ② configEditor.edit() 走正常 Loader 路径持久化到 profile 配置（重启后仍是这个值）
```

- `configEditor` 不可用时**降级**为"仅本次运行生效"，并在面板 flash 里说明原因——不会静默失败。
- 开开关**不等于**能写库：真正落库还受 Zotero 弹窗授权（Always Allow）与工具默认 dry-run 预览双重门控。
- 关掉开关立即阻断后续写入；已写入 Zotero 的笔记不受影响。
- **配置行会随开关消失**：`configEditor.edit()` 在新值与继承层（bundle 默认）完全相等时会删掉该 profile 补丁行。关掉开关时 `allowWrite:false` 恰等于默认值，于是 `- id: dsh-zotero` 整行（连同注释）被移除；再开回来会重新写入。功能上无影响（回落的就是同一套默认值），但别指望那一行一直留在 `cordis.patch.yml` 里。

写授权：首次写回时 Zotero 会弹窗 → 请点 **Always Allow**（否则每次写入都会再弹一次）。密钥存在 DSH 凭据服务的记录 `dsh-zotero/local-api-key`，不进配置文件。撤销：Zotero 设置 → 高级 → Clear Write Authorizations。

## 模型工具

| 工具 | 用途 |
|---|---|
| `zotero_status` | 连通性/版本/写授权诊断 |
| `zotero_search` | 检索（默认含 PDF 全文）；返回 key + 题录摘要 |
| `zotero_item` | 单条完整元数据 + 附件/笔记/标注计数 |
| `zotero_annotations` | 标注（高亮文字 + 用户评论 + 页码） |
| `zotero_notes` | 笔记正文（HTML→纯文本） |
| `zotero_fulltext` | 附件全文（按字符分页续读） |
| `zotero_citation` | 文内引用 + 参考文献表（CSL 风格）/ BibTeX |
| `zotero_collections` | 分类列表 |
| `zotero_selection` | 用户在面板里勾选的条目/标注 |
| `zotero_authorize` | 触发 Zotero 写授权弹窗 |
| `zotero_create_note` | 写子笔记（默认 dry-run 预览） |
| `zotero_highlight` | 在 PDF 指定文字上创建**高亮标注**并附评论（默认 dry-run；Host 侧用 pdf.js 定位文字算 rect，见 [docs/annotation-creation.md](docs/annotation-creation.md)） |

## 面板路由

Host 半注册同源路由（都带 loopback 信任围栏）：

| 路由 | 用途 |
|---|---|
| `POST /dsh-zotero/api/<method>` | `status` · `write` · `collections` · `items` · `search` · `item` · `annotations` · `notes` · `fulltext` · `citation` · `bibtex` · `fileinfo` · `selection.get\|set\|clear` |
| `GET /dsh-zotero/file?key=<附件key>` | 附件字节流（`Content-Type` 取自 Zotero，支持 `Range`/`206`） |
| `GET /dsh-zotero/vendor/<pdfjs 相对路径>` | pdf.js 资源（白名单：`build/`、`cmaps/`、`standard_fonts/`、`wasm/`；逐段校验，拒绝 `..` 与白名单外路径） |

`POST /api/*` 响应信封：`{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`。`status` 里含 `pdfjs: { available, version }`，面板据此决定自绘还是回退原生阅读器。

## 安全边界（Phase 0 教训，务必保留）

- 变更前**必须单条直读**目标对象；**不信任**列表/聚合结果（本地 API 的 `Total-Results` 实测会不一致）。
- **绝不自动恢复/删除用户的 Zotero 对象**；本插件不做任何 Zotero 侧删除。
- 写回只有**两条通道**：子笔记（`zotero_create_note`）与高亮/下划线标注（`zotero_highlight`）。两者都受 `allowWrite`（面板写回开关）、Zotero 授权与工具默认 dry-run 三重门控；面板自身不写。
- 密钥只存凭据服务；日志与工具输出从不回显密钥。

## 自测（本仓库内可跑）

```powershell
node --check index.js client.js lib\*.js                                # 语法检查
node -e "import('./index.js').then(m=>console.log(m.name, m.inject))"   # 装载自检
node spike\toggle-test.mjs                                              # 写回开关（离线，假 configEditor）
node spike\key-store-test.mjs                                           # 凭据记录键格式（防"下次启动炸"）
node spike\annotation-test.mjs                                          # 高亮几何 + payload 结构
npm pack --dry-run                                                      # 打包清单（应 15 个文件，不含 node_modules/spike/docs）
```

- `spike/toggle-test.mjs` 全离线：用假的 `configEditor` 覆盖「改运行时 settings + 经 Loader 落 profile 补丁」两条路径。
- `spike/key-store-test.mjs` 全离线：断言凭据记录键符合 DSH 的 `<scope>/<id>` grammar，并把旧值 `zotero-local-api-key` 钉成「必须被拒」。对应 2026-11-04 的整机启动事故。
- `spike/annotation-test.mjs` 的**几何断言**需要真值文件 `spike/cases.local.json`——**不入库**，因为它含真实附件 key 与论文原文句子。缺该文件时自动跳过几何部分，只跑 payload 结构断言；准备方法见 `spike/cases.example.json`。

> 其余开发期套件（工具注册契约 / Host 路由 / Client 渲染）不随本仓库分发。`spike/` 与 `docs/` 也不进 npm 包（`files` 白名单不含它们）。

## 调研文档

开发期的一手实测记录归档在 [`docs/`](docs/README.md)，**不随 npm 包分发**（`files` 白名单不含它）：

| 文档 | 内容 |
|---|---|
| [docs/zotero-api-spec.md](docs/zotero-api-spec.md) | 接口规范 v1 + **20 条实测陷阱清单**（实现必读） |
| [docs/annotation-storage.md](docs/annotation-storage.md) | 标注存储核查 + pdf.js 6.x 根因 |
| [docs/annotation-creation.md](docs/annotation-creation.md) | **高亮创建**：rect 公式的实测标定、已知偏差、payload 硬约束 |
| [docs/phase0-test-plan.md](docs/phase0-test-plan.md) | Phase 0 检验计划与结论（含写入实测） |
| [docs/phase0-write-preview.md](docs/phase0-write-preview.md) | 写入请求逐条预览（干跑，未发请求） |
| [docs/zotero-plugin-plan.md](docs/zotero-plugin-plan.md) | 实施计划 v1（历史文档） |

> 文档里的 key / Server-ID / userID / 分类名 / 标签名 / 标注原文一律为占位符。

## 排障

| 现象 | 处理 |
|---|---|
| **DSH 启动失败**，日志报 `credential key "…" must be "<scope>/<id>"` | 装过 ≤0.2.2 且写过授权。按「已知致命问题」删掉 `~/.dsh/.credentials.yaml` 里那条旧键记录即可启动，**不需要** factory reset |
| 工具报 `Zotero 未运行或本地 API 不可达` | 启动 Zotero；确认端口 23119 未被占用 |
| 工具报 `本地 API 未开启` | 设置 → 高级 → 允许其他应用程序通信 |
| 写入报 `写回当前被关闭` | 点面板头部的「写回：关」按钮开启（或把配置 `allowWrite` 设为 `true`） |
| 写回按钮点了没反应 / 提示"仅本次运行生效" | 看 flash 里的 `warning`：`configEditor` 不可用时只能运行时生效；改了 Host 半代码则需重启 DSH |
| 写入报 `需要重新授权` | 重新调用 `zotero_authorize`，弹窗点 Always Allow |
| 写入报 `itemType property not provided` | payload 少了 `itemType: "annotation"`。本仓库已修；若仍出现说明宿主进程跑的是旧代码 → 重启 DSH |
| 高亮报「命中多处」 | **不是错误**：该文字在 PDF 里出现多次（标题最容易被页眉重复），按返回候选补 `pageIndex`，同页仍重复再加 `occurrence` |
| 高亮框比文字略偏上（1.5–2.6pt） | 粗体标题 Zotero 用的是 1.11em 行盒，本实现固定 1.25em；正文逐位吻合，属已知偏差 |
| 全文为空/404 | 该 PDF 未被 Zotero 索引：先在 Zotero 中打开一次 |
