import { getConfig, llmConfigured } from './config.js';
import { fetchJson, sleep, truncate } from './util.js';

/** OpenAI 兼容 chat 调用，带超时与 429/5xx 重试 */
async function chat(messages, { json = false, temperature = 0.7, maxTokens = 1200 } = {}) {
  const cfg = getConfig().llm;
  const body = { model: cfg.model, messages, temperature, max_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { res, json: data } = await fetchJson(
        String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify(body),
        },
        { timeoutMs: 90_000 },
      );
      if (!data) throw new Error(`LLM HTTP ${res.status}`);
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error).slice(0, 120));
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error('LLM 空响应');
      return text;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

function parseJsonLoose(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** 批量评分：返回 [{id, score, angle, reason}] */
export async function scoreBatch(items) {
  const cfg = getConfig();
  const list = items.map((it) => ({
    id: it.id,
    平台: it.platform,
    标题: truncate(it.title, 80),
    摘要: truncate(it.summary || '', 120),
  }));
  const sys = `你是内容筛选助手。产品背景：${cfg.productContext}

对每条内容评估「在其评论区做干货式评论引流」的价值。评分标准：
- 0.9 以上：受众高度重合（AI 编码 / Agent / 开发效率），且内容天然适合补充真实体验或技巧
- 0.6~0.9：相关，可以评论
- 0.6 以下：弱相关、纯新闻、争议/敏感话题、或不适合评论

输出 JSON：{"results":[{"id":"原样返回id","score":0到1的小数,"angle":"切入点","reason":"一句话理由"}]}
angle 从这些里选或自拟：真实体验补充、技巧补充、工具组合推荐、纠错补充、需求共鸣。
只输出 JSON，不要其他内容。`;
  const out = await chat(
    [
      { role: 'system', content: sys },
      { role: 'user', content: JSON.stringify(list) },
    ],
    { json: true, temperature: 0.2, maxTokens: 1600 },
  );
  const parsed = parseJsonLoose(out);
  const map = new Map((parsed.results || []).map((r) => [r.id, r]));
  return items.map((it) => map.get(it.id) || { id: it.id, score: 0, angle: '', reason: '未返回评分' });
}

/** 单条起草：avoidDrafts 是最近已发布评论，用于保证多样性 */
export async function draftOne(item, avoidDrafts = []) {
  const cfg = getConfig();
  const pb = cfg.playbook || {};
  const sys = `你是帮团队写评论区回复的助手。产品：${cfg.productContext}

评论纪律（必须全部遵守）：
${(pb.discipline || []).map((d, i) => `${i + 1}. ${d}`).join('\n')}

参考话术风格示例（只学语气和结构，禁止照抄）：
${(pb.examples || []).map((e) => `- ${e}`).join('\n')}

直接输出一条中文评论正文，不要任何解释、引号或前后缀。`;
  let avoid = '';
  if (avoidDrafts.length) {
    avoid = `\n\n以下是最近已发布过的评论，新评论的句式和切入必须与它们明显不同：\n${avoidDrafts
      .map((d) => `- ${truncate(d, 80)}`)
      .join('\n')}`;
  }
  const user = `平台：${item.platform}（${item.type}）\n标题：${item.title}\n内容摘要：${truncate(
    item.summary || '（无摘要）',
    200,
  )}\n建议切入点：${item.angle || '真实体验补充'}${avoid}`;
  const out = await chat(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    { temperature: 0.9, maxTokens: 500 },
  );
  return out.trim();
}

export { llmConfigured };
