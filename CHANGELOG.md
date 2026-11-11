# 更新日志

本文件记录 dsh-zotero 的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [0.4.2] - 2026-11-11

### 修复

- **重启 DSH 后写授权丢失，导致删除高亮报 401**（`Zotero 写授权无效或已过期`）。
  - 根因：`export const inject` 未包含 `credentials`，插件激活时 `ctx.get('credentials')` 为空，`keyStore.load()` 直接返回且错误被静默吞掉，内存里的 key 永远为空。
  - 迷惑症状：**建高亮能用、删高亮必挂**——`annotation.create` 每次先调 `authorize()` 顺手把 key 写进内存，`annotation.delete` 不会。
  - 四层兜底：启动退避重试 → 写前 `keyStore.ensureLoaded()` → 401 时 `withAuthRetry` 重新授权并重试 → 最后才弹 Zotero 授权框。
- `load()` 的每条失败分支都留日志（原来 `catch {}`，线上完全看不出原因）。

### 变更

- `authorize()` 是交互式请求（Zotero 弹框等用户点 Always Allow），超时从默认 15 秒放宽到 **120 秒**；超时文案改为直接提示「请在 Zotero 窗口里点 Always Allow」。
- `annotation.create` 改为「凭据里有密钥就复用、没有才 `authorize()`」，避免无谓弹框。

### 测试

- `spike/key-store-test.mjs` 新增 4 条 `ensureLoaded()` 回归（18 → 22 条）。

## [0.4.1] - 2026-11-11

### 新增

- **删除标注**：高亮小窗新增红色「删除」按钮，二次确认后移入 **Zotero 回收站（可恢复）**。
  - 只走 `POST /items [{key, version, deleted:1}]`（实测可用）；`DELETE` 永久删除未实测，不作为默认路径。
  - 新增路由 `annotation.delete`，受 `allowWrite` 门控 + 8 位 key 格式校验。
  - 新增 `buildTrashBody()`：逐条校验 `data.itemType === 'annotation'`，非标注一律拒绝，**防误删整篇文献**。

### 测试

- 新增 `spike/annotation-delete-test.mjs`（7 条）。
- 删除链路用真实 Zotero 10.0.8 端到端验证（version 999 → 1000，`deleted: true`，回收站可见）。

## [0.4.0] - 2026-11-11

### 新增

- **侧栏显示笔记正文**：展开条目后「笔记 N 条」逐条显示子笔记正文，纯文本渲染（不走 `innerHTML`），超 240 字折叠、可展开/收起。
- **面板阅读器手动划词建高亮**：每页叠加透明文本层（span 按 `viewport.transform` 定位、按 `it.width` 做 `scaleX` 对齐），拖选后用逆矩阵换回 PDF 用户空间，浮层写评论、选颜色、保存。
- **DSH 预览接管**：通过 `dsh-better-sidebar` 的 `registerFileViewer` 注册 `dsh-zotero:pdf`（`priority: 1`），让「DSH 预览」也具备划词高亮能力。
  - 原因：该表面原用 object URL + 浏览器原生 PDF 阅读器（不透明文档），插件无法注入文本层，**不可能**在那里加高亮。
  - 非 Zotero 附件自动降级为只读。
- 新增路由 `annotation.create` 与 `attachment.byPath`；Host 侧新增「本地路径 → 附件 key」内存索引（`createPathIndex`，上限 500 条，路径归一化大小写与斜杠）。

### 测试

- 新增 `spike/annotation-route-test.mjs`（8 条）、`spike/attachment-bypath-test.mjs`（6 条）。

## [0.3.0] - 2026-11-10

### 新增

- **`zotero_find_pdf`**：调用 Zotero 内置「查找可用文件」为条目补上原文，复用 Zotero 自己的 DOI / URL / 开放获取解析器。
  - 需要配套的 Zotero 桥接插件 `dsh-zotero-bridge`（`bridge/`，XPI 安装）。

### 修复

- 桥接插件 XPI 被 Zotero 10 拒绝安装：`strict_max_version` 写错（`8.*` → `11.*`）。
- 补上 Zotero **强制要求**的 `applications.zotero.update_url`——缺它时 Zotero 的报错文案是笼统的「可能无法与该版本兼容」，极易误判为版本不匹配。

## [0.2.3] - 2026-11-04

### 修复

- 凭据记录键改为 `<scope>/<id>` 形式（`dsh-zotero/local-api-key`），修复 **≤ 0.2.2 会让 DSH 下次启动失败**的致命问题。
- 凭据键校验从模块顶层移到激活期，改为降级处理，避免激活直接抛错。

[0.4.2]: https://github.com/waizzie/dsh-zotero/compare/v0.2.3...v0.4.2
[0.4.1]: https://github.com/waizzie/dsh-zotero/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/waizzie/dsh-zotero/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/waizzie/dsh-zotero/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/waizzie/dsh-zotero/compare/v0.2.2...v0.2.3
