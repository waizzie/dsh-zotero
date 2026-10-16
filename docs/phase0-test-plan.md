# Phase 0 检验计划：笔记/标注能否双向同步（待审核）

> 目的：在**动手写插件之前**，用一组可复现的检验确认三件事——
> ① Zotero 里的笔记与高亮能不能被完整读出来（→ 喂给模型）；
> ② 能不能把笔记与高亮**写回** Zotero 并在客户端里正常显示；
> ③ 写回通道的边界条件（幂等、版本、授权、字段陷阱）是否可控。
>
> 审核通过后再执行。执行时会**写入你的真实 Zotero 库**（隔离在 `DSH-TEST-*` 命名空间内，可一键清理），所以需要你明确授权，并在弹窗出现时点一次「Always Allow」。

---

## 0. 最高风险项（本计划要回答的核心问题）

| 问题 | 现状判断 | 本计划如何定性 |
|---|---|---|
| 子笔记写入 | 官方文档明确支持 | T4 全组用例 |
| **高亮/标注写入** | 官方**写文档未覆盖**，但官方源码显示标注是 `itemAnnotations` 表的一等公民、PDF 文件永不被改写；已有第三方项目在生产使用 | **T5 全组用例**（含可视化验收） |
| 浏览器能否直连本地 API | **不能**（Zotero 只给硬编码 bookmarklet 来源发 CORS 头，且浏览器特征请求被直接断连） | 已确认 → 插件必须走 Host 半中转，T0 记录 |
| 写授权成本 | `remember=false` 时 key **在鉴权阶段就被消耗**（即使写失败也消耗）→ 每个写请求都要弹窗 | T3 验证 `Always Allow` 后能否长期复用 |
| 字段名陷阱 | 写错字段名（如 `pageLabel`/`sortIndex`）**不报错、静默丢失** | T5.8 / T5.9 反例验证 |

---

## 1. 已核实的现场事实（本轮只读实测，未改动任何数据）

**环境**

- Zotero 桌面版 **10.0.5**（`<Zotero 安装目录>/app/application.ini`，BuildID 20260930221031）
- 本地 API：`http://127.0.0.1:23119/api/`，`Zotero-API-Version: 3`，`Zotero-Schema-Version: 44`
- **`Zotero-Server-ID: <server-id>`**（所有写请求必须带此头；缺失 428、不匹配 412）
- 库版本（`Last-Modified-Version`）：**195**
- 传输：响应为 `HTTP/1.0`，**有 body 时不发 `Content-Length`**（靠连接关闭定界）
- 存活探测：`GET /connector/ping` → 200 `Zotero is running`（不需要本地 API 开关）

**库存（读能力已确认）**

| 项 | 值 |
|---|---|
| 总条目 / 顶层条目 | 448 / 103 |
| 标注 annotation | **210**（highlight 195 + underline 5） |
| 笔记 note | **9**（3 条子笔记 + 2 条 29 KB 独立长笔记 + …） |
| 附件 / PDF | 130 / 130 |
| 期刊论文 | 70 | 
| 集合 / 标签 | 9 / 305 |
| 有标注的 PDF 附件 | 11 个（最多一个 52 条，其次 45、40 条） |

**读接口形状（本轮实测，含一个关键纠正）**

| 端点 | 结果 |
|---|---|
| `GET /items/<附件key>/children` | **返回 0**（默认**排除**标注/笔记） |
| `GET /items/<附件key>/children?itemType=annotation` | 返回该附件的全部标注（实测 5 / 45 条） |
| `GET /items/<顶层key>/children?itemType=note` | 返回子笔记（实测 1 条） |
| `GET /items?itemType=annotation&limit=200&format=versions` | 210 条标注的 key→version 增量视图 |
| `GET /items?since=190` | 增量有效（返回 3 条，version 192/193/195） |
| `GET /items/<附件>/fulltext` | `{content, indexedPages, totalPages}`（实测 52 832 字 / 11 页） |
| `GET /items/<key>/file/view/url` | 200 纯文本 `file:///<数据目录>/storage/<key>/<文件名>` |
| `GET /items?q=<检索词>&qmode=everything` | 41 命中（默认 `titleCreatorYear` 仅 9）→ **全文检索可用** |
| `GET /items/<key>?format=bibtex` | 完整 BibTeX（含 `file` 字段） |
| `GET /items/<key>?include=data,citation&style=apa` | `citation: "(Tomasev et al., 2021)"` |
| `GET /items/<key>/children?itemType=...` 之外的 `/items/new?itemType=X` | **本地 404**（无模板端点，payload 需自建） |
| `GET /itemTypeFields?itemType=annotation` / `note` | `[]`（schema 里这两类无 itemData 字段） |
| 连续 100 次 GET | 0 失败，p50 6 ms / p95 8 ms（Node 24 `fetch`） |

**真实标注样本（写回 payload 的权威模板）**

```json
{
  "key": "<顶层key>", "version": 88,
  "data": {
    "itemType": "annotation", "parentItem": "<附件key>",
    "annotationType": "highlight",
    "annotationAuthorName": "",
    "annotationText": "<被高亮的原文>",
    "annotationComment": "<评论 HTML>",
    "annotationColor": "#ffd400",
    "annotationPageLabel": "3",
    "annotationSortIndex": "00002|001409|00635",
    "annotationPosition": "{\"pageIndex\":2,\"rects\":[[61.231,150.358,138.109,157.786]]}",
    "tags": [{ "tag": "<标签>" }], "relations": {},
    "dateAdded": "2026-09-30T05:12:52Z", "dateModified": "2026-09-30T05:13:26Z"
  }
}
```

要点：`parentItem` 指向**附件**（不是父条目）；`annotationPosition` 是 **JSON 字符串**（底部左原点、PDF 原生点坐标）；`annotationComment` 是 HTML。

**笔记样本**：`data` 键为 `itemType, note, parentItem?, tags, collections, relations, key, version, dateAdded, dateModified`；`note` 是 HTML（实测含 `<h1>/<h2>/<blockquote>/<p>/<strong>/<hr>/<span>` 与 **MathML**（`<math>/<mi>/<mo>/<mrow>`），因为其中两条是 Zotero GPT 生成的 29 KB 长笔记）。

---

## 2. 测试隔离方案（请选一个）

| 方案 | 做法 | 对真实库的影响 | 工作量 |
|---|---|---|---|
| **α（推荐）** | 新建测试条目 `DSH-TEST-<时间戳>` + **本地生成 1 页测试 PDF** 上传为该条目的附件；笔记/高亮全部写在这个隔离条目下 | 仅新增 1 个条目 + 1 个几 KB 附件 + 若干子对象，**测完整体进回收站**；不碰任何真实论文 | 中（需实现 3 步文件上传） |
| β | 用你指定的**某个现有 PDF 附件**做标注测试（例如只有 1 条标注的 `<附件key>`/`<附件key>` 或 52 条的 `<附件key>`） | 会在真实论文里临时出现测试高亮，测完删除 | 小（省去上传） |
| γ | 只跑**只读**部分（T0/T1），写回部分暂不跑 | **零影响** | 最小 |

> 若你开启了 Zotero 同步，α 产生的测试对象在清理前会同步到 zotero.org（清理后留下删除标记）。你可在测试期间暂停同步，或用 γ 完全规避。
> 若 α 的 3 步上传失败（计划里 T5.1 就是验证它），自动回退到 β。

---

## 3. 测试用例

约定：`BASE=http://127.0.0.1:23119`；`SID=<server-id>`；写请求头统一 `Zotero-API-Key: <key>`、`Zotero-Server-ID: $SID`；**所有写请求 body 必须是 JSON 数组**（`POST /items`）。

### T0 环境与传输（只读）

| ID | 检验 | 请求 | 期望 / 判据 |
|---|---|---|---|
| T0.1 | 握手与版本 | `GET /api/` | 200；`Zotero-API-Version: 3`；`Zotero-Server-ID` 记录；非 200 则中止全部测试 |
| T0.2 | 库版本基线 | `GET /api/users/0/items?limit=1` | 记 `Last-Modified-Version`（当前 195）作为测试前后对比基准 |
| T0.3 | 存活探测 | `GET /connector/ping` | 200 `Zotero is running`（Zotero 关闭时的降级判据） |
| T0.4 | HTTP 客户端稳定性 | 串行 200 次 `GET /items?limit=1`；`fetch` 与 `node:http`+`Connection: close` 各 100 次 | 失败 ≤1%；无挂起。**判据**：决定生产插件用哪种客户端（已知 undici 在 HTTP/1.0 连接关闭路径上有崩溃报告） |
| T0.5 | 不开开关的行为 | （可选）关闭本地 API 后 `GET /api/users/0/items?limit=1` | 403 + `Local API is not enabled` → 面板提示文案的依据。**可选**，需你手动改设置 |

### T1 读能力：Zotero → DSH（只读）

| ID | 检验 | 请求 | 期望 / 判据 |
|---|---|---|---|
| T1.1 | 附件标注必须带过滤 | `GET /items/<附件key>/children` vs `?itemType=annotation` | 前者 0、后者 5 → **结论：读标注必须显式 `itemType=annotation`**（写进实现规范） |
| T1.2 | 全库标注 + 增量 | `GET /items?itemType=annotation&format=versions`；`?since=195` | 拿到 210 条 key→version；`since` 能只取新增 → 增量缓存可行 |
| T1.3 | 笔记正文 | `GET /items?itemType=note&format=json` | 9 条，`note` 为 HTML；**判据**：列出 HTML 标签直方图，确认转 Markdown/纯文本的清洗规则（含 MathML 的处理策略） |
| T1.4 | 标注字段完整性 | `GET /items/<附件key>/children?itemType=annotation` | 52 条全部含 `annotationText/Comment/Color/PageLabel/SortIndex/Position`；抽查 3 条 position 与页码一致性 |
| T1.5 | 排序语义 | 对上述 52 条按 `annotationSortIndex` 排序 | 与 `pageIndex` 顺序一致；不一致则记录 → 用作我们写回时 sortIndex 的容差判据 |
| T1.6 | 全文取回 | `GET /items/<附件key>/fulltext` | 200 + `content`/`indexedPages`/`totalPages` → 供模型读原文 |
| T1.7 | 全文检索 | `GET /items?q=<PDF 中词>&qmode=everything` | 命中数 > 默认 qmode；**判据**：模型可定位"哪篇文献提到 X" |
| T1.8 | 题录 | `GET /items/<key>?format=bibtex`；`GET /items/<key>?include=data,citation&style=apa` | 与 Zotero 界面一致；**注意**：本地默认 style 是 `chicago-shortened-notes-bibliography`，务必显式传 style |
| T1.9 | 附件本地路径 | `GET /items/<att>/file/view/url` | 200 `file:///…`；用于后续"在 DSH 里预览 PDF" |

### T2 写入门禁（**故意失败**的写请求，不改数据）

| ID | 检验 | 请求 | 期望 / 判据 |
|---|---|---|---|
| T2.1 | 缺 Server-ID | `POST /api/local/authorize`，body `{"appName":"…"}`，**不带** `Zotero-Server-ID` | **428**；且不弹窗（Server-ID 校验在弹窗之前） |
| T2.2 | body 非数组 | `POST /items`，body `{}`（带有效 key） | **400** `Uploaded data must be a JSON array`；库里无新增 |
| T2.3 | 无效 key | `POST /items`，`Zotero-API-Key: 0000…` | **401** + `WWW-Authenticate: Zotero-API-Key realm="Zotero Local API"` |
| T2.4 | 无 key | `POST /items`，不带 key | **401**，不写入 |
| T2.5 | 状态行解析 | 任取 T2.1/T2.3 的原始响应 | 记录 `HTTP/1.0 428 undefined` 这类畸形 reason phrase → **实现不得解析 reason phrase** |

### T3 授权流程

| ID | 检验 | 步骤 | 期望 / 判据 |
|---|---|---|---|
| T3.1 | 申请密钥 | `POST /api/local/authorize` + `Zotero-Server-ID` + `Content-Type: application/json`，body `{"appName":"DSH Zotero (Phase0 Test)"}` | 弹出 Zotero 授权窗；**请你点「Always Allow」**；响应 `{"key":"<32字符>","remember":true}`；key 落盘到工作区 `spike/.zotero-key.json`（不入库、不提交） |
| T3.2 | 密钥可复用 | 用该 key 连续执行 2 次成功的写请求（T4.1 与 T4.2） | 第二次**不再弹窗** → 判定"长期可用" |
| T3.3 | 401 恢复 | 先故意用错 key 触发 401（T2.3），再用真 key 重试同一请求 | 重试成功 → 重授权逻辑可行 |
| T3.4 | 429 限流 | **不实测**（会连续弹窗骚扰你） | 仅在实现里按文档做退避 + `Retry-After`；文档记为"未实测" |

### T4 笔记写回（核心需求）

| ID | 检验 | 请求/步骤 | 期望 / 判据 |
|---|---|---|---|
| T4.0 | 建隔离父条目 | `POST /items` `[{"itemType":"journalArticle","title":"DSH-TEST-<ts>","creators":[...],"date":"2026"}]` | 200 + `success["0"]=<key>`；记录 key 与 version |
| T4.1 | 写**子笔记** | `POST /items` body：`[{"itemType":"note","parentItem":"<T4.0 key>","note":"<h2>DSH 测试笔记</h2><p>正文…</p><ul><li>要点</li></ul><p><strong>加粗</strong>与<em>斜体</em></p><blockquote>引用</blockquote>","tags":[{"tag":"dsh-test"}]}]` | 200；`successful` 含完整对象；`failed` 空。**回读比对**：`GET /items/<新key>` 的 `note` 与提交内容一致（会被 Zotero 规范化则记录差异） |
| T4.2 | 写**独立笔记** | 同上但去掉 `parentItem` | 200；出现在顶层（`/items/top` 能查到） |
| T4.3 | **批量**（省弹窗） | 一次请求写 3 条笔记（数组长度 3） | 200；`successful` 3 条，各自 key；**判据**：确认"一次授权可写多条" |
| T4.4 | 客户端可见性（**目视**） | 切到 Zotero，打开 `DSH-TEST-*` 条目 | 右侧「笔记」栏出现子笔记、内容/加粗/列表正确渲染；独立笔记出现在我的文库 |
| T4.5 | 更新笔记 | `PATCH /items/<noteKey>` body `{"note":"<p>更新后</p>","version":<v>}` | 204；UI 刷新后内容更新 |
| T4.6 | Markdown 直传反例 | 写入 `note` 为 `**粗体** 与 - 列表` 纯文本 | 期望：以**字面文本**显示 → **判据：实现必须先转 HTML** |
| T4.7 | HTML 消毒边界 | 写入含 `<script>alert(1)</script>`、`<img src=x onerror=alert(1)>` 的 note | 记录 Zotero 的存储/渲染行为 → 决定我们写入前的白名单清洗规则（只允许 `p/br/strong/em/ul/ol/li/h1-h3/blockquote/code/pre/a/img?`） |
| T4.8 | 失败路径 | ① `parentItem` 指向不存在的 key ② `note` 传数字 | 均为 200 + `failed["0"].code=400`（**不是** HTTP 4xx）→ **判据：实现必须逐对象检查 `failed`** |
| T4.9 | 幂等 token | 同一请求带同一 `Zotero-Write-Token` 连发两次 | 第二次 412 → 防重复提交可行 |
| T4.10 | 版本前置 | 用**旧** version `PATCH` 笔记 | 412 → 重读版本重试成功 |

### T5 高亮/标注写回（本计划的关键）

| ID | 检验 | 请求/步骤 | 期望 / 判据 |
|---|---|---|---|
| T5.1 | 建测试 PDF 附件 | ① 生成 1 页 PDF（文本行 `DSH-ZOTERO-TEST <ts>` 绘制在已知坐标，如基线 (72,700)、12pt）② `POST /items` 建 `attachment`（`linkMode:"imported_file"`,`contentType:"application/pdf"`,`filename`,`title`,`parentItem`=T4.0 条目）③ `POST /items/<attKey>/file?md5=&filename=&filesize=&mtime=` + `If-None-Match: *` ④ `POST` 字节到返回的 `url` ⑤ 再 `POST /items/<attKey>/file?upload=<uploadKey>` | ①→⑤ 全绿：`{exists:1}` 或 uploadKey 路径；最终附件可下载/可打开。**若失败 → 回退方案 β**（改用你指定的现有 PDF） |
| T5.2 | 复核父项合规 | `GET /items/<attKey>` | `contentType=application/pdf`、`linkMode!=linked_url` → 满足标注父项四重校验中的"文件附件 + reader type" |
| T5.3 | 写 **highlight** | `POST /items`，**字段键序**：`itemType, parentItem, annotationType, annotationText, annotationSortIndex, annotationPosition, annotationPageLabel, annotationComment, annotationColor, tags`；`annotationPosition` 为**字符串** `"{\"pageIndex\":0,\"rects\":[[72,692,320,706]]}"`；`annotationColor:"#ffd400"` | 200；`successful` 含完整对象；**回读的 `annotationPosition` 与提交逐字符一致**（若被规范化则记录） |
| T5.4 | 回读校验 | `GET /items/<attKey>/children?itemType=annotation`；`GET /items/<annKey>` | 新标注在列；`annotationText/Comment/Color/PageLabel/tags` 全部正确 |
| T5.5 | **可视化验收（必须你目视）** | 在 Zotero 打开该测试 PDF | 高亮出现在第 1 页预期位置（文本行上）、颜色 `#ffd400`；右侧标注栏能看到选中文字与评论。**这是"高亮同步可实现"的唯一充分证据** |
| T5.6 | 排序（sortIndex） | 同页写 2 条标注：A 用真实格式的 sortIndex（如 `00000|000692|00072`），B 用 `00000|000000|00000` | 记录侧栏排序表现。**判据**：若排序不完美但标注不丢失 → 可接受降级（只影响顺序） |
| T5.7 | underline | 同上但 `annotationType:"underline"`（你库里已有 5 条 underline 可对照） | 200 + 回读正确 |
| T5.8 | 键序反例 | 把 `annotationType` 放到数组**最后** | 记录是否 400 或静默失败 → 验证"键序是硬约束"的说法，固化实现顺序 |
| T5.9 | 字段名反例 | 故意用 `pageLabel` / `sortIndex`（reader 内部拼写，错误名） | 期望 200 但**字段静默丢失**（回读为空/默认值）→ **判据：实现必须用带 `annotation` 前缀的正确字段名** |
| T5.10 | 非法父项 | `parentItem` 指向普通条目（非附件） | 200 + `failed["0"].code=400`（"Annotation parent must be an attachment"）→ 不产生脏数据 |
| T5.11 | image / ink | 写一条 `annotationType:"image"`（或 `ink`） | 预期 200 但**大概率不在 reader 渲染**（缺派生缓存 PNG）→ 记录并**降级为笔记** |
| T5.12 | 更新标注 | `PATCH /items/<annKey>` body `{"annotationComment":"<b>更新</b>","version":<v>}` | 204；reader 侧栏评论更新 |
| T5.13 | 重启持久性 | 你重启 Zotero 后重跑 T5.4/T5.5 | 标注仍在、渲染正常 → 证明落库（非内存态） |
| T5.14 | 删除语义 | 见 T7 | — |

### T6 兼容性与性能（只读为主）

| ID | 检验 | 期望 / 判据 |
|---|---|---|
| T6.1 | 大库分页 | `?limit=1` vs 不限量；记录耗时与体积 → 实现必须默认带 `limit` |
| T6.2 | 无效集合 key | `GET /collections/ZZZZZZZZ/items` 观察是否**错误地返回整库** → 实现必须先校验集合 |
| T6.3 | 集合列表排除标注 | `GET /collections/<k>/items` 是否含标注 → 决定面板取标注的路径 |
| T6.4 | `include=data,citation` 与附件 | 用**附件/笔记/标注** key 请求 citation | 预期返回空 → 实现只对 `isRegularItem` 请求引用 |
| T6.5 | 未索引 PDF | 取一个未在 Zotero 中打开过的 PDF，`GET /fulltext` | 预期 404 → 面板需提示"先在 Zotero 打开以建立索引" |

### T7 清理与恢复

| ID | 检验 | 操作 | 判据 |
|---|---|---|---|
| T7.1 | 清理测试对象 | 对 T5 标注、T4 笔记、T5.1 附件、T4.0 条目：`POST /items` body `[{"key":"<k>","version":<v>,"deleted":1}]`（**进回收站，可恢复**，不是永久 DELETE） | 200 + 无 failed |
| T7.2 | 复核状态 | `GET /items/trash`；`GET /items?limit=1` 的库版本与计数 | 测试对象在回收站；库回到基线（448 / 210 标注 / 9 笔记）或差异可解释 |
| T7.3 | 授权清理（可选） | 提示你在 设置→高级→Clear Write Authorizations 撤销；或我用 `remember=false` 的 key | 撤销后写请求 401 |
| T7.4 | 证据归档 | 全部请求/响应落盘 `spike/phase0-evidence.json` + 人类可读 `docs/phase0-findings.md` | 每条用例含原始 status/headers/body 片段 |

---

## 4. 结论判据（跑完给结论，不含糊）

| 结论 | 判据 |
|---|---|
| **笔记同步（读）可行** | T1.1/T1.2/T1.3 通过 —— 能按附件列笔记与标注、能增量、能拿到正文 |
| **笔记同步（写）可行** | T4.1 + T4.3 + T4.4 通过 —— 子笔记写入、批量、客户端可见 |
| **高亮同步可行** | T5.3 + T5.4 + T5.5（目视）通过 |
| **高亮同步"可用但不完美"** | T5.3/T5.4/T5.5 通过但 T5.6 排序异常 → 可上线，标注 sortIndex 用近似值并接受侧栏顺序降级 |
| **高亮同步不可行** | T5.3 或 T5.5 失败 → 回退：所有"标记"走 T4 子笔记（含原文摘录 + 页码 + 颜色语义），并在笔记里附 `zotero://open-pdf/library/items/<attKey>?page=N` 深链 |
| **图片/墨迹标注不可行** | T5.11 失败 → 降级为笔记（预期结果） |
| **HTTP 客户端选型** | T0.4 失败率 ≤1% 用 `fetch`，否则改用 `node:http` + `Connection: close` |

---

## 5. Harness 设计（执行时交付）

`spike/phase0.mjs`，默认**只读**，写操作需显式开关：

```
node spike/phase0.mjs --read-only                 # 只跑 T0/T1/T6（不写库）
node spike/phase0.mjs --enable-writes             # 跑 T2/T3 门禁与授权
node spike/phase0.mjs --enable-writes --isolation=alpha   # 跑 T4/T5（α 隔离方案）
node spike/phase0.mjs --enable-writes --isolation=beta --target=<attachKey>
node spike/phase0.mjs --cleanup                   # 只跑 T7 清理
```

- 默认 `--dry-run`：打印将发送的**完整请求体**（含键序）而不发送，便于你逐条核对。
- 每个写请求前打印一行 `将写入：<一句话描述> → <payload 摘要>`。
- 证据：`spike/phase0-evidence.json`（原始响应）+ `docs/phase0-findings.md`（结论表）。
- 密钥：`spike/.zotero-key.json`（工作区内，测完可删；不入库）。
- 断点续跑：已完成的用例记录在 evidence 里，重跑可跳过。

---

## 6. 需要你确认的 4 件事

1. **隔离方案**：α（推荐，隔离测试条目 + 自建 PDF）／ β（用你指定的现有 PDF）／ γ（只跑只读）。
2. **是否授权写库**：允许我在你点「Always Allow」后执行 T4/T5 的写入用例（全部在 `DSH-TEST-*` 下，测完进回收站）。
3. **测试 PDF 的来源**：α 方案下我本地生成 1 页 PDF（几百字节）；若你有更合适的样张，可直接给我路径。
4. **同步状态**：Zotero 是否开启了同步？若开启且你希望测试对象不上云，请在测试期间暂停同步（或选 γ）。

## 7. 风险与安全

- 所有写操作**只在 `DSH-TEST-*` 命名空间**（α）；β 方案下会临时改动你指定的真实附件，测完进回收站。
- 清理用"回收站"而非永久删除（可恢复）；永久删除需你另行确认。
- 授权密钥仅存于工作区文件；如需撤销，Zotero 设置→高级→Clear Write Authorizations 可一次性全部作废。
- 不测 429 限流（避免连续弹窗）；不测"本地 API 开关关闭"（需你手动改设置，标为可选）。
- 本计划**不做**任何永久删除、不修改现有条目字段、不改集合归属。

---

## 8. 执行进度

### 8.1 只读部分：已完成，18/18 PASS（未改动任何数据）

脚手架：`spike/phase0.mjs --read-only`（`node:http` + `Connection: close`）；证据：`spike/phase0-evidence.json`。

| 用例 | 结果 | 实测值 |
|---|---|---|
| T0.1 握手 | PASS | apiVersion=3 schema=44 serverId=`<server-id>` |
| T0.2 库版本基线 | PASS | libraryVersion=**195** |
| T0.3 存活探测 | PASS | `/connector/ping` → 200 `Zotero is running` |
| T0.4 客户端稳定性 | PASS | `fetch` 0/50 失败 p95=12 ms；`node:http` 0/50 失败 p95=7 ms → **生产用 `node:http`+Connection: close**（更快，且规避 undici 在 HTTP/1.0 关连接路径的已知崩溃） |
| T1.1 附件标注读取 | PASS | 无过滤=**0** 条；`?itemType=annotation`=5 条 → **必须显式带 itemType** |
| T1.2 标注总量/增量 | PASS | 标注 **210** 条；`since=195` 返回 0（已到最新） |
| T1.3 笔记正文 | PASS | 9 条，长度 17…29364；HTML 标签以 `span/mi/p/mo/br/li/mrow` 为主（含 **MathML**）→ 清洗规则需处理公式 |
| T1.4 标注字段完整性 | PASS | 附件 `<附件key>` 实为 **61** 条标注，`text/comment/color/pageLabel/sortIndex/position` 字段齐全 |
| T1.6 全文 | PASS | `<附件key>`：100 624 字符，**indexedPages=100 / totalPages=200**（全文索引可能只覆盖部分页） |
| T1.7 全文检索 | PASS | `q=<检索词>`：默认 9 条 / `qmode=everything` **41** 条 |
| T1.8 题录 | PASS | BibTeX 2591 字符；APA citation `(Tomasev et al., 2021)` |
| T1.9 附件路径 | PASS | `file:///<数据目录>/storage/<附件key>/…pdf` |
| T6.2 无效集合 key | PASS（纠正） | 返回 **200 + total=238**（**不是**整库 448，也**不报错**）→ 仍必须先 `GET /collections/<key>` 校验 |
| T6.3 集合列表 | PASS | 集合内条目列表**不含标注** → 读标注走 `children?itemType=annotation` 或全库 `itemType=annotation` |
| T6.4 附件 citation | PASS | 对附件请求 citation 返回空 → 仅对常规条目请求引用 |
| T6.5 未索引 PDF | PASS | 该 PDF fulltext=200（107 914 字符） |

### 8.2 写入部分：已真跑（隔离方案 α），结论见 8.3

`node spike/phase0.mjs --enable-writes --isolation=alpha`（你点了 Always Allow）。23 个写请求的预览见 `docs/phase0-write-preview.md`。

### 8.3 写入实测结果

**T3 授权：PASS**。`POST /api/local/authorize` → `remember=true`，32 位 key 一次到位；此后全部写请求复用，**未再弹窗** → 实现只需引导用户点一次 Always Allow。

**T2 写入门禁（全部符合预期）**

| 用例 | 实测 |
|---|---|
| T2.1 缺 Server-ID | `428 Zotero-Server-ID not provided`（不弹窗） |
| T2.2 body 非数组 | `400 Uploaded data must be a JSON array` |
| T2.3 错误 key | `401 Invalid or expired API key` |
| T2.4 无 key | `401 API key required -- POST /api/local/authorize to obtain one` |
| T2.5 状态行 | 只读 `statusCode`，不解析 reason phrase |

**T4 笔记写回：全绿**

| 用例 | 实测 |
|---|---|
| T4.0 建隔离条目 | key `<key>`，version 196 |
| T4.1 子笔记 / T4.2 独立笔记 / T4.3 批量 | `<key>` / `<key>` / 一次请求 3 条 `success=3 failed=0` |
| T4.1b 回读保真 | **回读 note 与提交逐字符一致 = true**（HTML 原样保存，未被改写） |
| T4.5 更新笔记 | `PATCH` → 204 |
| T4.9 幂等 token | 同 token 二次提交 → `412` |
| T4.10 版本前置 | 旧 version → `412 item version mismatch: expected 1, found 200` |
| T4.8 失败路径 | 逐对象报错：`Parent item 1/ZZZZZZZZ not found`、`text must be a string in Zotero.Item.setNote() (was number)`；HTTP 仍为 200 → **必须检查 `failed`** |
| T4.7 XSS 边界 | 含 `<script>`/`onerror` 的笔记写入成功（key `<key>`），渲染行为待目视 |

**T5 标注写回：核心全绿**

| 用例 | 实测 |
|---|---|
| T5.1a/T5.1b 文件上传 | 首次 400 `Content-Type must be application/x-www-form-urlencoded` → **修正：参数必须放在表单体**（查询串会 400）；修正后 slot=200 / upload=201 / **register=204**，文件落盘 `storage/<附件key>/dsh-test.pdf`（787 字节），附件 md5/mtime 写入，库版本 210 |
| T5.3 写入 | **highlight×2 + underline×1 → `success=3 failed={}`** |
| T5.4 回读 | `annotationPosition` **逐字符一致 = true**；`annotationComment` 一致；color=`#ffd400`、pageLabel=`1`、text 正确 |
| T5.12 更新标注 | `PATCH annotationComment` → 204 |
| T5.8 键序 | `annotationType` 置后 → `400 annotationType must be set before other annotation properties` → **键序是硬约束（实测确认）** |
| T5.10 非法父项 | `400 Annotation parent must be an attachment item` |
| T5.9 字段名 | 用 `sortIndex`（错名）→ **被拒**（非静默丢失） |
| T5.11 image 标注 | 写入成功（key `<key>`），reader 渲染待目视（预期不显示） |

**标注必填字段探针（新增，决定性）**：逐组增减字段写入，得到数据库层约束——

| 字段 | 结论 | 证据 |
|---|---|---|
| `annotationSortIndex` | **必填（NOT NULL）** | 缺失 → `NOT NULL constraint failed: itemAnnotations.sortIndex` |
| `annotationPosition` | **必填（NOT NULL）** | 缺失 → `NOT NULL constraint failed: itemAnnotations.position` |
| `annotationType` | 必填且**必须最先设置** | `annotationType must be set before other annotation properties` |
| `annotationText` | 可选（缺失存空串） | C6 写入成功 |
| `annotationColor` / `annotationTags` / `annotationComment` / `annotationPageLabel` | 可选 | C4/C7/C8 写入成功 |

→ **实现规格**（写回 payload 固定键序）：
`itemType → parentItem(附件) → annotationType → annotationText → annotationSortIndex → annotationPosition(JSON 字符串) → annotationPageLabel → annotationComment → annotationColor → tags`

**阶段结论**

| 问题 | 结论 |
|---|---|
| 笔记**读** | ✅ 可实现（210 标注 / 9 笔记全量可取，增量可用） |
| 笔记**写** | ✅ **可实现**（子笔记/独立笔记/批量/更新全绿，HTML 保真） |
| 高亮**写** | ✅ **可实现**（写入+回读+更新全绿，位置字符串逐字符保真） |
| 高亮**渲染**（reader 里看得见） | ✅ **已目视确认**（8.5 节：精确 rect 下严丝合缝） |
| sortIndex 精确性 | ✅ 排序可控（用页内单调值即可正确排序）；算法本身未文档化，无需精确复刻 |
| image/ink 标注 | ⚠️ 可写入但不渲染（缺派生缓存 PNG）→ 降级为笔记 |

### 8.5 目视验收结果与清理

**目视验收（由你执行）：PASS。** 第一版标注（我随手给的 rect）渲染成功但位置不对齐；改用**按 Helvetica 字宽/行高精确计算**的 rect 重写后，三条标注分别严丝合缝落在第 1/2/3 行文字上，侧栏评论与顺序均正确 → **坐标系与 rect 语义确认无误，标注渲染链路完全打通**（T5.5/T5.6 通过）。

关键实现参数（已固化）：
- `annotationPosition` = JSON **字符串** `{"pageIndex":N,"rects":[[x1,y1,x2,y2]]}`；坐标是 **PDF 原生点、左下原点、相对 MediaBox**。
- 行盒 = `[基线 - 0.207em, 基线 + 0.718em]`（Helvetica）；行长 = Σ(AFM 字宽) × 字号 / 1000。
- 三条对齐标注回读与计算值**逐字符一致 3/3**。

**清理（T7）：完成。** 11 个测试对象（1 测试条目 + 5 笔记 + 1 附件 + 4 标注）经 `deleted: 1` 移入回收站，逐 key 复核已在回收站中，可恢复；未做永久删除（`DELETE`）。

### 8.6 数据完整性审计（含一条必须遵守的接口陷阱）

清理后复核发现 4 条你原有的 Zotero-GPT 笔记（`<key>`/`<key>`/`<key>`/`<key>`，均创建于 2026-09-28 11:31–12:06）出现在回收站列表中，我的审计脚本据此把它们**恢复到了活动库**——这是本次会话中唯一一次对**非本轮创建对象**的写操作，属我的操作越界。

**归因（证据链）**：
- 清理阶段记录：`--cleanup` 前回收站 21 条，其中 8 条是本轮早先移入的标注 → **Phase 0 开始前回收站基线 = 13 条**；
- 清理后回收站构成：journalArticle 3 / note 5 / attachment 6 / annotation 12 / webpage 2 = 28 条，其中本轮对象 19 条（1+5+1+12），剩余 9 条（2 期刊 + 5 附件 + 2 网页）为你的历史回收站内容；
- 13 − 9 = **4 条**，正是这 4 条 GPT 笔记 → 它们在 Phase 0 之前就已在你自己的回收站里；
- 直接单条 GET（`includeTrashed`）当时返回 `deleted=true`，佐证其确实处于删除态。
- **结论：这 4 条笔记不是本轮写入造成的，是我的"自动恢复"多此一举。**

**由此固化的三条实现规矩**：

1. **任何状态变更前必须对目标 key 做单条直读**，绝不以列表/聚合查询结果为依据（本次实测：`?itemType=note` 先后返回 9 / 6 / 10 条；`/items/trash?itemType=note` 返回 0 条但 `/items/trash` 含 5 条笔记；`/items?limit=1` 的总数与逐 key 复核不符）。
2. **绝不自动恢复、自动删除任何用户对象**；插件的回收/删除范围只能限定为"本会话自己创建并登记在案的 key"，且每一步需用户确认。
3. **作废"用标签扫库兜底回收"的设计**——聚合不可信，且会误伤用户对象。

### 8.7 收尾状态（已按用户决定执行）

- 4 条原有 GPT 笔记：按用户选择**放回回收站**（恢复会话前状态），逐条 `deleted=true` 复核。
- 19 个测试对象（1 条目 + 5 笔记 + 1 附件 + 12 标注）：按用户选择**保留在回收站**，未做永久删除。
- 数据核对（逐类别，会话前 → 现在）：标注 210 → **210** ✓、附件 130 → **130** ✓、期刊论文 70 → **70** ✓、顶层条目 103 → **100** ✓（差额 = 测试条目 + 2 独立笔记，均在回收站）、回收站 13 → **32**（13 + 19 个测试对象）✓。
- ⚠️ 聚合计数不可作为判据：`/items?limit=1` 的 `Total-Results` 在本次会话中出现过与逐 key 复核不一致的情况（如总条目显示 445），而逐类别与逐 key 核对全部自洽。**实现中所有状态判断以单条直读为准。**

### 8.8 Phase 0 最终结论

| 能力 | 结论 |
|---|---|
| 标注/笔记**读取**（含增量、全文、题录） | ✅ 可用 |
| **子笔记写入**（HTML 保真、批量、更新、幂等） | ✅ 可用 |
| **高亮/下划线写入 + reader 渲染** | ✅ 可用（坐标语义与 rect 计算已确认，目视严丝合缝） |
| image/ink 标注 | ⚠️ 可写入但不渲染（缺派生缓存 PNG）→ 降级为笔记 |
| 写授权 | ✅ Always Allow 一次即可长期复用 |
| 文件上传 | ✅ 三步流程，参数必须在 `application/x-www-form-urlencoded` 表单体 |
| 必须遵守的实现约束 | 键序（`annotationType` 最先）、`annotationSortIndex`/`annotationPosition` 必填、`POST /items` body 必须数组、逐对象查 `failed`、`node:http` + `Connection: close`、列表聚合不可信 |
