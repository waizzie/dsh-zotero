#!/usr/bin/env node
/**
 * 把 bridge/ 目录打成可安装的 Zotero 插件（.xpi）。
 *
 *   node bridge/build.mjs
 *   → bridge/dsh-zotero-bridge-<version>.xpi
 *
 * XPI 就是 ZIP，但 manifest.json 与 bootstrap.js 必须在**根**（不能套一层目录），
 * 否则 Zotero 报 "not a valid XPI"。这里手写最小 ZIP，避免依赖 zip 命令行工具
 * 或 PowerShell 执行策略。
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FILES = ['manifest.json', 'bootstrap.js'];

const manifestPath = join(here, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const version = manifest.version;
const out = join(here, `dsh-zotero-bridge-${version}.xpi`);

// ── CRC32 ────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// ── DOS 时间戳 ───────────────────────────────────────────────────────
function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

// ── 打包 ─────────────────────────────────────────────────────────────
const { time: dosTime, day: dosDay } = dosDateTime();
const locals = [];
const centrals = [];
let offset = 0;

for (const name of FILES) {
  const path = join(here, name);
  if (!existsSync(path)) throw new Error(`缺少必需文件: ${path}`);

  const raw = readFileSync(path);
  const deflated = deflateRawSync(raw, { level: 9 });
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // 签名
  local.writeUInt16LE(20, 4); // 解压所需版本
  local.writeUInt16LE(0, 6); // 标志
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDay, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra 长度

  locals.push(local, nameBuf, deflated);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // 创建版本
  central.writeUInt16LE(20, 6); // 解压所需版本
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDay, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // 起始磁盘
  central.writeUInt16LE(0, 36); // 内部属性
  central.writeUInt32LE(0, 38); // 外部属性
  central.writeUInt32LE(offset, 42); // 本地头偏移

  centrals.push(central, nameBuf);
  offset += local.length + nameBuf.length + deflated.length;
}

const centralBuf = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(FILES.length, 8);
eocd.writeUInt16LE(FILES.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

if (existsSync(out)) rmSync(out, { force: true });
writeFileSync(out, Buffer.concat([...locals, centralBuf, eocd]));

// ── 自检 ─────────────────────────────────────────────────────────────
const check = readFileSync(out);
if (check.readUInt32LE(0) !== 0x04034b50) throw new Error('打包失败：ZIP 头不正确');
const firstNameLen = check.readUInt16LE(26);
const firstName = check.subarray(30, 30 + firstNameLen).toString('utf8');
if (firstName !== 'manifest.json') {
  throw new Error(`打包失败：XPI 根目录第一个文件应为 manifest.json，实际为 ${firstName}`);
}

console.log(`已生成 ${out}`);
console.log(`  ${(check.length / 1024).toFixed(1)} KB，含 ${FILES.join(', ')}（均在 XPI 根）`);
