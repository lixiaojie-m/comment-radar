import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(ROOT, 'config.json');

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

const example = readJson(path.join(ROOT, 'config.example.json'), {});
let config = deepMerge(example, readJson(CONFIG_FILE, {}));

// 抓取间隔只保留四档；旧配置里的 10/30/240 分钟等值归一到最接近的档位，
// 避免设置页下拉里没有匹配项时静默变成第一档
export const INTERVAL_CHOICES = [360, 720, 1440, 10080];
const nearestInterval = (v) => {
  const n = Number(v);
  if (INTERVAL_CHOICES.includes(n)) return n;
  if (!Number.isFinite(n) || n <= 0) return 1440;
  return INTERVAL_CHOICES.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a), INTERVAL_CHOICES[0]);
};
config.fetchIntervalMinutes = nearestInterval(config.fetchIntervalMinutes);

if (!fs.existsSync(CONFIG_FILE)) {
  writeJsonAtomic(CONFIG_FILE, config);
} else if (readJson(CONFIG_FILE, {}).fetchIntervalMinutes !== config.fetchIntervalMinutes) {
  // 旧档位已在内存里归一，同步写回文件，避免每次启动重复换算
  writeJsonAtomic(CONFIG_FILE, config);
}

export const rootDir = () => ROOT;
export const getConfig = () => config;
export const llmConfigured = () => Boolean(config.llm && config.llm.apiKey);

const EDITABLE_KEYS = [
  'keywords', 'sources', 'scoreThreshold', 'fetchIntervalMinutes', 'paused',
  'lookbackDays', 'maxPerKeyword', 'productContext', 'playbook', 'password', 'llm',
];

export function updateConfig(patch) {
  const next = {};
  for (const k of EDITABLE_KEYS) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  if (next.fetchIntervalMinutes !== undefined) next.fetchIntervalMinutes = nearestInterval(next.fetchIntervalMinutes);
  // 空密码 / 空 key 视为"不修改"，避免设置页把已有密钥抹掉
  if (next.password === '') delete next.password;
  if (next.llm && next.llm.apiKey === '') next.llm = { ...config.llm, ...next.llm, apiKey: config.llm.apiKey };
  config = deepMerge(config, next);
  writeJsonAtomic(CONFIG_FILE, config);
  return config;
}

export function publicConfig() {
  return {
    keywords: config.keywords,
    sources: config.sources,
    paused: Boolean(config.paused),
    scoreThreshold: config.scoreThreshold,
    fetchIntervalMinutes: config.fetchIntervalMinutes,
    lookbackDays: config.lookbackDays,
    maxPerKeyword: config.maxPerKeyword,
    productContext: config.productContext,
    playbook: config.playbook,
    llm: {
      baseUrl: config.llm?.baseUrl || '',
      model: config.llm?.model || '',
      disableThinking: config.llm?.disableThinking !== false,
      keySet: Boolean(config.llm?.apiKey),
    },
  };
}
