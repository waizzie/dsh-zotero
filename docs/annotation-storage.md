# Zotero 标注存储核查（Phase A）

> 目的：查清 Zotero 到底怎么存"高亮位置 + 笔记（评论）"，为"面板里 Zotero 标注没画出来"提供判据。
> 方法：**全程只读**（不创建/修改/删除任何 Zotero 对象），脚本 `spike/probe-annotation-storage.mjs`。
> 样本：3 个带标注的真实 PDF 附件 / 11 条标注（2026-10-03 实测，Zotero 10.0.5，库版本 333）。

## 1. 字段与语义（实测，非文档推断）

`GET /api/users/0/items/<annotationKey>` 的 `data` 字段：

| 字段 | 类型 | 语义 | 样本齐全率 |
|---|---|---|---|
| `annotationPosition` | **字符串**（JSON） | 位置：只有 `pageIndex` 与 `rects` 两个键 | 11/11 (100%) |
| `annotationType` | string | `highlight` / `underline` / `note` / `image` / `ink` | 11/11 |
| `annotationText` | string | **被高亮的原文** | 11/11 (100%) |
| `annotationComment` | string | **该高亮的笔记正文**（HTML，可含 `<b>` 等） | 9/11 (82%)，其中 5 条含标记 (45%) |
| `annotationColor` | `#rrggbb` | 高亮底色（默认 `#ffd400`，也见 `#ff6666`） | 11/11 |
| `annotationPageLabel` | string | **页码标签**（可能与 `pageIndex+1` 不等，如罗马数字/前言） | 11/11 |
| `annotationSortIndex` | string | 阅读顺序：`"页码|行内序|字符序"`，如 `"00002\|000920\|00545"` | 11/11 |
| `annotationIsExternal` | boolean | **true = 该标注来自 PDF 文件本身**（Zotero 只是导入显示）；否则是 Zotero 内创建 | 0/11 为 true |
| `tags` | array | 标注上的标签 | 2/11 (18%) |

### `annotationPosition` 原文样例

```json
{"pageIndex":2,"rects":[[237.541,240.778,288.671,248.206]]}
```

- `pageIndex` 是 **0 基**（`pageIndex=2` ↔ `annotationPageLabel="3"`）。
- 一条标注可有多段 `rects`（多行高亮）：实测 **3/11 (27%)** 为多段，例如
  `[[125.113,314.74,285.959,325.025],[50.5,298.86,92.3,309.145]]`。
- **坐标语义**：`[x1,y1,x2,y2]`，PDF 用户空间、**左下原点**、相对 **MediaBox**（未旋转的原始坐标）。

## 2. 坐标核对（用 pdf.js legacy 取真实页面几何）

| 检查 | 结果 |
|---|---|
| rect 落在页面 `viewBox` 内 | **14/14 = 100%** |
| 旋转页标注（`viewport.rotate ≠ 0`） | 0 个 |
| 越界/异常 | 无 |

换算到画布（面板实际用的路径）：

```
rects（左下原点，MediaBox 坐标）
   → pdf.js viewport.convertToViewportRectangle(rect)   // 同时处理 scale 与 /Rotate
   → 左上原点的画布坐标 → 绝对定位的覆盖层 div
```

因为实测 rect 100% 在页内且无旋转，**"坐标算错"可以排除**（H3 排除）。

## 3. "PDF 自带标注"到底是什么

逐页（前 25 页）扫描 PDF 文件层 `page.getAnnotations()`：

| 附件 | 页数 | PDF 自带标注 | 含可视化标注（Highlight/Ink/Square…）？ |
|---|---|---|---|
| `<附件key>` | 20 | `{Link: 153}` | **无** |
| `<附件key>` | 11 | `{Link: 227}` | **无** |
| `<附件key>` | 8 | `{}` | **无** |

**结论：这批 PDF 文件里没有任何可视化标注**（只有链接区）。因此：

1. 面板里能看到的高亮**只可能来自 Zotero 数据库标注**（也就是我们要叠加的那批）；
2. 不存在"PDF 自带高亮 + 叠加层"双重渲染的问题（`annotationIsExternal` 全为 false，与之一致）。

> 注：`annotationIsExternal = true`（PDF 里真的嵌了高亮，例如**先在 Acrobat DC 标注再导入**）时，pdf.js 渲染画布会自己把它画出来，叠加层必须按该字段跳过，否则会画两遍。**这条已实现**（用户实测的那篇就是 Acrobat 先标后导入）。

## 4. 对"面板没显示 Zotero 标注"的判据（已定位根因）

数据侧全部正常，问题在客户端绘制环节。根因是 **pdf.js 6.x 移除了 `viewport.convertToViewportRectangle()`**（详见 §7），并叠加了两处工程缺陷，导致症状极具迷惑性：

| 时间 | 现象 | 真实原因 |
|---|---|---|
| 第一次反馈 | 第 7 页"渲染失败" | 旧代码 `overlayBoxes()` 在 `try` 里调用**不存在的方法** → 抛错被 `catch` 吞掉 → 被当成"渲染失败"。**只有第一个带标注的页会报**：前面几页没有标注，从未触发过 |
| 第二次反馈 | 面板弹出 `viewport.convertToViewportRectangle is not a function or its return value is not iterable` | 把换算挪进 `useMemo`（渲染阶段）后，同一异常不再被吞，冒到 better-sidebar 错误边界 |
| 一直存在 | 首屏页没有高亮、往下滚才有 | 覆盖框只在"页面渲染"effect 内算一次；标注来自另一个 HTTP 请求，晚到时那次渲染捕获的是空数组，后续重算又被 `status !== 'render'` 挡住 |

**修复**（`zotero-plugin/client.js`）：

1. 改用 `viewport.transform` 矩阵自己换算（`X = a·x + c·y + e`，`Y = b·x + d·y + f`，对 rect 取四角求包围盒）；老版本若提供该方法则优先使用。**实测与 pdf.js 自带语义逐框偏差为 0**；
2. 覆盖框改为 `useMemo` 从 `(viewport, annotations, pageNo)` **派生**，不再依赖渲染时机（标注后到也会立刻画出）；
3. 单个 rect 换算失败只跳过并计数（界面提示"本页 N 个标注换算失败"），不再整页/整面板崩；
4. `annotationIsExternal === true` 的标注**不叠加**（pdf.js 已画），避免叠两遍；
5. 渲染失败显示**具体原因** + 「重试」；标注接口失败不再静默吞掉；每页渲染前取消上一个 `render()` 任务。

工具栏自检行（便于一眼判断叠加是否生效）：

```
第 X/Y 页 · 标注 N 条（叠加 M · 自带 K）· 已画框 P · 120%
```

- `叠加 M` = 应被画到画布上的 Zotero 标注数（有 rects 的）
- `自带 K` = PDF 内嵌标注数（pdf.js 自己画）
- `已画框 P` = 当前已渲染页上实际画出的框数

## 5. 复现与验证

```powershell
cd <项目目录>
node spike\probe-annotation-storage.mjs   # 存储字段核查（只读）
node spike\verify-pdf-overlay.mjs         # 实库几何校验：真实 pdf.js + 真实 PDF + 与库自带语义逐框比对（偏差应为 0）
node spike\verify-client.mjs              # 面板离屏验证（含"标注晚到仍要画框"的回归锁）
```

## 6. 局限与待补

- 存储样本 3 附件 / 11 条；未覆盖 `underline`、`note`（纯批注）、`ink`、`image` 类型；
- 未覆盖**旋转页**（`/Rotate`）与 CropBox ≠ MediaBox 的真实 PDF（换算已有旋转矩阵单测，但缺真实样本）；
- 只扫了前 25 页的 PDF 自带标注；
- `annotationIsExternal = true` 的标注由 pdf.js 渲染，**不提供**本面板的小窗（评论）交互；若要支持，需改为"不叠加但读取 PDF 层标注的 `/Contents` 来配对"。

## 7. 根因备忘：pdf.js 6.x 的 API 变更（本次 bug 的根）

实测 `pdfjs-dist@6.3.289` 的 `PageViewport`：

| 成员 | 是否存在 |
|---|---|
| `transform`（`[a,b,c,d,e,f]` 2×3 仿射矩阵） | ✅ |
| `convertToViewportPoint(x, y)` | ✅ |
| `rawDims` / `viewBox` / `scale` / `offsetX` / `offsetY` | ✅ |
| `convertToViewportRectangle(rect)` | ❌ **已移除**（老版本存在） |

映射语义（与库内 `Util.applyTransform` 一致）：`X = a·x + c·y + e`，`Y = b·x + d·y + f`。

**方法学教训（值得记住）**：几何换算这类依赖第三方 API 的逻辑，**不能用手搓的桩来验证**——本次单测桩里我自己实现了那个已被移除的方法，于是测试全绿、真机一翻页就报错。已补 `spike/verify-pdf-overlay.mjs`：真实 pdf.js + 真实 PDF + 真实标注 + 与库自带语义**逐框比对**（偏差 0 才算过）。

