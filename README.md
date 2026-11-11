# dsh-zotero

把本机 **Zotero 文献库**接进 DeepSeek Harness：**侧边栏面板**可浏览条目/标注/笔记并引用到会话，也能在 PDF 上**直接划词建高亮、写评论、删高亮**；**模型工具**可检索条目、读取标注与笔记正文、拉取 PDF 全文、生成题录引用，并把讨论小结写成子笔记、把章节标题标成高亮。

> 能力边界（0.4.x 起面板不再只读）：
> - **读**：条目、分类、附件、标注、笔记正文、PDF 全文。
> - **写**：① 子笔记（`zotero_create_note`）；② 高亮/下划线标注（`zotero_highlight` 与面板划词）；③ **删除标注**（`annotation.delete`，只移入 Zotero 回收站、**可恢复**，不做永久删除）。
> - 所有写入都受「写回」开关 + Zotero 授权双重门控；模型工具的创建类操作默认 dry-run。面板删除必须经过二次确认。
> - 详见[标注创建](#标注创建高亮)与 [docs/annotation-creation.md](docs/annotation-creation.md)。

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
| **行内展开** | 点条目在其**下方**展开操作与详情（摘要、附件、标注、**笔记正文**、加入文献池、引用），不再堆到面板底部 |
| 文献池操作条 | 位于**列表上方**：计数 · 同步到会话 · 引用 · 插入输入框 · 清空 |
| **文档阅读** | 附件行「打开」→ **pdf.js 自绘阅读器**：叠加既有**高亮/下划线**、点标注在**原位弹小窗**看评论并**删除**、**拖选文字直接新建高亮**；另有「DSH 预览」（已被本插件接管，同样可划词）与「新窗口」 |
| **笔记正文** | 展开区「笔记 N 条」逐条显示子笔记正文（纯文本渲染，超 240 字折叠、可展开/收起） |

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

## 标注创建与删除

有两条创建路径，几何口径一致：

| 路径 | 谁定位 | 说明 |
|---|---|---|
| `zotero_highlight`（模型工具） | **Host 侧**读 PDF 原文件，`page.getTextContent()` 取 `transform` | 模型给「文字片段」，Host 负责找到并换算坐标；默认 dry-run |
| 面板 / DSH 预览里**手动划词** | **浏览器侧**，pdf.js 文本层 | 用户拖选 → 用 `viewport.transform` 的逆矩阵换回 PDF 用户空间 → `annotation.create` 路由 |

> 0.4.0 之前面板里的 PDF 是纯 canvas、没有文本层，只能由模型侧建高亮；现在阅读器叠了一层透明文本层（span 按 `viewport.transform` 定位、按 `it.width` 做 `scaleX` 对齐），用户可以直接选中文字。

几何公式不是猜的，是用库里 **12 条真实标注**的 `annotationPosition` 反解标定出来的：

```
fs   = hypot(transform[2], transform[3])        // 该 text item 的字号
rect = [x1, baseline − 0.25·fs, x2, baseline + 1.0·fs]     // Zotero 用 1.25em 行盒
```

8 条正文样本（字号 6.376 / 7.173 / 7.97）与该式**逐位吻合**，下探 0.2500、上伸 1.0000，精确到小数点后四位。手动划词用的是同一套 1.25em 行盒。

| 环节 | 做法 |
|---|---|
| 定位 | 按基线（2pt 容差）归行 → 对行文本与目标文本做同一套归一化（折叠空白 + 小写）→ `indexOf` → 映射回原串区间，取相交 text item 的并集 |
| **歧义** | 命中 ≥2 处**不猜**：不写入，返回候选（页码 + 一行上下文），由模型补 `pageIndex`（同页仍重复再加 `occurrence`）重跑 |
| 文字来源 | `annotationText` 取 PDF **原串切片**，不接受模型改写；跨行片段直接报错。手动划词同理——存的是 PDF 里真实存在的文字 |
| 门控 | 默认 `dry-run`（只定位、不发请求）；`dryRun:false` 才依次过**写回开关**与**Zotero 授权**。面板划词不走 dry-run，但同样受写回开关约束，且必须用户主动点「保存」 |

### 删除标注（`annotation.delete`）

面板里点开任意高亮 → 小窗底部**红色「删除」** → 二次确认 → 移入 **Zotero 回收站**。

| 决策 | 原因 |
|---|---|
| **只做回收站，不做永久删除** | `POST /items [{key, version, deleted:1}]` 是实测可用的；`DELETE /items/<key>` 永久删除只有文档、未实测，不能当默认路径。删错了在 Zotero 里能恢复 |
| 写入前校验 `data.itemType === 'annotation'` | 防误删：就算 key 传错，也不可能把整篇文献删掉 |
| 必须二次确认 | 破坏性操作，且文案直接写明「可以在回收站里恢复」 |

> ⚠️ **为什么必须"不猜"**：实测一篇 13 页论文里同一串文字出现 **12 次**，第 1 处是页眉残片，真正的节标题在第 2 页。早期版本取第一处就返回，高亮会静默标到错误位置——界面上"有高亮"，很难发现。
> ⚠️ **payload 必须带 `itemType: "annotation"`**：缺了它 Zotero 直接回 `400 itemType property not provided`（第一次真写时四条全被拒）。另注意颜色字段是 **`annotationColor`** 不是 `color`，写错会报 `'extra' is not a valid field`。完整字段形状、sortIndex 规则与已知几何偏差见 [docs/annotation-creation.md](docs/annotation-creation.md)。

## 笔记正文

展开条目后「笔记 N 条」逐条显示子笔记正文：纯文本渲染（不走 `innerHTML`）、超过 240 字折叠并可展开/收起、被截断时给出提示。正文来自既有 `notes` 路由，本插件不解析 HTML 结构。

## DSH 预览接管（`registerFileViewer`）

面板里有两个 PDF 表面，**它们不是同一套渲染**：

| 表面 | 谁渲染 | 能否划词 |
|---|---|---|
| 「打开」（面板内） | 本插件的 pdf.js 阅读器 | ✅ |
| 「DSH 预览」 | `dsh-better-sidebar` 的 editor tab | 0.4.0 起 ✅ |

「DSH 预览」原来用 **object URL + 浏览器原生 PDF 阅读器**——那是一个独立的不透明文档，插件既不能注入文本层，也拿不到选区，所以**不可能**在那里加高亮。

解法是用 `dsh-better-sidebar` 的 `registerFileViewer` 扩展点接管 `.pdf`：

```js
service.registerFileViewer({
  id: 'dsh-zotero:pdf', exts: ['pdf'], priority: 1,   // 内置用 0，1 即可胜出
  fetchStrategy: 'mediaUrl',
  component: (props) => h(ZoteroPdfView, props),
});
```

接管后两个表面复用同一个 `PdfPage`，行为一致。非 Zotero 附件（从文件树直接打开的 PDF）自动降级为**只读**，不会出现「保存必然失败」的浮层。

> 高亮写回必须知道**附件 key**，而 tab 只拿到本地路径 → Host 侧维护一个「路径 → 附件 key」内存索引（`createPathIndex`，上限 500 条，路径归一化大小写与斜杠），`fileinfo` 顺手记录，`attachment.byPath` 纯内存反查。
> 不想用时可以在 `dsh-better-sidebar` 设置页里单独关掉这个 viewer（每个注册的 viewer 都有开关），原生阅读器会回来。

## 写授权与自愈（0.4.2）

写密钥存在 DSH 凭据服务里（记录键 `dsh-zotero/local-api-key`）。**0.4.1 及以前有个坑**：插件激活时凭据服务可能还没就绪，`load()` 读不到就再没有第二次机会，内存里永远是空 key——表现为重启后 `zotero_status` 显示「写授权：未授权」，而**建高亮能用、删高亮必挂**（因为 `annotation.create` 每次都会先 `authorize()` 顺手把 key 塞进内存，`annotation.delete` 不会）。

现在的四层兜底，从便宜到贵：

| 层 | 做法 |
|---|---|
| 1 | 启动时 `load()` 退避重试 4 次（凭据服务可能比插件晚就绪） |
| 2 | 写操作前 `keyStore.ensureLoaded()` 再要一次（多数情况到此为止，**不弹框**） |
| 3 | 撞到 401 时 `withAuthRetry` 重新申请授权并重试一次 |
| 4 | 仍然没有 → 向 Zotero 申请授权，**Zotero 会弹确认框，请点「Always Allow」** |

> 第 4 层的超时放宽到 **120 秒**（这是交互式请求，15 秒不够人点）。超时文案会直接告诉你「请在 Zotero 窗口里点 Always Allow」，而不是干巴巴一句「响应超时」。

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

# 2) 装本插件（任选一条）
dsh plugin --profile web add "github:waizzie/dsh-zotero"           # 跟随 main
dsh plugin --profile web add "github:waizzie/dsh-zotero#v0.2.3"    # 锁 tag（推荐）

# 3) 重启 dsh web（host 半改动只在重启后生效）
```

> ⚠️ **不要安装 `v0.2.2` 及更早的版本。** 那些版本有会让 DSH **起不来**的凭据键 bug（见下方
> 「已知致命问题」）。`v0.2.1` 与 `v0.2.2` 的 tag 及 release 均已从远端删除；`v0.2.3` 起已修复。

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
| `zotero_find_pdf` | 调用 **Zotero 内置的「查找可用文件」** 为条目下载并挂上 PDF/EPUB（需装桥接插件，见 [bridge/README.md](bridge/README.md)） |
| `zotero_citation` | 文内引用 + 参考文献表（CSL 风格）/ BibTeX |
| `zotero_collections` | 分类列表 |
| `zotero_selection` | 用户在面板里勾选的条目/标注 |
| `zotero_authorize` | 触发 Zotero 写授权弹窗 |
| `zotero_create_note` | 写子笔记（默认 dry-run 预览） |
| `zotero_highlight` | 在 PDF 指定文字上创建**高亮标注**并附评论（默认 dry-run；Host 侧用 pdf.js 定位文字算 rect，见 [docs/annotation-creation.md](docs/annotation-creation.md)） |

## 查找原文（`zotero_find_pdf`）

**Zotero 的本地 API 没有「查找原文」端点。** 把 `C:\Program Files\Zotero\app\omni.ja` 里的 `server*.js` 全部导出核对过：50 多个端点里只有 `/connector/saveAttachmentFromResolver` 沾边，而它依赖浏览器连接器的 session（`SessionManager.get(sessionID)`），只能给"此刻正从网页保存的新条目"用，对库里已有条目直接 400。

真正的解析逻辑是 `Zotero.Attachments.getFileResolvers()` + `addFileFromURLs()`，跑在 Zotero 进程内的 JS 上下文里，外部进程调不到。所以本仓库附带一个**桥接插件**（`bridge/`），把这两个函数包成端点：

| 端点 | 用途 |
|---|---|
| `GET /dsh-zotero/ping` | 探活 + 版本 + `canFindFiles` |
| `POST /dsh-zotero/find-file` | `{ itemKey, dryRun?, force?, methods? }` → 下载并挂附件 |

它不实现任何抓取逻辑，只是转发——所以行为和你右键「查找可用的 PDF」完全一致（DOI / URL / 开放获取 / 自定义解析器都走 Zotero 自己那套）。

### 安装桥接插件（一次性）

```powershell
node bridge\build.mjs          # 生成 bridge\dsh-zotero-bridge-<version>.xpi
```

然后 Zotero → **工具 → 插件 → 右上角齿轮 → 从文件安装插件** → 选那个 `.xpi` → 重启 Zotero。

验证：

```powershell
curl.exe http://127.0.0.1:23119/dsh-zotero/ping
# {"ok":true,"bridge":"dsh-zotero-bridge","version":"0.1.0",...}
```

没装时该地址返回 `No endpoint found`，此时 `zotero_find_pdf` 会明确报 `bridge-missing` 并给出安装指引，而不是含糊的 404。

### 行为

- **条目已有 PDF/EPUB 时默认跳过**（`alreadyHad`），不会重复下载；要强制重试传 `force=true`。
- `dryRun=true` 只返回可用解析器数量与类型，不下载——适合先探一下有没有戏。
- `methods` 默认 `['doi','url','oa','custom']`；只想要开放获取可传 `['oa']`。
- 会向 Zotero 库添加附件，所以和写笔记/高亮一样受**「写回」开关**约束。
- 下载在 Zotero 内进行，可能较慢（客户端超时放宽到 180 秒）。

### 安全

桥接端点只随 Zotero 自己的本地服务监听 `127.0.0.1:23119`，不对外网开放。如需额外防护，在 Zotero 高级设置里加字符串偏好 `extensions.zotero.dshBridge.token`，之后请求必须带 `X-DSH-Bridge-Token` 头。

## 面板路由

Host 半注册同源路由（都带 loopback 信任围栏）：

| 路由 | 用途 |
|---|---|
| `POST /dsh-zotero/api/<method>` | `status` · `write` · `collections` · `items` · `search` · `item` · `annotations` · `notes` · `fulltext` · `citation` · `bibtex` · `fileinfo` · `attachment.byPath` · `annotation.create` · `annotation.delete` · `selection.get\|set\|clear` |
| `GET /dsh-zotero/file?key=<附件key>` | 附件字节流（`Content-Type` 取自 Zotero，支持 `Range`/`206`） |
| `GET /dsh-zotero/vendor/<pdfjs 相对路径>` | pdf.js 资源（白名单：`build/`、`cmaps/`、`standard_fonts/`、`wasm/`；逐段校验，拒绝 `..` 与白名单外路径） |

`POST /api/*` 响应信封：`{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`。`status` 里含 `pdfjs: { available, version }`，面板据此决定自绘还是回退原生阅读器。

写类路由的入参：

| 路由 | 入参 | 说明 |
|---|---|---|
| `annotation.create` | `{ attachmentKey, text, comment?, color?, pageIndex, pageLabel?, pageHeight, rects }` | 由浏览器侧算好坐标后提交；受 `allowWrite` 门控 |
| `annotation.delete` | `{ key }` | 只移入回收站（`deleted:1`），可恢复 |
| `attachment.byPath` | `{ path }` | 本地路径 → 附件 key，纯内存索引，不访问 Zotero |

## 安全边界（Phase 0 教训，务必保留）

- 变更前**必须单条直读**目标对象；**不信任**列表/聚合结果（本地 API 的 `Total-Results` 实测会不一致）。
- **绝不自动恢复/删除用户的 Zotero 对象**。0.4.1 起唯一的删除能力是用户显式触发的 `annotation.delete`：范围限定在**用户点开并确认的那一条**，只做**移入回收站**（可恢复），不做永久删除，且写入前校验 `itemType === 'annotation'`——禁止按标签/条件扫库兜底删除。
- 写回通道：子笔记（`zotero_create_note`）、高亮/下划线标注（`zotero_highlight` 与面板划词）、标注删除（面板按钮）。创建类工具默认 dry-run，且都受 `allowWrite`（面板写回开关）与 Zotero 授权门控。
- 密钥只存凭据服务；日志与工具输出从不回显密钥。

## 自测（本仓库内可跑）

```powershell
node --check index.js client.js lib\*.js                                # 语法检查
node -e "import('./index.js').then(m=>console.log(m.name, m.inject))"   # 装载自检
node spike\toggle-test.mjs                                              # 写回开关（离线，假 configEditor）
node spike\key-store-test.mjs                                           # 凭据记录键格式 + ensureLoaded 补读
node spike\annotation-test.mjs                                          # 高亮几何 + payload 结构
node spike\annotation-route-test.mjs                                    # annotation.create 入参校验与组装
node spike\annotation-delete-test.mjs                                   # 删除只允许 annotation、body 形状
node spike\attachment-bypath-test.mjs                                   # 本地路径 → 附件 key 的内存索引
node spike\find-pdf-test.mjs                                            # 查找原文的客户端契约（假 Zotero 服务器）
npm pack --dry-run                                                      # 打包清单（应 22 个文件，不含 node_modules/spike/docs）
```

- `spike/toggle-test.mjs` 全离线：用假的 `configEditor` 覆盖「改运行时 settings + 经 Loader 落 profile 补丁」两条路径。
- `spike/key-store-test.mjs` 全离线：断言凭据记录键符合 DSH 的 `<scope>/<id>` grammar，并把旧值 `zotero-local-api-key` 钉成「必须被拒」。对应 2026-11-04 的整机启动事故；另含 `ensureLoaded()` 的补读回归（对应 0.4.2 修的重启后 401）。
- `spike/annotation-test.mjs` 的**几何断言**需要真值文件 `spike/cases.local.json`——**不入库**，因为它含真实附件 key 与论文原文句子。缺该文件时自动跳过几何部分，只跑 payload 结构断言；准备方法见 `spike/cases.example.json`。
- `spike/annotation-delete-test.mjs` 全离线：`buildTrashBody` 必须拒绝非 annotation 条目（防误删整篇文献），并校验 body 形状为 `[{key, version, deleted:1}]`。
- `spike/find-pdf-test.mjs` 全离线：起一个假 Zotero 服务器，断言 `zotero_find_pdf` 的请求形状，以及「桥接插件没装」「条目不存在」「没找到文件」「下载失败」四种情况必须区分得开。

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
