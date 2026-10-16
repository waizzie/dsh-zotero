# 调研文档（Phase 0 / 标注存储核查）

这些是 `dsh-zotero` 插件开发期的一手实测记录，随仓库归档，**不随 npm 包分发**（`package.json` 的 `files` 白名单不含 `docs/`）。

> **示例已脱敏**：文中的 Zotero 条目/附件 key、`Server-ID`、`userID`、分类名、标签名与真实标注原文，均已替换为 `<附件key>` / `<顶层key>` / `<server-id>` / `<userID>` / `<某分类>` / `<标签>` / `<被高亮的原文>` 一类占位符；只保留结构性结论与数值（例如"某分类 77 个成员 = 23 期刊 + 45 附件 + 6 笔记 + 2 预印本 + 1 学位论文"）。
>
> 文中引用的探针与回归脚本（`spike/*.mjs`）属开发期工具，未随本仓库分发；请把它们当作出处标注阅读。

| 文档 | 内容 |
|---|---|
| [zotero-api-spec.md](zotero-api-spec.md) | **接口规范 v1**：本地 API 的读写契约、错误码速查、标注坐标计算，以及 **20 条实测陷阱清单**（实现时必须遵守） |
| [annotation-storage.md](annotation-storage.md) | **标注存储核查**：`annotationPosition` / `annotationComment` 等字段语义与坐标核对，并定位"面板不显示已有标注"的根因（pdf.js 6.x 移除了 `convertToViewportRectangle()`） |
| [phase0-test-plan.md](phase0-test-plan.md) | **Phase 0 检验计划与结论**：只读部分 18/18 PASS、写入实测（隔离方案 α）、数据完整性审计，以及一条必守的接口陷阱 |
| [phase0-write-preview.md](phase0-write-preview.md) | **写入请求逐条预览**（干跑，未发送网络请求）：23 条写请求的完整形态，是规范 §4.3–4.7 的原始依据 |
| [zotero-plugin-plan.md](zotero-plugin-plan.md) | **实施计划 v1**（历史文档）：需求拆解、架构取舍（为什么必须 Host 中转）、分期计划与验收口径 |

## 与当前实现的关系

- **已实现**：读接口（条目/标注/笔记/全文/题录）、子笔记写回、侧边栏面板、既有标注的坐标叠加渲染。
- **待实现**（结论见 [zotero-api-spec.md](zotero-api-spec.md) §4.4/§5）：标注/高亮的**创建**与坐标回写。
