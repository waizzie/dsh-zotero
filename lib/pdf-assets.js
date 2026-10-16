/**
 * pdf.js 资源供给（Host 侧）。
 *
 * 为什么需要：面板要在**自绘的 PDF** 上叠加 Zotero 标注（高亮 + 评论小窗）。
 * 浏览器原生 PDF 阅读器是独立文档，无法在其上绘制或定位，所以只能自己用 pdf.js 渲染。
 * pdf.js 作为本包依赖安装；这里把它需要的静态资源经 /dsh-zotero/vendor/** 暴露给面板。
 *
 * 只暴露白名单目录，且做路径穿越校验。
 */
import { createRequire } from 'node:module';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/** 允许暴露的 pdf.js 子路径前缀（相对 pdfjs-dist 根）。 */
const ALLOWED = [
  'build/pdf.mjs',
  'build/pdf.worker.mjs',
  'build/pdf.worker.min.mjs',
  'cmaps/',
  'standard_fonts/',
  'wasm/',
  'image_decoders/',
];

const TYPES = [
  [/\.mjs$|\.js$/, 'text/javascript; charset=utf-8'],
  [/\.json$/, 'application/json; charset=utf-8'],
  [/\.wasm$/, 'application/wasm'],
  [/\.bcmap$/, 'application/octet-stream'],
  [/\.(ttf|otf)$/, 'font/ttf'],
  [/\.pfb$/, 'application/octet-stream'],
  [/\.(png|gif|jpe?g)$/, 'image/*'],
  [/\.map$/, 'application/json; charset=utf-8'],
];

export function createPdfAssets() {
  let root = null;
  let error = null;
  try {
    root = dirname(require.resolve('pdfjs-dist/package.json'));
  } catch (e) {
    error = `未找到 pdfjs-dist（${e.message}）`;
  }

  const version = (() => {
    if (!root) return null;
    try { return JSON.parse(require('node:fs').readFileSync(join(root, 'package.json'), 'utf8')).version; } catch { return null; }
  })();

  const contentTypeOf = (rel) => {
    for (const [re, type] of TYPES) if (re.test(rel)) return type;
    return 'application/octet-stream';
  };

  /** 解析并校验一个 vendor 相对路径；非法或不存在返回 null。 */
  const resolveAsset = (rel) => {
    if (!root || typeof rel !== 'string' || rel === '') return null;
    // 统一成正斜杠再逐段校验：Windows 的 normalize() 会把 / 变成 \，会让白名单前缀失配
    const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
    const segments = clean.split('/');
    if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
    if (!ALLOWED.some((prefix) => clean === prefix || clean.startsWith(prefix))) return null;
    const abs = join(root, ...segments);
    if (!abs.startsWith(root)) return null;
    try {
      const info = statSync(abs);
      if (!info.isFile()) return null;
      return { abs, size: info.size, contentType: contentTypeOf(clean) };
    } catch { return null; }
  };

  return {
    root,
    error,
    version,
    resolveAsset,
    /** GET/HEAD /dsh-zotero/vendor/<rel> 的处理体（不含信任围栏，由路由统一处理）。 */
    async serve(req, res, rel) {
      if (!root) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(error ?? 'pdfjs-dist 不可用');
        return;
      }
      const asset = resolveAsset(rel);
      if (!asset) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`vendor 资源不存在或不被允许：${rel}`);
        return;
      }
      const headers = {
        'Content-Type': asset.contentType,
        'Content-Length': String(asset.size),
        // pdf.js 的 worker/cmaps 体积大且版本固定，允许长缓存（版本变化会换 URL 前缀）
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      };
      res.writeHead(200, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(asset.abs);
      stream.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
      stream.pipe(res);
    },
    exists: () => Boolean(root) && existsSync(join(root, 'build', 'pdf.mjs')),
  };
}
