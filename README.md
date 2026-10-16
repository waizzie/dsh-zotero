# dsh-zotero

把本机 **Zotero 文献库**接进 DeepSeek Harness：**侧边栏面板**可浏览条目/标注/笔记并引用到会话；**模型工具**可检索条目、读取标注与笔记正文、拉取 PDF 全文、生成题录引用，并（可选）把摘录写成子笔记。

> 本轮范围：**只读能力 + 标注渲染 + 子笔记写回**。
> 高亮/标注的**创建**与坐标回写**尚未实现**（调研结论与完整规格见 [docs/zotero-api-spec.md](docs/zotero-api-spec.md) §4.4/§5）；本轮只做"把已有标注渲染出来"。

## 侧边栏面板（承载面 A）

面板通过 `dsh-better-sidebar` 的 `ctx.betterSidebar.registerTab()` 注册，渲染在 **DSH 原生右侧栏**（tab 条 / 分栏 / 会话级持久化由插件与宿主提供）。

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
| 头部 | 连接状态（Zotero 版本 / 库版本 / 写回开关）+ 刷新 |
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

> 只渲染**已有**标注：本轮不创建、不修改、不删除任何 Zotero 对象（面板侧全程只读）。

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

## 排障（面板）

| 现象 | 处理 |
|---|---|
| 右侧栏 `+` 菜单里没有 Zotero | 确认 `dsh-better-sidebar` 处于启用状态；**改了 `package.json`/`client.js` 后需要重启 DSH**（client 条目在启动时装配） |
| 面板显示「未连接」 | 按上面的前置条件检查 Zotero 是否运行、本地 API 是否开启 |
| 点「插入输入框」提示已复制 | 该 DSH 版本的 composer 接口不可用，退化为剪贴板，属于预期降级 |


## 前置条件

1. DSH 侧已启用 **`dsh-better-sidebar`**（本插件的面板注册在它提供的右侧栏上）。
2. 本机安装了 **Zotero 7+ 桌面端**（实测 10.0.5），并保持**运行中**。
3. Zotero 中开启本地 API：**设置 → 高级 → 勾选「允许其他应用程序与 Zotero 通信」**。
   - 未开启时所有工具会返回可读的 403 提示。
4. 端口 23119 仅本机可达，**不要转发**。

## 安装

```powershell
# 1) 先装面板承载者（客户端半注入它，缺它右侧栏注册不上）
dsh plugin --profile web add dsh-better-sidebar

# 2) 装本插件（任选一条）
dsh plugin --profile web add "github:waizzie/dsh-zotero"           # 跟随 main
dsh plugin --profile web add "github:waizzie/dsh-zotero#v0.2.1"    # 锁 tag
dsh plugin --profile web add "https://github.com/waizzie/dsh-zotero/releases/download/v0.2.1/dsh-zotero-0.2.1.tgz"

# 3) 重启 dsh web（host 半改动只在重启后生效）
```

> 从 git 或 registry 来源安装时无需手工装依赖：包管理器会按 `dependencies` 自动装上 `pdfjs-dist`
> （面板用它把 Zotero 标注叠加在自绘 PDF 上；缺失时自动退回原生 `<iframe>` 阅读器）。
> 只有**本地路径 `link:` 安装**例外——DSH 不会替被链接的包装依赖，需先在该包目录内执行一次
> `npm install`（或 `pnpm add pdfjs-dist@6.3.289`），再用 `dsh plugin add` 指向它。

## 配置

`cordis.patch.yml` 里的 `config`（也可在 DSH 设置里按 load 行 id `dsh-zotero` 覆盖）：

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:23119` | Zotero 本地 API 基址 |
| `allowWrite` | `false` | 是否允许 `zotero_create_note` 写回；开启后首次写入会弹 Zotero 授权窗 |
| `appName` | `DSH Zotero` | 出现在授权窗与凭据记录里的名字 |
| `maxFulltextChars` | `20000` | 单次全文返回上限 |

写授权：首次写回时 Zotero 会弹窗 → 请点 **Always Allow**（否则每次写入都会再弹一次）。密钥存在 DSH 凭据服务的记录 `zotero-local-api-key`，不进配置文件。撤销：Zotero 设置 → 高级 → Clear Write Authorizations。

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

## 面板路由

Host 半注册同源路由（都带 loopback 信任围栏）：

| 路由 | 用途 |
|---|---|
| `POST /dsh-zotero/api/<method>` | `status` · `collections` · `items` · `search` · `item` · `annotations` · `notes` · `fulltext` · `citation` · `bibtex` · `fileinfo` · `selection.get\|set\|clear` |
| `GET /dsh-zotero/file?key=<附件key>` | 附件字节流（`Content-Type` 取自 Zotero，支持 `Range`/`206`） |
| `GET /dsh-zotero/vendor/<pdfjs 相对路径>` | pdf.js 资源（白名单：`build/`、`cmaps/`、`standard_fonts/`、`wasm/`；逐段校验，拒绝 `..` 与白名单外路径） |

`POST /api/*` 响应信封：`{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`。`status` 里含 `pdfjs: { available, version }`，面板据此决定自绘还是回退原生阅读器。

## 安全边界（Phase 0 教训，务必保留）

- 变更前**必须单条直读**目标对象；**不信任**列表/聚合结果（本地 API 的 `Total-Results` 实测会不一致）。
- **绝不自动恢复/删除用户的 Zotero 对象**；本插件不做任何 Zotero 侧删除。
- 写回只允许"子笔记"这一条通道，且受 `allowWrite` 与用户确认双重门控。
- 密钥只存凭据服务；日志与工具输出从不回显密钥。

## 自测（本仓库内可跑）

```powershell
node --check index.js client.js lib\*.js                                     # 语法检查
node -e "import('./index.js').then(m=>console.log(m.name, m.inject))"        # 装载自检
npm pack --dry-run                                                           # 打包清单（应 14 个文件，不含 node_modules）
```

> 开发期的完整回归套件（工具注册契约 / Host 路由 / Client 渲染 / 实库几何校验）不随本仓库分发。

## 调研文档

开发期的一手实测记录归档在 [`docs/`](docs/README.md)，**不随 npm 包分发**（`files` 白名单不含它）：

| 文档 | 内容 |
|---|---|
| [docs/zotero-api-spec.md](docs/zotero-api-spec.md) | 接口规范 v1 + **20 条实测陷阱清单**（实现必读） |
| [docs/annotation-storage.md](docs/annotation-storage.md) | 标注存储核查 + pdf.js 6.x 根因 |
| [docs/phase0-test-plan.md](docs/phase0-test-plan.md) | Phase 0 检验计划与结论（含写入实测） |
| [docs/phase0-write-preview.md](docs/phase0-write-preview.md) | 写入请求逐条预览（干跑，未发请求） |
| [docs/zotero-plugin-plan.md](docs/zotero-plugin-plan.md) | 实施计划 v1（历史文档） |

> 文档里的 key / Server-ID / userID / 分类名 / 标签名 / 标注原文一律为占位符。

## 排障

| 现象 | 处理 |
|---|---|
| 工具报 `Zotero 未运行或本地 API 不可达` | 启动 Zotero；确认端口 23119 未被占用 |
| 工具报 `本地 API 未开启` | 设置 → 高级 → 允许其他应用程序通信 |
| 写入报 `写回当前被关闭` | 把 `allowWrite` 设为 `true` |
| 写入报 `需要重新授权` | 重新调用 `zotero_authorize`，弹窗点 Always Allow |
| 全文为空/404 | 该 PDF 未被 Zotero 索引：先在 Zotero 中打开一次 |
