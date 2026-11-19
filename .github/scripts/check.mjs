// CI 基本檢查（只用 Node 內建模組，不需安裝任何套件）
// 1. TodoMaster.html 內每段 <script> 與 sw.js 的 JS 語法
// 2. manifest.json 是合法 JSON
// 3. <title>、APP_VERSION、sw.js 的 CACHE_NAME 三者版本一致（README「版本管理規範」）
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const errors = [];
const read = f => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

// 只編譯不執行：語法錯誤會丟 SyntaxError
function checkSyntax(code, label, lineOffset = 0) {
  try {
    new vm.Script(code, { filename: label, lineOffset });
  } catch (e) {
    const where = (e.stack || '').split('\n').slice(0, 3).filter(l => l.trim()).join('\n  ');
    errors.push(`${label}: JS 語法錯誤 → ${e.message}\n  ${where}`);
  }
}

const html = read('TodoMaster.html');
const sw = read('sw.js');

// --- 1. JS 語法 ---
const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m, count = 0;
while ((m = scriptRe.exec(html))) {
  const attrs = m[1];
  if (/\bsrc\s*=/.test(attrs)) continue;                       // 外部腳本
  const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
  if (type && !/^(text\/javascript|application\/javascript)$/i.test(type)) continue;
  const startLine = html.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length;
  checkSyntax(m[2], 'TodoMaster.html', startLine - 1);
  count++;
}
if (count === 0) errors.push('TodoMaster.html: 找不到任何 <script>，檢查腳本可能需要更新');
checkSyntax(sw, 'sw.js');

// --- 2. manifest.json ---
try { JSON.parse(read('manifest.json')); }
catch (e) { errors.push(`manifest.json: 不是合法 JSON → ${e.message}`); }

// --- 3. 版本一致 ---
const appVersion = (html.match(/const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
const titleVersion = (html.match(/<title>\s*TodoMaster\s+(v[\d.]+)/) || [])[1];
const cacheName = (sw.match(/const\s+CACHE_NAME\s*=\s*['"]([^'"]+)['"]/) || [])[1];

if (!appVersion) errors.push('TodoMaster.html: 找不到 APP_VERSION');
if (!titleVersion) errors.push('TodoMaster.html: <title> 找不到版本號（預期格式「TodoMaster vX.Y.Z ...」）');
if (!cacheName) errors.push('sw.js: 找不到 CACHE_NAME');
if (appVersion && cacheName && cacheName !== `todomaster-${appVersion}`)
  errors.push(`版本不一致：sw.js CACHE_NAME = '${cacheName}'，應為 'todomaster-${appVersion}'（APP_VERSION = '${appVersion}'）`);
if (appVersion && titleVersion && titleVersion !== appVersion)
  errors.push(`版本不一致：<title> 是 ${titleVersion}，APP_VERSION 是 ${appVersion}`);

if (errors.length) {
  console.error(`❌ ${errors.length} 項檢查失敗：\n`);
  errors.forEach(e => console.error(`- ${e}\n`));
  process.exit(1);
}
console.log(`✅ 全部通過：${count} 段 <script> + sw.js 語法正確；manifest.json 合法；版本 ${appVersion}（<title>／APP_VERSION／CACHE_NAME 一致）`);
