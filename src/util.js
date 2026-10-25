import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const nowIso = () => new Date().toISOString();
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomHex = (n = 8) => crypto.randomBytes(n).toString('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function unescapeHtml(s = '') {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([\w#]+);/g, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

export const stripHtml = (s = '') => unescapeHtml(String(s).replace(/<[^>]*>/g, ''));
export const truncate = (s = '', n = 300) => (String(s).length > n ? String(s).slice(0, n) + '…' : s);

export function dedupeById(items) {
  const seen = new Set();
  return items.filter((it) => {
    if (!it.id || seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj));
  try {
    fs.renameSync(tmp, file);
  } catch {
    // 单文件 bind mount 上 rename 目标是挂载点，会 EBUSY；降级为直接覆写
    fs.writeFileSync(file, JSON.stringify(obj));
    fs.rmSync(tmp, { force: true });
  }
}

export async function fetchJson(url, options = {}, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 反爬返回 HTML 页面等，保持 json = null，由调用方处理
    }
    return { res, json, text };
  } finally {
    clearTimeout(t);
  }
}
