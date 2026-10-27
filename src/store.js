import path from 'node:path';
import { readJson, writeJsonAtomic, nowIso } from './util.js';
import { rootDir } from './config.js';

const DATA_DIR = process.env.DATA_DIR || path.join(rootDir(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

const state = readJson(STORE_FILE, { items: [], runs: [] });
state.items = Array.isArray(state.items) ? state.items : [];
state.runs = Array.isArray(state.runs) ? state.runs : [];

const byId = new Map(state.items.map((it) => [it.id, it]));
let saveTimer = null;

function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 500);
}

export function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  state.items = [...byId.values()];
  writeJsonAtomic(STORE_FILE, state);
}

export const store = {
  has: (id) => byId.has(id),
  get: (id) => byId.get(id),

  /** 批量入库，返回首次出现的新条目；老条目只刷新热度数据 */
  upsert(items) {
    const fresh = [];
    for (const it of items) {
      const existed = byId.get(it.id);
      if (existed) {
        existed.stats = it.stats ?? existed.stats;
        continue;
      }
      const item = { status: 'new', ...it, firstSeenAt: nowIso() };
      byId.set(item.id, item);
      fresh.push(item);
    }
    if (items.length) persistSoon();
    return fresh;
  },

  update(id, patch) {
    const it = byId.get(id);
    if (!it) return null;
    Object.assign(it, patch);
    persistSoon();
    return it;
  },

  list({ status, platform, limit = 300 } = {}) {
    let arr = [...byId.values()];
    if (Array.isArray(status)) arr = arr.filter((i) => status.includes(i.status));
    else if (status) arr = arr.filter((i) => i.status === status);
    if (platform && platform !== 'all') arr = arr.filter((i) => i.platform === platform);
    arr.sort((a, b) => (b.firstSeenAt || '').localeCompare(a.firstSeenAt || ''));
    return arr.slice(0, limit);
  },

  counts() {
    const c = {};
    for (const it of byId.values()) c[it.status] = (c[it.status] || 0) + 1;
    return c;
  },

  addRun(run) {
    state.runs.push(run);
    if (state.runs.length > 50) state.runs.splice(0, state.runs.length - 50);
    persistSoon();
  },

  lastRun: () => state.runs[state.runs.length - 1] || null,

  /** 最近已发布的评论正文，用于让 LLM 避免生成雷同草稿 */
  recentDrafts(n = 8) {
    return [...byId.values()]
      .filter((i) => i.status === 'posted' && (i.editedDraft || i.draft))
      .sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || ''))
      .slice(0, n)
      .map((i) => i.editedDraft || i.draft);
  },

  /** 其他条目已有的草稿，单条重生时用来避免和邻居撞句式 */
  otherDrafts(excludeId, n = 8) {
    return [...byId.values()]
      .filter((i) => i.id !== excludeId && i.draft && i.status !== 'discarded')
      .sort((a, b) => (b.firstSeenAt || '').localeCompare(a.firstSeenAt || ''))
      .slice(0, n)
      .map((i) => i.draft);
  },

  prune(days = 45) {
    const cutoff = Date.now() - days * 86400_000;
    let removed = 0;
    for (const [id, it] of byId) {
      const t = Date.parse(it.firstSeenAt || '') || 0;
      const terminal = it.status === 'posted' || it.status === 'discarded' || it.status === 'low_score';
      if (terminal && t < cutoff) {
        byId.delete(id);
        removed++;
      }
    }
    if (removed) persistSoon();
  },
};
