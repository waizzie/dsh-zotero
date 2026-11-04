# 标注创建（高亮）实现笔记

> 本文记录 `zotero_highlight` 的几何依据与实测偏差。所有数字来自本机 Zotero 库中**已有标注**的反解，
> 不含任何真实文献题名 / key / 用户信息。

## 1. 为什么在 Host 侧做定位

面板里的 PDF 是 pdf.js **canvas 自绘 + 标注覆盖层**，没有文本层（`renderTextLayer` / `getTextContent` 都没实现），
所以面板内做不了"选中文字 → 算 rect"。而 Host 侧：

- 有 `pdfjs-dist` 依赖（与面板同版本 6.3.289）；
- 能拿到附件的**本地绝对路径**（`client.getAttachmentInfo`）；
- `page.getTextContent()` 直接给出每个 text item 的 `transform`（PDF 用户空间、左下原点）。

因此定位与 rect 计算全部放在 `lib/annotations.js`，面板不参与。

## 2. rect 公式（实测标定）

```
fs   = hypot(transform[2], transform[3])        // 该 text item 的字号
rect = [x1, baseline − 0.25·fs, x2, baseline + 1.0·fs]
```

即 Zotero 的行盒高度为 **1.25em**。依据：12 条真实标注里有 8 条（正文，字号 6.376 / 7.173 / 7.97）
与该式**逐位吻合**（下探系数 0.2500、上伸系数 1.0000，精确到小数点后 4 位），且与字号无关。

`x1` 与真值完全一致；`x2` 用 `transform[4] + item.width` 累加，比 Zotero 略宽 0–3pt（行尾空格 / 字距），不影响观感。

## 3. 已知偏差

| 情况 | 现象 | 原因 |
|---|---|---|
| 粗体标题字体 | 整框**上移** 1.5–2.6pt（下沿少探 1.51、上沿多伸 2.62） | Zotero 对这类字体用的是 **1.11em** 行盒（实测下探 0.4395 / 上伸 0.671），不是 1.25em |
| 中文 12pt 样本 | 实测下探 0.141 / 上伸 0.859（行盒 1.00） | 与字体自身的 ascent/descent 一致，说明框高随字体变化 |

结论：**不存在单一公式能覆盖所有字体**。当前实现选覆盖最广的 1.25em 规则，标题类标注允许 ≤2.6pt 的垂直偏差。
若后续要精确到逐字体，可改为读 `textContent.styles[fontName]` 的 `ascent`/`descent`，但实测该值对部分字体
（如标题用的 `ascent=1.196`）明显偏大，直接使用反而更差，需要额外做合理性钳制。

## 4. 写入 payload 的硬约束

来自 `docs/zotero-api-spec.md` §4.4 与**首次真写**的实测，任何一条不满足都会 400 或静默失败：

1. **`itemType` 必填**，值为 `"annotation"`。缺了它 Zotero 直接回
   `400 {"code":400,"message":"itemType property not provided"}`——这条是第一次真写高亮时才踩到的：
   早期只按"annotationType 打头"组织对象、漏了 itemType，四条全被拒。
2. `annotationPosition` 是 **JSON 字符串**（不是对象），内容 `{ pageIndex, rects }`；
3. `annotationSortIndex` 与 `annotationPosition` 都是 NOT NULL；
4. `parentItem` 必须指向**文件附件**（不是父条目）；
5. body 必须是**数组**，且 HTTP 200 也要逐对象检查 `failed`；
6. `annotationType` 放在第一个键（`createAnnotations` 里显式重排）。注意：真实标注对象从
   `GET /api/users/0/items/<key>` 取回来时顺序是 `itemType, parentItem, annotationType, …`，
   说明服务端大概率不校验键序——"必须打头"这条**至今未被复现**，保留只是为了不引入回归。

### 4.1 一次成功写入的真实形状

```json
{
  "annotationType": "highlight",
  "itemType": "annotation",
  "parentItem": "<PDF 附件 key>",
  "annotationText": "<PDF 原文片段>",
  "annotationComment": "<评论>",
  "annotationColor": "#ffd400",
  "annotationPageLabel": "2",
  "annotationSortIndex": "00001|004251|01289",
  "annotationPosition": "{\"pageIndex\":1,\"rects\":[[128.884,351.989,217.615,366.933]]}"
}
```

HTTP 200，`success: {"0":"<新标注 key>"}`、`failed: {}`。

`sortIndex` 格式 `PPPPP|YYYYYY|XXXXX`：第 1 段经 218/218 实测就是 `pageIndex`；后两段是阅读器视口坐标
（左上原点），无法从 rect 反解。它只影响标注列表内的排序，不影响高亮位置（位置只认 `annotationPosition`），
所以这里用单调代理值；用户下次在 Zotero 里编辑该标注时 Zotero 会自行重算。

## 5. 定位算法

1. 按基线（2pt 容差）把 text item 归行；
2. 行内按 x 排序后拼接成字符串，同时记录每个 item 的字符区间；
3. 对「行文本」和「目标文本」做同一套归一化（折叠空白 + 小写），并保留「归一化下标 → 原串下标」映射；
4. 在归一化空间里 `indexOf`，再映射回原串区间，取出与之相交的 item；
5. 这些 item 的并集就是 rect；`matchedText` 取原串切片，保证写回的文字**来自 PDF 原文**而不是用户输入。

限制：**只支持单行匹配**。跨行片段会定位失败并报错（提示用户改选单行内的一段）。

### 5.1 多处命中不猜（重要）

`locateText` **不会"取第一处就返回"**。实测一篇 13 页论文里 `Natural language processing` 出现 **12 次**：
第 1 处是页眉/引文残片（`fs=6.376`），真正的节标题 `2.1. Natural language processing` 在第 2 页（`fs=7.97`）。
早期版本取第一处，结果高亮静默标到了错误位置——这种错误在 UI 上看起来"有高亮"，很难被发现。

现在的语义：

| 命中数 | 返回 |
|---|---|
| 0 | `null` → 工具报"没找到这段文字" |
| 1 | 直接返回定位结果 |
| ≥2 | `{ ambiguous: true, candidates: [...] }` → 工具**不写入**，把候选（页码 + 一行上下文）摊给模型看 |

模型据候选补 `pageIndex`（同页仍重复时再加 `occurrence`，0 起）重来。上限 20 条候选，避免把参考文献整页刷屏。

## 6. 回归

`spike/annotation-test.mjs` 用库中已有标注的 rect 当标准答案，覆盖 3 条（正文 ×2、标题 ×1）+ 歧义行为 + payload 结构断言，
共 21 项。不需要 DSH 在跑、不写 Zotero。
