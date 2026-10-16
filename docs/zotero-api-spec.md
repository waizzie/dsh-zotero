# Zotero × DSH 插件接口规范 v1

> 依据：**Phase 0 在本机 Zotero 10.0.5 上的实测**（只读 18 项 + 写入 27 项，证据 `spike/phase0-evidence.json`），辅以官方文档与官方源码。
> 证据等级标注：**【实测】**= 本机真实请求验证 · **【文档】**= Zotero 官方文档 · **【源码】**= zotero/zotero 源码 · **【未测】**= 来自文档/第三方实现但本机未验证。
> 本文件是 Phase 1–4 的实现契约；与 `docs/zotero-plugin-plan.md`（总计划）、`docs/phase0-test-plan.md`（检验记录）配套。

---

## 1. 运行时事实

| 项 | 值 | 等级 |
|---|---|---|
| Zotero 版本 | 10.0.5（BuildID 20260930221031） | 【实测】 |
| 本地 API 基址 | `http://127.0.0.1:23119`，API 路径前缀 `/api/` | 【实测】 |
| 协议版本 | `Zotero-API-Version: 3`（唯一版本） | 【实测】 |
| Schema 版本 | `Zotero-Schema-Version: 44` | 【实测】 |
| 实例标识 | `Zotero-Server-ID: <server-id>`（**随库走，换库即变**） | 【实测】 |
| 用户库 | `userID = <userID>`（"我的文库"）；`/api/users/0/...` 指向本机登录用户 | 【实测】 |
| 传输层 | 响应为 **HTTP/1.0**；有 body 时不发 `Content-Length`（靠关连接定界）；reason phrase 可能是字面 `undefined` | 【实测】+【源码】 |
| 客户端选型 | Node `node:http` + `agent:false` + `Connection: close`（实测 p95 7 ms，0 失败；规避 undici 在 HTTP/1.0 关连接路径的崩溃报告） | 【实测】 |
| 浏览器直连 | **不可行**：仅 bookmarklet 来源有 CORS 头，浏览器特征请求被直接断连 → 必须由 Host 半中转 | 【源码】 |
| 本地 API 开关 | 设置→高级→"允许其他应用程序与 Zotero 通信"；关闭时 `/api/*` 返回 403 `Local API is not enabled` | 【文档】 |
| 存活探测（无需开关） | `GET /connector/ping` → 200 `Zotero is running` | 【实测】 |
| shell 环境限制 | PowerShell 的 `Invoke-WebRequest` 连不上（HTTP/1.0 握手），`curl.exe` 与 Node `fetch`/`node:http` 可用 | 【实测】 |

---

## 2. 握手

```
GET /api/
→ 200 text/plain "Nothing to see here."
  Zotero-API-Version: 3
  Zotero-Schema-Version: 44
  Zotero-Server-ID: <serverID>
  X-Zotero-Version: 10.0.5
```
库版本（写前置条件用）：`GET /api/users/0/items?limit=1` → 响应头 `Last-Modified-Version`。【实测】

**缓存分区规则**：所有缓存（条目、版本、`since` 游标、Server-ID）必须按 `Zotero-Server-ID` 分区；Server-ID 变化即全部作废。【文档】

---

## 3. 读接口

### 3.1 条目检索 `GET /api/users/0/items`

| 参数 | 取值 | 说明 |
|---|---|---|
| `q` | 短语 | 与 `qmode` 组合 |
| `qmode` | `titleCreatorYear`(默认) / `everything` | **`everything` 才含全文**（实测某个检索词：默认 9 条 vs everything 41 条） |
| `itemType` | `note` / `annotation` / `attachment` / `journalArticle` / `-attachment`（支持 `||` 布尔） | |
| `itemKey` | 逗号分隔 ≤50 | 精确取指定对象 |
| `since` | 整数库版本 | 增量：只返回 version > since 的对象（实测 `since=190` → 3 条） |
| `limit` / `start` | 整数 | **本地默认不限量**，实现必须显式带 `limit` |
| `format` | `json` / `keys` / `versions` / `bib` / 导出格式 | `versions` 返回 `{key: version}`，用于增量 |
| `include` | `data` / `bib` / `citation` / 导出格式 | **不含 `data` 时 `data` 字段被删除** |
| `sort` / `direction` | 白名单 18 字段 / `asc`\|`desc` | 非白名单 → 400 |
| 总数 | 响应头 `Total-Results` | ⚠️ **不可信**（见 §6） |

**实测样例**
```
GET /api/users/0/items?itemType=annotation&format=versions      → 210 条 {key: version}
GET /api/users/0/items?q=<检索词>&qmode=everything&limit=1       → Total-Results: 41
GET /api/users/0/items?since=190&format=json                    → 3 条（version 192/193/195）
```

### 3.2 条目详情 `GET /api/users/0/items/<itemKey>?format=json`

返回 `{key, version, library, links, meta, data}`；`data` 是可编辑 JSON（写回时原样改再发）。【实测】

### 3.3 子项与标注 ⚠️ 关键陷阱

```
GET /api/users/0/items/<附件key>/children                     → 实测返回 0 条 ❌
GET /api/users/0/items/<附件key>/children?itemType=annotation  → 实测返回该附件全部标注 ✅
GET /api/users/0/items/<顶层key>/children?itemType=note        → 返回子笔记 ✅
GET /api/users/0/items/<顶层key>/children?itemType=attachment  → 返回附件 ✅
```
**【实测】`/children` 默认不返回标注/笔记，必须显式带 `itemType`。**
集合内的条目列表**不含标注**（源码显式 `itemType isNot annotation`）→ 读标注只有两条路：`children?itemType=annotation` 或全库 `itemType=annotation`。【实测】+【源码】

**标注对象形状（实测，写回模板的权威来源）**
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
    "tags": [{"tag": "<标签>"}], "relations": {},
    "dateAdded": "…", "dateModified": "…"
  }
}
```
字段全集（实测并集）：`annotationAuthorName, annotationColor, annotationComment, annotationPageLabel, annotationPosition, annotationSortIndex, annotationText, annotationType, dateAdded, dateModified, itemType, key, parentItem, relations, tags, version`。

**笔记对象形状**：`itemType: "note"`，`note` 为 HTML 字符串，`parentItem` 缺省即顶层独立笔记；实测库内含 MathML（`<math>/<mi>/<mo>/<mrow>`）与 `<span>/<p>/<br>/<li>` 等。

### 3.4 全文 `GET /api/users/0/items/<附件key>/fulltext`

```json
{ "content": "…", "indexedPages": 100, "totalPages": 200 }
```
- 非 JSON 文本类用 `indexedChars` / `totalChars`（null 字段被丢弃）。【文档】
- **可能只覆盖部分页**（实测某 PDF `indexedPages=100 / totalPages=200`）。【实测】
- 未索引/无缓存 → 404；未在 Zotero 打开过的 PDF 可能未索引。【文档】+【实测】

### 3.5 附件本地路径

```
GET /api/users/0/items/<附件key>/file/view/url → 200 text/plain "file:///C:/Users/…/storage/<key>/<文件名>"
GET /api/users/0/items/<附件key>/file/view     → 302 Location: file://…
```
附件 JSON **不含路径字段**（只有 `filename`/`contentType`/`linkMode`）；要绝对路径就取上面这个 URL。【实测】+【文档】
兜底拼接：`<数据目录>/storage/<附件key>/<filename>`（对 `linked_file` 无效）。【文档】

### 3.6 题录与引用

| 请求 | 返回 |
|---|---|
| `GET /items/<key>?format=bibtex` | BibTeX 文本（实测 2591 字符，含 `file` 字段本地路径） |
| `?format=biblatex` / 其它导出格式 | 对应文本 |
| `?format=csljson` | CSL-JSON 数组（最完整，适合自行 citeproc） |
| `?include=data,citation&style=apa` | 对象内多一个 `citation` 字段（实测 `"(Tomasev et al., 2021)"`） |
| `?format=bib&style=apa&locale=zh-CN` | 整篇参考文献表 HTML |

⚠️ **必须显式传 `style`**：本地默认是 `chicago-shortened-notes-bibliography`，与 Web API 文档不同。【源码】
⚠️ **附件/笔记/标注不参与引用**：`citeprocToHTML` 先过滤 `isRegularItem`；对附件请求 citation 实测返回空串。【实测】+【源码】

### 3.7 集合 / 标签 / 保存的搜索

```
GET /api/users/0/collections?limit=N&format=json
GET /api/users/0/collections/<key>/items            # ⚠️ 不含标注；无效 key 实测返回 200 + 无意义计数(238)
GET /api/users/0/tags?limit=N                        # 实测 305 个
GET /api/users/0/searches/<searchKey>/items          # 本地 API 独有：真正执行保存的搜索
```
⚠️ **无效 collectionKey 不报错**（实测 200 且计数错误）→ 使用前必须 `GET /collections/<key>` 校验。【实测】

### 3.8 增量同步

```
GET /api/users/0/items?since=<version>&format=json     # 全类型增量
GET /api/users/0/items?itemType=annotation&format=versions  # 标注 key→version
```
入库步骤：取库版本 → 拉增量 → 逐 key 直读变更对象 → 更新缓存。**【实测】不可依赖 `Total-Results` 判断完整性。**

---

## 4. 写接口

### 4.1 授权：`POST /api/local/authorize`

```http
POST /api/local/authorize
Content-Type: application/json          ← 必须
Zotero-Server-ID: <serverID>            ← 必须（缺失 428）

{"appName":"DSH Zotero"}
→ 200 {"key":"<32字符>","remember":true}
```
- 用户弹窗可选 Allow / **Always Allow** / Deny。`remember=true`（Always Allow）→ key 可长期复用；`remember=false` → **每个写请求消耗一个 key**（消耗发生在鉴权阶段，**即使写失败也消耗**），即每次写入都要弹窗。【文档】+【源码】
- Deny → `403 {"denied":true}`；弹窗类请求限 5 次/分钟 → `429` + `Retry-After`。【文档】
- key 明文存 `<profile>/localAPIKeys.json`，不绑定库、不限作用域；用户可在设置里一次性撤销。【源码】
- **实现要求**：首次引导用户点 Always Allow，key 存 `ctx.credentials.modifyRecord('zotero-local-api-key', …)`；遇到 401 自动重新授权一次；遇到 429 退避并提示。

**实测**：`remember=true` 后 20+ 次写请求零弹窗。

### 4.2 通用请求规则

| 规则 | 说明 | 等级 |
|---|---|---|
| body 必须是 **JSON 数组** | 即使只写 1 个对象；非数组 → `400 Uploaded data must be a JSON array` | 【实测】 |
| 必须带 `Zotero-Server-ID` | 缺失 → `428`；不匹配 → `412` | 【实测】428、【文档】412 |
| 必须带 `Zotero-API-Key` | 缺失/错误 → `401`（`API key required …` / `Invalid or expired API key`） | 【实测】 |
| `Content-Length` | 必须（server.js 检查） | 【源码】 |
| 单请求对象数 | ≤50 | 【文档】 |
| `Zotero-Write-Token` | 5–32 字符；同 token 二次提交 → `412`（实测）；带版本前置时可省略 | 【实测】+【文档】 |
| 版本前置 | 更新已有对象需 `version` 或 `If-Unmodified-Since-Version`，否则 `428`；过旧 → `412` | 【实测】412 |
| `POST /items` 语义 | **PATCH 语义**（未给字段不动） | 【源码】 |
| 逐对象结果 | HTTP 仍 200，成败看 body 的 `failed` | 【实测】 |

### 4.3 创建笔记

```json
[{
  "itemType": "note",
  "parentItem": "<父条目或附件key>",     // 省略 = 顶层独立笔记
  "note": "<h2>标题</h2><p>正文</p><ul><li>要点</li></ul>",
  "tags": [{ "tag": "dsh" }]
}]
```
- `note` 是 **HTML**（Markdown 会以字面文本显示，实测确认）→ 写入前必须把 Markdown 转 HTML 并做白名单清洗（只允许 `p/br/strong/em/ul/ol/li/h1-h3/blockquote/code/pre/a/img` 等）。【实测】
- **实测保真**：写入的 HTML 回读与提交**逐字符一致**。
- 批量：一次请求写多条（实测 3 条 `success=3`）。
- 失败路径也是 200 + `failed`，实测消息：
  - 父项不存在 → `Parent item 1/ZZZZZZZZ not found`
  - `note` 非字符串 → `text must be a string in Zotero.Item.setNote() (was number)`

### 4.4 创建标注（键序敏感）

**固定键序（实测必需）**：
```json
[{
  "itemType": "annotation",
  "parentItem": "<附件key>",
  "annotationType": "highlight",          // 必须在其它 annotation* 字段之前，否则 400
  "annotationText": "被选中的文字",
  "annotationSortIndex": "00000|000692|00072",
  "annotationPosition": "{\"pageIndex\":0,\"rects\":[[72,697.52,320.02,708.62]]}",
  "annotationPageLabel": "1",
  "annotationComment": "<b>评论</b>",
  "annotationColor": "#ffd400",
  "tags": [{ "tag": "dsh" }]
}]
```
**字段约束（实测，数据库层）**

| 字段 | 必填 | 说明 |
|---|---|---|
| `itemType: "annotation"` | ✅ | |
| `parentItem` | ✅ | 必须是**文件附件**且有 reader type（PDF / EPUB / HTML 快照）；普通条目 → `400 Annotation parent must be an attachment item`；`linked_url` 被拒 |
| `annotationType` | ✅ | `highlight` / `underline` / `note` / `text` / `image` / `ink`；**必须最先设置** → 否则 `400 annotationType must be set before other annotation properties` |
| `annotationSortIndex` | ✅ | **NOT NULL**（缺失 → `NOT NULL constraint failed: itemAnnotations.sortIndex`） |
| `annotationPosition` | ✅ | **NOT NULL**，且必须是 **JSON 字符串** |
| `annotationText` | ⭕ | 缺失存空串 |
| `annotationComment` / `annotationColor` / `annotationPageLabel` / `tags` | ⭕ | 可选 |

- `annotationSortIndex` 格式 `PPPPP|YYYYYY|XXXXX`（页序号｜纵｜横，零填充）。**算法未文档化且与 rect 不成正比**（实测值由 reader 视口几何决定）。**对策**：用页内单调值即可保证侧栏顺序（如 `页号|(页高-基线上沿)×10|左边界×10`），不追求与 Zotero 完全一致。【实测】
- **渲染实测**：精确 rect 下 highlight 与 underline 在 Zotero reader 中严丝合缝；**image/ink 可写入但不渲染**（缺派生缓存 PNG）→ 实现中降级为笔记。【实测】

### 4.5 更新

```http
PATCH /api/users/0/items/<key>
{"annotationComment":"<b>新评论</b>","version":<当前version>}   → 204
```
- 必须带 `version` 或 `If-Unmodified-Since-Version`；实测旧版本 → `412 item version mismatch: expected 1, found 200`。
- 更新流程：单条直读拿 `version` → PATCH → 412 则重读重试一次。
- 不要用 `PUT`（未提供的字段会被清空）。【文档】

### 4.6 回收站 / 恢复 / 永久删除

```http
POST /api/users/0/items   [{"key":"<k>","version":<v>,"deleted":1}]   → 移入回收站（可恢复）【实测】
POST /api/users/0/items   [{"key":"<k>","version":<v>,"deleted":0}]   → 从回收站恢复【实测】
DELETE /api/users/0/items/<key>   If-Unmodified-Since-Version: <v>    → 永久删除【文档，未测】
GET /api/users/0/items/trash?limit=N
```
**实现规矩（因 Phase 0 事故而定）**：
1. 变更前**必须单条直读**目标对象，绝不以列表/聚合结果为依据；
2. **绝不自动恢复、自动删除用户对象**；
3. 回收范围**只限本会话创建并登记在案的 key**，且需用户显式确认；**禁止用标签/条件扫库兜底删除**。

### 4.7 附件文件上传（三步，**参数必须放表单体**）

```http
# ① 申请上传槽
POST /api/users/0/items/<附件key>/file
Content-Type: application/x-www-form-urlencoded      ← 必须；用查询串会 400
Zotero-API-Key: <key>    Zotero-Server-ID: <sid>     If-None-Match: *

md5=<32hex>&filename=dsh-test.pdf&filesize=787&mtime=<epoch_ms>
→ 200 {"url":"http://127.0.0.1:23119/api/local/uploads/<uploadKey>","uploadKey":"…","contentType":"application/pdf","prefix":"","suffix":""}
   （文件已在服务器 → {"exists":1}，可跳过 ②③）

# ② 上传字节（不需要 key 与 Server-ID，uploadKey 本身授权）
POST <url>
Content-Type: application/pdf
<二进制>                                              → 201

# ③ 注册
POST /api/users/0/items/<附件key>/file
Content-Type: application/x-www-form-urlencoded
Zotero-API-Key: <key>    Zotero-Server-ID: <sid>     If-None-Match: *

upload=<uploadKey>                                   → 204  Last-Modified-Version: 210
```
- 仅支持 `imported_file` / `imported_url`；单文件 <4 GB；uploadKey 1 小时过期；字节 MD5 必须一致。【文档】
- 附件条目需先创建：`{"itemType":"attachment","parentItem":"…","linkMode":"imported_file","contentType":"application/pdf","charset":"","filename":"x.pdf","title":"…"}`。【实测】

### 4.8 多对象响应与判定

```json
{
  "successful": { "0": { …完整对象… } },
  "success":    { "0": "<新key>" },
  "unchanged":  { "1": "<key>" },
  "failed":     { "2": { "key": "", "code": 400, "message": "…" } }
}
```
**HTTP 200 不代表成功**；实现必须遍历 `failed`，并把 `message` 原样回给用户。【实测】

### 4.9 错误码速查

| 码 | 触发 | 实测消息 |
|---|---|---|
| 200 | 多对象写（逐对象判定） | — |
| 201 | 上传字节成功 | — |
| 204 | 单对象 PATCH/DELETE、文件注册 | — |
| 400 | 非数组 body / 无效 itemType / 父项非法 / 键序错 / 必填缺失 / Content-Type 不符 | `Uploaded data must be a JSON array`、`Annotation parent must be an attachment item`、`annotationType must be set before other annotation properties`、`Content-Type must be application/x-www-form-urlencoded` |
| 401 | 缺/错 key | `API key required -- POST /api/local/authorize to obtain one`、`Invalid or expired API key` |
| 403 | 本地 API 未开 / 库不可写 / 授权被拒 | `Local API is not enabled`、`{"denied":true}` |
| 404 | 对象不存在 / 无全文 | |
| 412 | 版本过旧 / Server-ID 不匹配 / token 已用 | `item version mismatch: expected 1, found 200` |
| 428 | 缺 `Zotero-Server-ID` / 缺版本前置 | `Zotero-Server-ID not provided` |
| 429 | authorize 弹窗限流 | + `Retry-After` |

⚠️ 不要解析 reason phrase（可能是字面 `undefined`）。【源码】

---

## 5. 标注坐标计算（实测验证）

- `annotationPosition` = `JSON.stringify({pageIndex, rects})`，`pageIndex` 0 基。
- `rects` 每项 `[x1,y1,x2,y2]`，单位 **PDF 原生点（1/72 inch）**，**原点在页面左下角**，相对 MediaBox。
- 行盒公式（Helvetica 系）：`y1 = 基线 - 0.207 × 字号`，`y2 = 基线 + 0.718 × 字号`。
- 行长 = `Σ(AFM 字宽) × 字号 / 1000`；实测按此计算的 rect 与 Zotero 回读值**逐字符一致**，并在 reader 中精确对齐。

**⚠️ 待解决的设计缺口（Phase 2/3 必选其一）**：Host 半如何为"用户在 DSH 侧选中的一段文字"取得 rect？
1. **复用既有标注位置**（最稳，零依赖）：用户引用的是 Zotero 里已有的高亮 → 直接取其 `annotationPosition`；
2. **按页锚定**（次稳，零依赖）：只给 `pageIndex` + 页顶默认 rect + `annotationPageLabel`，位置不精确但可用；
3. **精确检索**（需要 PDF 文本层）：在 Host 半解析 PDF 定位字符串坐标——需引入 PDF 库（如 `pdfjs-dist`）或自研最小提取器；`pdfjs-dist` 属 host 侧依赖，不影响 client bundle 纯度门；
4. 组合策略：默认 1+2，配置开启 3。

---

## 6. 已知陷阱清单（必须写进实现）

| # | 陷阱 | 证据 |
|---|---|---|
| 1 | **列表/聚合结果不可信**：同会话内 `?itemType=note` 返回过 9 / 6 / 10 条；`/items/trash?itemType=note` 返回 0 条而 `/items/trash` 含 5 条笔记；`?limit=1` 的 `Total-Results` 与逐 key 核对不符 | 【实测】 |
| 2 | `/children` 默认不返回标注/笔记，必须带 `itemType` | 【实测】 |
| 3 | 集合条目列表排除标注 | 【实测】+【源码】 |
| 4 | 无效 collectionKey 返回 200 且计数无意义 | 【实测】 |
| 5 | `/items/new?itemType=X` 本地 **404**（无模板端点），payload 必须自建 | 【实测】 |
| 6 | `annotationType` 必须最先设置 | 【实测】 |
| 7 | `annotationSortIndex` / `annotationPosition` NOT NULL | 【实测】 |
| 8 | 文件上传参数必须在表单体 | 【实测】 |
| 9 | 附件/笔记/标注不参与题录引用 | 【实测】 |
| 10 | 全文索引可能只覆盖部分页 | 【实测】 |
| 11 | `Zotero-Server-ID` 随库变化，缓存必须分区 | 【文档】 |
| 12 | 本地版本号与云端版本号无关，且与其它实例无关 | 【文档】 |
| 13 | 不要转发 23119 端口；本地读无鉴权 | 【文档】 |
| 14 | `remember=false` 时每个写请求都弹窗（含失败的写） | 【源码】 |
| 15 | HTTP/1.0、无 `Content-Length` 的 body 响应 → 用 `Connection: close` | 【实测】+【源码】 |
| 16 | Zotero 未运行时连接被拒（无降级响应）→ 需探测并提示 | 【实测】 |
| 17 | **`?itemKey=a,b,c` 多值不是"精确批量取"**：传父条目 key 实测返回的是它们的**子对象**（笔记/附件/标注），导致父条目解析失败。批量取条目只能逐条直读 `GET /items/<key>`（本项目按并发 8 限流） | 【实测】 |
| 18 | **集合成员包含父条目的子附件/笔记**：实测「某分类」 77 个成员 = 23 期刊 + 45 附件 + 6 笔记 + 2 预印本 + 1 学位论文。直接展示会出现大量 `PDF` / `Full Text PDF` 行 → 列表必须按"是否挂在父条目下"过滤（保留独立附件） | 【实测】 |
| 19 | **`qmode=everything` 的命中主要落在附件上**（全文匹配）：实测检索 30 条命中里 13 条是附件 → 必须把附件命中**归并到父条目**并按父条目去重，同时记录命中的附件，否则界面/模型看到的都是无题名的 PDF | 【实测】 |
| 20 | **`annotationPosition.rects` 是"页面渲染定位"的权威来源**：`[x1,y1,x2,y2]`、PDF 用户空间、**左下原点**、相对 MediaBox。一条标注可能有多段 rect（多行高亮），需逐段绘制 | 【实测】 |
| 21 | ⚠️ **pdf.js 6.x 没有 `viewport.convertToViewportRectangle()`**（只在老版本存在）。实测 6.3.289 的 `PageViewport` 只有 `convertToViewportPoint(x,y)` 与 `transform` 矩阵。写 `viewport.convertToViewportRectangle(rect)` 会直接抛 `is not a function`，而它只在"该页真有标注"时才会被调用 → 症状极具迷惑性（**只有带标注的那页报错，前面几页好端端的**） | 【实测】 |

### 6.x 面板渲染补充（本轮实现）

- **原生阅读器无法叠加**：浏览器内置 PDF 阅读器是独立文档，既不能在其上绘制，也拿不到页面几何 → 要渲染标注必须**自己用 pdf.js 渲染画布**。
- **pdf.js 供给**：本插件把 `pdfjs-dist@6.3.289`（与 DSH 自带版本一致）作为自身依赖，经 `GET /dsh-zotero/vendor/**` 白名单供给客户端；中文 PDF 必须同时提供 `cmaps/`（`cMapUrl` + `cMapPacked: true`）与 `standard_fonts/`，否则未内嵌字体的文字会缺字。
- **坐标换算（正确做法）**：用 `viewport.transform`（`[a,b,c,d,e,f]` 2×3 仿射矩阵，已含 viewBox 偏移、缩放、`/Rotate`、userUnit）自己映射：
  `X = a·x + c·y + e`，`Y = b·x + d·y + f`；对 rect 取四角求包围盒。**实测与 pdf.js 自带 `convertToViewportPoint` 的结果偏差为 0**（见 `spike/verify-pdf-overlay.mjs`）。
- **PDF 自带标注 vs Zotero 创建**：`annotationIsExternal === true` 表示标注来自 PDF 文件本身（例如先在 Acrobat 里标好再导入），pdf.js 渲染画布时会**自己把它画出来**；这类不要再用覆盖层画一遍（否则颜色叠深）。只有 `external = false`（Zotero 内创建、仅存数据库）才需要叠加。
- **实现陷阱 1**：Windows 下用 `path.normalize()` 处理 URL 相对路径会把 `/` 变成 `\`，导致白名单前缀匹配全失败（表现为资源一律 404）→ 相对路径必须先统一成正斜杠再逐段校验。
- **实现陷阱 2**：叠加框的计算**不要依赖"页面渲染时机"**。标注来自另一个 HTTP 请求，若晚于页面渲染到达，而计算又写在"渲染 effect"里（且以 `status === 'render'` 为门），首屏页将永远没有框、只有后续滚出来的页正常。正确做法：把 `viewport` 存进 state，用 `useMemo` 从 `(viewport, annotations, pageNo)` 派生框。
- **实现陷阱 3（验证方法学）**：**不要用手搓的第三方 API 桩来验证几何**。本次正是因为单测桩里自己实现了 `convertToViewportRectangle`，测试全绿而真机报错。第三方 API 必须有**实库校验**（`spike/verify-pdf-overlay.mjs` 用真实 pdf.js + 真实 PDF + 与库自带语义逐框比对）。

---

## 7. DSH 侧集成规范

### 7.1 bundle 形态（零依赖、免构建）

```
zotero-plugin/
  package.json          # dsh.bundle.patch + dsh.client{platform:'web',immediately:true,inject:[…]}
                        # exports{".":"./index.js","./client":"./client.js"}  ← 声明 dsh.client 时 "./client" 必填
  cordis.patch.yml      # - insert: [{ id: dsh-zotero, name: '@local/dsh-zotero', config: {...} }]
  index.js              # Host 半：apply(ctx, config) = 路由 + 工具 + 提示词 + 授权
  client.js             # Client 半：window.__ModuleLoader__.load({ id, factory }) → { inject, apply }
  locale/{zh,en}.json
  icon.svg
```
- 客户端 bundle 只能 `require('react')` 等宿主模块表提供的包；**不得打包或 value-import 任何 `@deepseek-ai/dsh-client-ui-*`**。
- 安装：`dsh plugin --profile web add <绝对路径>`（或 GUI 插件页）；client 改动热加载，**host 改动需重启 DSH**。

### 7.2 Host 半

| 组件 | API | 说明 |
|---|---|---|
| HTTP 路由 | `ctx.effect(() => ctx.webServer.register({kind:'prefix', path:'/dsh-zotero/api', handler}))` | 同源 + 信任围栏；供面板调用；密钥不进页面 |
| 模型工具 | `ctx.tools.register(defineTool({...}))` 或**普通对象** | **实测契约**：`register()` 只做 `name` + `output{schema, render}` + `timeoutMs` 校验，`parameters` **原样透传给模型、不做编译** → 因此 `parameters` 必须是**带根 `type:'object'` 的完整 JSON Schema**（`{type:'object', additionalProperties:false, properties:{…}, required:[…]}`）。只有 `defineTool()` 才接受"属性表"简写；不导入 `defineTool` 的零依赖插件必须自己写成完整 Schema，否则模型侧报 `schema must be a JSON Schema of 'type: "object"', got 'type: null'`。 |
| 提示词 | `ctx.systemPrompt.section({name:'plugin:zotero', order, text})` | 说明工具用法、引用键约定（`[@key]`）、**禁止编造题录**、写前确认 |
| 凭据 | `ctx.credentials.modifyRecord('zotero-local-api-key', …)` / `readRecord` | 存本地 API key |
| 会话状态 | Host 内存 `Map<sessionId, {selection, pool}>` | 面板选中项与文献池 |
| 注入会话 | `ctx.agents.get(sessionId).inject(...)` | "发送到会话" |
| 依赖声明 | `export const inject = ['webServer','tools','systemPrompt','credentials','agents']` | 可选服务用 `ctx.inject([...])` |

**工具清单（Phase 1）**

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `zotero_search` | 检索条目 | 强制 `limit`；默认只回 key + 题录摘要 |
| `zotero_item` | 单条目元数据 + 子项清单 | 标题/作者/年份/DOI/摘要 |
| `zotero_annotations` | 某附件的标注 | **必须带 `itemType=annotation`**；默认不返回全文 |
| `zotero_fulltext` | 附件全文 | 按字符/页截断；提示索引可能不全 |
| `zotero_citation` | 题录导出 | 显式传 `style`；只对常规条目 |
| `zotero_selection` | 读用户当前选中项/文献池 | 读 Host 会话状态 |
| `zotero_create_note` | 写子笔记 | dry-run 预览；`Config.allowWrite` 门控 |
| `zotero_create_annotation` | 写高亮/下划线 | 键序固定；必填校验；image/ink 拒绝并建议改用笔记 |

### 7.3 Client 半（承载面 A）

```js
// client.js（示意）
window.__ModuleLoader__.load({
  id: '@local/dsh-zotero',
  factory(require) {
    const React = require('react');
    return {
      inject: ['slots', 'locale', 'betterSidebar'],   // better-sidebar 为可选软依赖
      apply(ctx) {
        ctx.effect(() => ctx.betterSidebar.registerTab({
          id: 'dsh-zotero:library',
          title: () => 'Zotero',
          order: 40,
          single: true,
          settings: { pluginToggles: [{ key: 'pageSize', title: '每页条目数', type: 'number', min: 5, max: 100 }] },
          component: ZoteroPanel,
        }));
      },
    };
  },
});
```
- 面板功能：集合树 → 条目列表（搜索）→ 详情（题录/摘要/标注/笔记）；勾选进「文献池」；「同步到 Zotero」；「发送到会话」。
- 样式只用 `--dsw-alias-*` 令牌；文案走 `ctx.locale`；`visible===false` 时暂停轮询。
- **未定**：`BetterSidebarService` 的确切字段以本机 `dsh-better-sidebar@0.24.1` 的 `lib/types/client/service.d.ts` 为准；`ctx.betterSidebar` 缺失时回退到 DSH 本体 `main`+`sidebar.panellist` 面板页。

### 7.4 数据流

```
面板 ──POST /dsh-zotero/api/<method>──▶ Host 半 ──HTTP──▶ Zotero 本地 API (23119)
                                        │
模型 ◀──工具 (ctx.tools) ───────────────┘
                                        └──▶ ctx.credentials（key）
```

---

## 8. Phase 1 验收标准

1. `dsh plugin --profile web add <dir>` 安装后，`dsh --profile web --dump-config` 可见 `dsh-zotero` 行；DSH 页面无 slot 崩溃。
2. 会话中问"检索 Zotero 里关于某主题的文献，给 5 条 APA 引用" → 工具被调用，题录与 Zotero 一致，无编造。
3. "列出 X 附件的全部标注并总结" → 标注条数与 Zotero 一致（用 `<附件key>` = 61 条做基准）。
4. `zotero_selection` 能读到面板里选中的条目。
5. 写操作默认关闭；开启后 dry-run 能打印将要发送的完整 payload（键序正确）。
6. Zotero 关闭时所有工具返回可读错误（`Zotero 未运行`），DSH 不崩。

---

## 附：Phase 0 证据索引

| 内容 | 位置 |
|---|---|
| 只读 + 写入原始响应 | `spike/phase0-evidence.json` |
| 干跑预览（23 个写请求逐条） | `docs/phase0-write-preview.md` |
| 检验计划与实测结论 | `docs/phase0-test-plan.md` |
| 脚手架 | `spike/phase0.mjs`（`--read-only` / `--dry-run-writes` / `--enable-writes` / `--cleanup`） |
| 字段必填性探针 | `spike/probe-ann-fields.mjs` |
| 精确对齐重写 | `spike/align-annotations.mjs` |
| 数据审计 | `spike/audit-notes.mjs`、`spike/diagnose-trash.mjs`、`spike/verify-cleanup.mjs` |
