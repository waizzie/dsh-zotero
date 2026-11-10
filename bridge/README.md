# DSH Zotero Bridge

一个极小的 Zotero 7 插件（约 200 行），把 Zotero 内置的「**查找可用文件 / Find Available File**」暴露成两个本地 HTTP 端点，供 [dsh-zotero](https://github.com/waizzie/dsh-zotero) 的 `zotero_find_pdf` 工具调用。

它**不实现任何抓取逻辑**，只是把下面两个函数包了一层：

```js
Zotero.Attachments.getFileResolvers(item, ['doi', 'url', 'oa', 'custom'], true)
Zotero.Attachments.addFileFromURLs(item, resolvers)
```

所以效果与你在 Zotero 里右键条目 →「查找可用的 PDF」**完全一致**：DOI 解析、URL 解析、开放获取（Unpaywall 等）、以及你在 Zotero 设置里配的自定义解析器，全部复用。

## 为什么需要它

Zotero 的本地 API（`/api/...`）**没有**查找原文的端点。唯一沾边的 `/connector/saveAttachmentFromResolver` 依赖浏览器连接器的 session，只能给"正在从网页保存的新条目"用，对库里已有条目返回 400。而上面两个函数只在 Zotero 进程内的 JS 上下文里可用，外部进程无法调用。

插件通过 `Zotero.Server.Endpoints` 注册端点（Better BibTeX 用的也是这个机制），从而在不改动 Zotero 的前提下开放该能力。

## 安装

```powershell
# 1) 打包（在仓库根目录）
node bridge\build.mjs
#    → bridge\dsh-zotero-bridge-0.1.0.xpi

# 2) 在 Zotero 里安装
#    工具 → 插件 → 右上角齿轮 → Install Plugin From File…
#    选中上面生成的 .xpi

# 3) 重启 Zotero
```

未签名插件可以安装（Zotero 7 不强制插件签名，源码里没有签名校验路径）。

## 验证

```powershell
curl.exe http://127.0.0.1:23119/dsh-zotero/ping
```

期望：

```json
{
  "ok": true,
  "bridge": "dsh-zotero-bridge",
  "version": "0.1.0",
  "zoteroVersion": "10.0.7",
  "supportedFileTypes": ["application/pdf", "application/epub+zip"],
  "canFindFiles": true
}
```

装之前同一地址返回 `No endpoint found`——这正是 DSH 侧区分「桥没装」和「条目不存在」的依据。

## 端点

### `GET /dsh-zotero/ping`

探活。返回版本与 `canFindFiles`（Zotero 版本过旧、缺 `getFileResolvers` 时为 `false`）。

### `POST /dsh-zotero/find-file`

请求体：

```json
{ "itemKey": "QB2X8FES", "dryRun": false, "force": false, "methods": ["doi","url","oa","custom"] }
```

- `itemKey`（必填）：8 位条目 key，大小写不敏感。
- `dryRun`：只返回解析器数量与类型，不下载。
- `force`：即使条目已有 PDF/EPUB 也重新查找。
- `methods`：解析器类型，默认四类全开。
- `libraryID`：可选，默认用户库。

成功（200）：

```json
{
  "ok": true,
  "itemKey": "QB2X8FES",
  "attachmentKey": "ABCD1234",
  "attachmentTitle": "Full Text PDF",
  "contentType": "application/pdf",
  "resolverCount": 4,
  "resolvers": ["doi", "url", "oa", "custom"]
}
```

业务失败也返回 200 + `ok:false`（不是异常）：

| `error` | 含义 |
|---|---|
| `NO_RESOLVERS` | 条目既无 DOI/URL，也无开放获取来源 |
| `NO_FILE_FOUND` | 试过所有解析器都没拿到文件（需订阅 / 要验证码） |
| `DOWNLOAD_ERROR` | 下载过程中抛错，`message` 里有原因 |

协议层错误：

| HTTP | `error` |
|---|---|
| 400 | `BAD_ITEM_KEY` / `BAD_JSON` / `BAD_BODY` / `NOT_REGULAR_ITEM` |
| 403 | `BAD_TOKEN`（仅当配置了 token 偏好） |
| 404 | `ITEM_NOT_FOUND` |

## 安全

端点只随 Zotero 自己的本地服务监听 `127.0.0.1:23119`，不对外网开放，与 Zotero 其他端点同一信任级别。

如需额外防护，在 Zotero → 设置 → 高级 → 配置编辑器里加一条**字符串**偏好：

```
extensions.zotero.dshBridge.token = <随机串>
```

之后所有请求必须带 `X-DSH-Bridge-Token: <随机串>`，否则 403。默认不设即不校验。

## 卸载

Zotero → 工具 → 插件 → 选中 DSH Zotero Bridge → Remove。`shutdown()` 会注销两个端点，之后 `zotero_find_pdf` 回到 `bridge-missing` 提示，DSH 侧其他功能不受影响。

## 兼容性

- Zotero 7.0+（`manifest.json` 里 `strict_min_version: 7.0`，`strict_max_version: 8.*`）。
- 实测环境：Zotero 10.0.7 / Windows。
- 若将来 Zotero 把 `addFileFromURLs` 改名（`addAvailablePDF` 已 deprecated 过一次），`ping` 的 `canFindFiles` 会变成 `false`，DSH 侧会直接报错而不是静默失败。
