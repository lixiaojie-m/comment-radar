import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { sha256, randomHex } from './util.js';
import { getConfig, updateConfig, publicConfig, llmConfigured, rootDir } from './config.js';
import { store, flush } from './store.js';
import { runPipeline, isRunning } from './pipeline.js';
import { startScheduler } from './scheduler.js';
import { draftOne } from './llm.js';
import * as bilibili from './sources/bilibili.js';
import * as zhihu from './sources/zhihu.js';
import * as hackernews from './sources/hackernews.js';

const SOURCE_LABELS = { bilibili: bilibili.label, zhihu: zhihu.label, hackernews: hackernews.label };
const PUBLIC_DIR = path.join(rootDir(), 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// 会话 token 由密码派生：改密码后所有已登录会话即时失效
const tokenFor = () => sha256(getConfig().password + '::comment-radar');

// 批量重生草稿的后台任务状态，null 表示没跑过
let redraftJob = null;
const redraftBusy = () => Boolean(redraftJob && !redraftJob.finishedAt);

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function readBody(req, cap = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) {
        reject(new Error('body 过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('body 不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, data, headers = {}) {
  const isBuf = Buffer.isBuffer(data);
  const body = isBuf ? data : typeof data === 'string' ? data : JSON.stringify(data);
  const contentType = isBuf || typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8';
  res.writeHead(status, { 'content-type': contentType, ...headers });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  file = path.normalize(file).replace(/^([/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, { error: '禁止' });
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not Found' });
    const ext = path.extname(full).toLowerCase();
    send(res, 200, buf, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
  });
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (method === 'POST' && pathname === '/api/login') {
    const body = await readBody(req);
    if (String(body.password || '') === getConfig().password) {
      return send(res, 200, { ok: true }, { 'set-cookie': `cr_token=${tokenFor()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` });
    }
    return send(res, 401, { error: '密码错误' });
  }

  if (parseCookies(req).cr_token !== tokenFor()) {
    return send(res, 401, { error: '未登录' });
  }

  if (method === 'GET' && pathname === '/api/items') {
    const status = url.searchParams.get('status') || undefined;
    const platform = url.searchParams.get('platform') || 'all';
    const items = store.list({ status, platform, limit: Number(url.searchParams.get('limit')) || 300 });
    return send(res, 200, { items, counts: store.counts(), running: isRunning(), redraftJob, lastRun: store.lastRun() });
  }

  let m;
  if (method === 'PATCH' && (m = pathname.match(/^\/api\/items\/(.+)$/))) {
    const body = await readBody(req);
    const patch = {};
    if (typeof body.draft === 'string') patch.draft = body.draft.trim();
    if (body.status && ['pending', 'posted', 'discarded'].includes(body.status)) {
      patch.status = body.status;
      if (body.status === 'posted') {
        patch.editedDraft = undefined; // 以当前 draft 为准
        patch.decidedAt = new Date().toISOString();
      } else if (body.status === 'discarded') {
        patch.decidedAt = new Date().toISOString();
      } else {
        patch.decidedAt = null;
      }
    }
    const it = store.update(decodeURIComponent(m[1]), patch);
    if (!it) return send(res, 404, { error: '条目不存在' });
    return send(res, 200, { item: it, counts: store.counts() });
  }

  if (method === 'POST' && (m = pathname.match(/^\/api\/items\/(.+)\/redraft$/))) {
    const it = store.get(decodeURIComponent(m[1]));
    if (!it) return send(res, 404, { error: '条目不存在' });
    if (!llmConfigured()) return send(res, 400, { error: '未配置 LLM key，请到设置页填写' });
    try {
      const avoid = [...store.recentDrafts(8), ...(it.draft ? [it.draft] : [])];
      it.draft = await draftOne(it, avoid);
      store.update(it.id, {});
      return send(res, 200, { item: it });
    } catch (e) {
      return send(res, 502, { error: `生成失败：${e.message}` });
    }
  }

  // 批量重生：改完话术库/prompt 后把存量草稿整体重写一遍
  if (method === 'POST' && pathname === '/api/redraft-all') {
    if (!llmConfigured()) return send(res, 400, { error: '未配置 LLM key，请到设置页填写' });
    if (redraftBusy()) return send(res, 409, { error: '批量生成进行中，请等它跑完' });
    const body = await readBody(req);
    const status = body.status === 'unscored' ? 'unscored' : 'pending';
    const targets = store.list({ status, limit: 500 }).map((it) => it.id);
    if (!targets.length) return send(res, 200, { total: 0 });

    redraftJob = { total: targets.length, done: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null };
    const job = redraftJob;
    (async () => {
      const avoid = store.recentDrafts(8);
      for (const id of targets) {
        const it = store.get(id);
        if (!it) {
          job.done++;
          continue;
        }
        try {
          it.draft = await draftOne(it, avoid);
          avoid.push(it.draft);
          if (avoid.length > 14) avoid.shift();
          if (it.status !== 'pending') it.status = 'pending';
          job.done++;
        } catch {
          job.failed++;
          job.done++;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      job.finishedAt = new Date().toISOString();
      flush();
    })().catch(() => {
      job.finishedAt = new Date().toISOString();
    });

    return send(res, 202, { started: true, total: targets.length });
  }

  if (method === 'POST' && pathname === '/api/run') {    if (isRunning()) return send(res, 409, { error: '已有抓取在进行中' });
    const runP = runPipeline('manual');
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 240_000));
    try {
      const run = await Promise.race([runP, timeout]);
      return send(res, 200, { run, counts: store.counts() });
    } catch (e) {
      return send(res, 202, { accepted: true, note: '抓取耗时较长，请稍后刷新查看结果' });
    }
  }

  if (method === 'GET' && pathname === '/api/status') {
    const last = store.lastRun();
    const sources = {};
    for (const [key, label] of Object.entries(SOURCE_LABELS)) {
      sources[key] = { label, enabled: Boolean(getConfig().sources?.[key]), ...(last?.sources?.[key] || {}) };
    }
    const key = getConfig().llm?.apiKey || '';
    return send(res, 200, {
      running: isRunning(),
      lastRun: last,
      counts: store.counts(),
      sources,
      redraftJob,
      llm: { configured: llmConfigured(), baseUrl: getConfig().llm?.baseUrl, model: getConfig().llm?.model, keyMasked: key ? key.slice(0, 4) + '****' + key.slice(-2) : '' },
      fetchIntervalMinutes: getConfig().fetchIntervalMinutes,
    });
  }

  if (method === 'GET' && pathname === '/api/config') {
    return send(res, 200, publicConfig());
  }

  if (method === 'PUT' && pathname === '/api/config') {
    const body = await readBody(req);
    const patch = {};
    for (const k of ['keywords', 'sources', 'scoreThreshold', 'fetchIntervalMinutes', 'lookbackDays', 'maxPerKeyword', 'productContext', 'playbook', 'password', 'llm']) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    updateConfig(patch);
    return send(res, 200, publicConfig());
  }

  if (method === 'GET' && pathname === '/api/export') {
    flush();
    const raw = fs.readFileSync(path.join(rootDir(), 'data', 'store.json'));
    return send(res, 200, raw, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="comment-radar-${new Date().toISOString().slice(0, 10)}.json"`,
    });
  }

  return send(res, 404, { error: '接口不存在' });
}

const port = Number(getConfig().port) || 8787;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[comment-radar] listening on http://0.0.0.0:${port} (token ${randomHex(4)}-${randomHex(2)})`);
});

startScheduler();
setInterval(() => store.prune(), 24 * 3600_000).unref();
