# Phase 0 写入请求逐条预览（干跑，**未发送任何网络请求**）

- 生成时间：2026-10-03T04:58:59.994Z
- 目标：`http://127.0.0.1:23119`　Server-ID：`<server-id>`　库版本基线：`195`
- 隔离方案：**α**（新建 `DSH-TEST-<时间戳>` 测试条目 + 自建 1 页 PDF 附件；测完整体移入回收站）
- 说明：`POST /items` 的 body 一律是 JSON 数组；写请求均带 `Zotero-Server-ID`；以下请求在 `--enable-writes` 时按此顺序真实发送。
- 审核要点见文末「需要你确认的地方」。

## #1　POST http://127.0.0.1:23119/api/local/authorize

> 触发用例：`T3.1`

```http
POST http://127.0.0.1:23119/api/local/authorize
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json

{"appName":"DSH Zotero (Phase0 Test)"}
```

## #2　POST http://127.0.0.1:23119/api/local/authorize

> 触发用例：`T2.1`

```http
POST http://127.0.0.1:23119/api/local/authorize
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json

{"appName":"x"}
```

## #3　POST http://127.0.0.1:23119/api/users/0/items

> 触发用例：`T2.2`

```http
POST http://127.0.0.1:23119/api/users/0/items
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json
Zotero-API-Key: <API-KEY>

{"itemType":"note","note":"x"}
```

## #4　POST http://127.0.0.1:23119/api/users/0/items

> 触发用例：`T2.3`

```http
POST http://127.0.0.1:23119/api/users/0/items
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json
Zotero-API-Key: ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ

[]
```

## #5　POST http://127.0.0.1:23119/api/users/0/items

> 触发用例：`T2.4`

```http
POST http://127.0.0.1:23119/api/users/0/items
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json

[]
```

## #6　POST http://127.0.0.1:23119/api/users/0/items

> 触发用例：`T4.0`

```http
POST http://127.0.0.1:23119/api/users/0/items
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json
Zotero-API-Key: <API-KEY>

[{"itemType":"journalArticle","title":"DSH-TEST-2026-10-03T04-58-59-988Z","creators":[{"creatorType":"author","firstName":"DSH","lastName":"Test"}],"date":"2026","tags":[{"tag":"dsh-test"}]}]
```

## #7　POST http://127.0.0.1:23119/api/users/0/items

> 触发用例：`T4.1`

```http
POST http://127.0.0.1:23119/api/users/0/items
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json
Zotero-API-Key: <API-KEY>

[{"itemType":"note","parentItem":"DRY00006","note":"<h2>DSH 测试笔记</h2><p>这是由 DSH 写入的子笔记。</p><ul><li>要点一</li><li>要点二</li></ul><p><strong>加粗</strong>与<em>斜体</em>，公式 <span class=\"math\">E=mc^2</span></p><blockquote>引用块</blockquote>","tags":[{"tag":"dsh-test"}]},{"itemType":"note","note":"<p>DSH 独立笔记（无 parentItem）</p>"},{"itemType":"note","parentItem":"DRY00006","note":"**Markdown 直传测试** - 列表项"}]
```

## #8　PATCH http://127.0.0.1:23119/api/users/0/items/DRY00007

> 触发用例：`T4.5`

```http
PATCH http://127.0.0.1:23119/api/users/0/items/DRY00007
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json
Zotero-API-Key: <API-KEY>

{"note":"<p>更新后的笔记内容</p>","version":100}
```

## #9　POST http://127.0.0.1:23119/api/users/0/items

> 触发用例：`T4.9`

```http
POST http://127.0.0.1:23119/api/users/0/items
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json
Zotero-API-Key: <API-KEY>
Zotero-Write-Token: d94bb23ae97646d084465f7f368172ee

[{"itemType":"note","note":"<p>token 幂等测试</p>"}]
```

## #10　POST http://127.0.0.1:23119/api/users/0/items

> 触发用例：`T4.9`

```http
POST http://127.0.0.1:23119/api/users/0/items
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json
Zotero-API-Key: <API-KEY>
Zotero-Write-Token: d94bb23ae97646d084465f7f368172ee

[{"itemType":"note","note":"<p>token 幂等测试</p>"}]
```

## #11　PATCH http://127.0.0.1:23119/api/users/0/items/DRY00007

> 触发用例：`T4.10`

```http
PATCH http://127.0.0.1:23119/api/users/0/items/DRY00007
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json
Zotero-API-Key: <API-KEY>

{"note":"<p>过期版本</p>","version":1}
```

## #12　POST http://127.0.0.1:23119/api/users/0/items

> 触发用例：`T4.8`

```http
POST http://127.0.0.1:23119/api/users/0/items
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json
Zotero-API-Key: <API-KEY>

[{"itemType":"note","parentItem":"ZZZZZZZZ","note":"<p>父项不存在</p>"},{"itemType":"note","note":12345}]
```

## #13　POST http://127.0.0.1:23119/api/users/0/items

> 触发用例：`T4.7`

```http
POST http://127.0.0.1:23119/api/users/0/items
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json
Zotero-API-Key: <API-KEY>

[{"itemType":"note","parentItem":"DRY00006","note":"<p>消毒测试</p><script>alert(1)</script><img src=x onerror=\"alert(1)\">"}]
```

## #14　POST http://127.0.0.1:23119/api/users/0/items

> 触发用例：`T5.1a`

```http
POST http://127.0.0.1:23119/api/users/0/items
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json
Zotero-API-Key: <API-KEY>

[{"itemType":"attachment","parentItem":"DRY00006","linkMode":"imported_file","contentType":"application/pdf","charset":"","filename":"dsh-test.pdf","title":"DSH-TEST PDF"}]
```

## #15　POST http://127.0.0.1:23119/api/users/0/items/DRY00014/file?md5=683ea7586ec69a7eba0bd89cb8ef4347&filename=dsh-test.pdf&filesize=787&mtime=1791003539992

> 触发用例：`T5.1b`

```http
POST http://127.0.0.1:23119/api/users/0/items/DRY00014/file?md5=683ea7586ec69a7eba0bd89cb8ef4347&filename=dsh-test.pdf&filesize=787&mtime=1791003539992
Connection: close
Zotero-Server-ID: <server-id>
Zotero-API-Key: <API-KEY>
If-None-Match: *

(无 body)
```

## #16　POST http://127.0.0.1:23119/api/local/uploads/DRYUPLOAD

> 触发用例：`T5.1b`

```http
POST http://127.0.0.1:23119/api/local/uploads/DRYUPLOAD
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/pdf

(二进制 787 字节，application/pdf)
```

## #17　POST http://127.0.0.1:23119/api/users/0/items/DRY00014/file?upload=DRYUPLOAD

> 触发用例：`T5.1b`

```http
POST http://127.0.0.1:23119/api/users/0/items/DRY00014/file?upload=DRYUPLOAD
Connection: close
Zotero-Server-ID: <server-id>
Zotero-API-Key: <API-KEY>
If-None-Match: *

(无 body)
```

## #18　POST http://127.0.0.1:23119/api/users/0/items

> 触发用例：`T5.3`

```http
POST http://127.0.0.1:23119/api/users/0/items
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json
Zotero-API-Key: <API-KEY>

[{"itemType":"annotation","parentItem":"DRY00014","annotationType":"highlight","annotationText":"Highlight target line: knowledge graph reasoning.","annotationSortIndex":"00000|000692|00072","annotationPosition":"{\"pageIndex\":0,\"rects\":[[72,692,320,706]]}","annotationPageLabel":"1","annotationComment":"<b>DSH 写入的高亮评论</b>：验证标注回写。","annotationColor":"#ffd400","tags":[{"tag":"dsh-test"}]},{"itemType":"annotation","parentItem":"DRY00014","annotationType":"highlight","annotationText":"DSH-ZOTERO-TEST ANNOTATION TARGET","annotationSortIndex":"00000|000000|00000","annotationPosition":"{\"pageIndex\":0,\"rects\":[[72,712,320,726]]}","annotationPageLabel":"1","annotationComment":"sortIndex=0 的排序对照","annotationColor":"#2ea8e5","tags":[]},{"itemType":"annotation","parentItem":"DRY00014","annotationType":"underline","annotationText":"This one-page PDF exists only to verify Zotero annotation writes.","annotationSortIndex":"00000|000672|00072","annotationPosition":"{\"pageIndex\":0,\"rects\":[[72,668,470,682]]}","annotationPageLabel":"1","annotationComment":"underline 对照","annotationColor":"#ff6666","tags":[]}]
```

## #19　PATCH http://127.0.0.1:23119/api/users/0/items/DRY00018

> 触发用例：`T5.12`

```http
PATCH http://127.0.0.1:23119/api/users/0/items/DRY00018
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json
Zotero-API-Key: <API-KEY>

{"annotationComment":"<b>评论已更新</b>","version":100}
```

## #20　POST http://127.0.0.1:23119/api/users/0/items

> 触发用例：`T5.9`

```http
POST http://127.0.0.1:23119/api/users/0/items
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json
Zotero-API-Key: <API-KEY>

[{"itemType":"annotation","parentItem":"DRY00014","annotationType":"highlight","annotationText":"错误字段名测试","pageLabel":"9","sortIndex":"00009|000000|00000","annotationPosition":"{\"pageIndex\":0,\"rects\":[[72,692,320,706]]}","annotationComment":"","annotationColor":"#aaaaaa","tags":[]}]
```

## #21　POST http://127.0.0.1:23119/api/users/0/items

> 触发用例：`T5.8`

```http
POST http://127.0.0.1:23119/api/users/0/items
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json
Zotero-API-Key: <API-KEY>

[{"parentItem":"DRY00014","annotationText":"键序反例","annotationPosition":"{\"pageIndex\":0,\"rects\":[[72,692,320,706]]}","annotationComment":"","annotationColor":"#aaaaaa","annotationPageLabel":"1","annotationSortIndex":"00000|000000|00000","tags":[],"itemType":"annotation","annotationType":"highlight"}]
```

## #22　POST http://127.0.0.1:23119/api/users/0/items

> 触发用例：`T5.11`

```http
POST http://127.0.0.1:23119/api/users/0/items
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json
Zotero-API-Key: <API-KEY>

[{"itemType":"annotation","parentItem":"DRY00014","annotationType":"image","annotationText":"","annotationComment":"image 标注测试","annotationColor":"#aaaaaa","annotationPageLabel":"1","annotationSortIndex":"00000|000600|00072","annotationPosition":"{\"pageIndex\":0,\"rects\":[[300,600,322,622]]}","tags":[]}]
```

## #23　POST http://127.0.0.1:23119/api/users/0/items

> 触发用例：`T5.10`

```http
POST http://127.0.0.1:23119/api/users/0/items
Connection: close
Zotero-Server-ID: <server-id>
Content-Type: application/json
Zotero-API-Key: <API-KEY>

[{"itemType":"annotation","parentItem":"DRY00006","annotationType":"highlight","annotationText":"非法父项","annotationPosition":"{\"pageIndex\":0,\"rects\":[[72,692,320,706]]}","annotationComment":"","annotationColor":"#aaaaaa","annotationPageLabel":"1","annotationSortIndex":"00000|000000|00000","tags":[]}]
```

## 需要你确认的地方

1. **授权弹窗**：请求 #1 会弹出 Zotero 授权窗，请点 **Always Allow**（否则每个写请求都会再弹一次）。
2. **测试数据**：请求 #6 新建 `DSH-TEST-*` 条目；#14–#17 上传自建 1 页 PDF（787 字节）；#7/#13/#18/#20/#21/#22 写笔记与标注。全部在测试条目下。
3. **目视验收点**：真跑后请在 Zotero 打开测试 PDF，确认第 1 页出现 2 处高亮（黄 `#ffd400`、蓝 `#2ea8e5`）与 1 处下划线（红 `#ff6666`），侧栏可见选中文字与评论。
4. **清理**：真跑后执行 `node spike/phase0.mjs --cleanup`，测试对象整体移入回收站（可恢复）。

（共 23 个写请求）
