import { store, flush } from './store.js';
import { getConfig, llmConfigured } from './config.js';
import * as bilibili from './sources/bilibili.js';
import * as zhihu from './sources/zhihu.js';
import * as toutiao from './sources/toutiao.js';
import * as hackernews from './sources/hackernews.js';
import { scoreBatch, draftOne } from './llm.js';
import { sleep } from './util.js';

const SOURCES = { bilibili, zhihu, toutiao, hackernews };

/** 单条走完评分+起草，供手动投递使用 */
export async function scoreAndDraftOne(item) {
  const cfg = getConfig();
  if (!llmConfigured()) {
    item.status = 'unscored';
    flush();
    return item;
  }
  const [r] = await scoreBatch([item]);
  item.score = Math.max(0, Math.min(1, Number(r.score) || 0));
  item.angle = r.angle || '';
  item.scoreReason = r.reason || '';
  if (item.score < (cfg.scoreThreshold ?? 0.6)) {
    item.status = 'low_score';
    flush();
    return item;
  }
  try {
    item.draft = await draftOne(item, [...store.recentDrafts(6), ...store.otherDrafts(item.id, 8)]);
    item.status = 'pending';
  } catch {
    item.status = 'unscored';
  }
  flush();
  return item;
}

let running = false;
export const isRunning = () => running;

/**
 * 抓取 → 去重入库 → LLM 评分 → 达标条目起草 → 进入待审队列。
 * 任一环节失败只降级不中断：源失败记录在 run.sources，LLM 失败条目标记 unscored 下轮重试。
 */
export async function runPipeline(trigger = 'manual') {
  if (running) return { skipped: true, reason: '已有抓取在进行中' };
  if (getConfig().paused) return { skipped: true, reason: '已暂停，先到设置页恢复' };
  running = true;
  const cfg = getConfig();
  const run = { at: new Date().toISOString(), trigger, sources: {}, added: 0, scored: 0, drafted: 0, errors: [] };
  try {
    const fetched = [];
    for (const [key, src] of Object.entries(SOURCES)) {
      if (!cfg.sources || !cfg.sources[key]) continue;
      try {
        const items = await src.fetchSource(cfg);
        run.sources[key] = { ok: true, count: items.length };
        fetched.push(...items);
      } catch (e) {
        run.sources[key] = { ok: false, error: String(e.message || e) };
      }
    }

    const fresh = store.upsert(fetched);
    // 之前因 LLM 不可用而未评分的条目，这轮一并补上（避免一次配置好 key 后出现真空期）
    const backlog = [...store.list({ status: 'new' }), ...store.list({ status: 'unscored' })]
      .filter((it) => !fresh.includes(it))
      .slice(0, 30);
    const candidates = [...fresh, ...backlog];
    run.added = fresh.length;

    if (llmConfigured() && candidates.length) {
      const threshold = cfg.scoreThreshold ?? 0.6;
      for (let i = 0; i < candidates.length; i += 12) {
        const chunk = candidates.slice(i, i + 12);
        try {
          const scores = await scoreBatch(chunk);
          for (const s of scores) {
            const it = store.get(s.id);
            if (!it) continue;
            it.score = Math.max(0, Math.min(1, Number(s.score) || 0));
            it.angle = s.angle || '';
            it.scoreReason = s.reason || '';
            it.status = it.score >= threshold ? 'drafting' : 'low_score';
            run.scored++;
          }
        } catch (e) {
          run.errors.push(`评分批次失败: ${e.message}`);
          for (const c of chunk) {
            const it = store.get(c.id);
            if (it && (it.status === 'new' || it.status === 'drafting')) it.status = 'unscored';
          }
        }
      }

      // 避雷列表随本批生成滚进滚出，否则同一轮的草稿彼此不知道对方存在，结构会撞
      const avoid = store.recentDrafts(8);
      const toDraft = candidates
        .map((c) => store.get(c.id))
        .filter((it) => it && it.status === 'drafting');
      for (const it of toDraft) {
        try {
          it.draft = await draftOne(it, avoid);
          avoid.push(it.draft);
          if (avoid.length > 14) avoid.shift();
          it.status = 'pending';
          run.drafted++;
          await sleep(600);
        } catch (e) {
          run.errors.push(`草稿失败(${it.id}): ${e.message}`);
          it.status = 'unscored';
        }
      }
    } else if (candidates.length) {
      for (const c of candidates) {
        const it = store.get(c.id);
        if (it && it.status === 'new') it.status = 'unscored';
      }
    }

    store.addRun(run);
    flush();
    return run;
  } finally {
    running = false;
  }
}
