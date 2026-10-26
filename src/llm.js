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
      const choice = data.choices?.[0];
      const text = choice?.message?.content;
      if (!text) throw new Error('LLM 空响应');
      // 被 token 上限截断的文本不能直接用，加倍预算重跑一次
      if (choice.finish_reason === 'length' && maxTokens < 4000) {
        return chat(messages, { json, temperature, maxTokens: maxTokens * 2 });
      }
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

// 中文 AI 文本的高频痕迹词，出现在评论区立刻露馅
const AI_TELL_WORDS = [
  '其实', '确实', '这块', '那套', '沉淀', '闭环', '赋能', '抓手', '干货',
  '省事', '省心', '丝滑', '优雅', '神器', '宝藏', '一键', '码住', '亲测',
  '值得', '建议', '本质上', '核心在于', '颗粒度', '维度', '层面', '组合拳',
  '性价比', '这套玩法', '事半功倍', '事半功倍',
];

// ★ 真实感的关键：真人评论一般不完整、不总结、不做广告收尾
const STYLE_RULES = `1. 长度：25~80 字是常态，最多 110 字。宁可短，短得像随手打的。
2. 不要写成「问题 → 方案 → 效果」的完整三段论。真人经常只吐槽一句、只补一个细节、只反问一句。
3. 必须出现至少一个具体到无法泛化的细节：具体报错、具体命令、具体版本号、具体文件、具体耗时、具体价格、具体踩过的坑。
4. 句式要松。允许断句、省略主语、用口语词（啊 / 嘛 / 吧 / 就 / 直接 / 硬是 / 反正），允许一句话没说完。
5. 不许总结升华。禁止「这步比 X 划算」「省下的时间够 X」「这才是本质」这类收尾。
6. 不用这些词：${AI_TELL_WORDS.join('、')}
7. 不用这些骨架开头或句式中段：
   - 「我之前也遇到过……后来发现……」
   - 「补充一个思路」「补充个思路」
   - 「XX 这块我试过」「XX 那套确实」
   - 「看完最大的感受是」
   - 「最怕的就是」
   - 「建议把……」
   - 「……性价比更高 / 更划算 / 值得一试」
8. 以下尾巴已经被用烂了，一条都不许出现：
   - 「就是 XX 那块还没用明白 / 没摸透 / 没用顺」
   - 「换机器不用重新调 / 换电脑直接拉回来 / 哪台机器都能调出来」
   - 「丢 XX 里存着 / 存一份 / 存了版」`;

// 每条随机分配一种产品提及方式，避免 81 条全收敛到同一个句式
const MENTION_STYLES = [
  '放在「我的做法」里陈述事实，只说做了什么，不评价好坏',
  '极短插入，产品那句不超过 12 个字，说完立刻回到原话题',
  '说明为什么用它（换机器 / 多设备 / 团队协作，挑一个最贴合本条内容的），不吹效果',
  '带一个具体的小限制：必须是具体功能点或具体场景，不能是「还没用明白」这种含糊话',
  '结尾顺带问对方一句相关的问题，但产品必须出现在问句之前，绝不能省略',
  '只提一次，放在句子中段做插入语，不要单独成句',
];

const STYLE_EXAMPLES = `（下面左边是 AI 味，右边是真人；学右边，绝不学左边）

AI：「这个 skill 我试了下，脚本逐帧渲染那套确实稳，比让模型直接吐视频靠谱多了。补充个思路：这种代码型 skill 很适合沉淀成团队资产，省下的时间够多打磨两个新技能了。」
真人：「逐帧渲染这招我服。不过我这边 1080p 一分钟要跑四十分钟，你用的什么卡」

AI：「技能变现这块我试过一阵，光有想法不行，得有靠谱的工具链支撑。」
真人：「变现这条路我试过，最后发现卡点根本不在工具，在没人愿意为 skill 掏钱」

AI：「多 agent 并行最怕的就是互相覆盖，我之前的笨办法是给每个 agent 单独开 Git 分支，合并前先 diff 一遍，能挡掉大部分冲突。」
真人：「八个 agent 同时改同一个文件，第二天早上看到 30 个冲突差点心梗。现在只敢让它们分目录干活」

AI：「看完最大的感受是，Stripe 快不是因为模型多强，而是把上下文沉淀下来了。」
真人：「在 Stripe 待过的朋友说他们内部文档比代码还多，新人第一周基本都在读文档，这点挺反直觉的」

—— 带产品的真人写法（重点是"顺口一提"，不是"介绍功能"）——

AI 味：「我后来用 AISync 统一管理所有技能，跨平台自动同步，效率提升明显，强烈推荐。」
真人：「我也差不多，两个 agent 来回改同一个配置，后面干脆按 agent 分了目录，顺手丢 AISync 里存着，换机器直接拉回来。就是团队共享那块还没用明白」`;

/** 单条起草：avoidDrafts 是最近已发评论，用于避开雷同句式 */
export async function draftOne(item, avoidDrafts = [], { allowProduct } = {}) {
  const cfg = getConfig();
  const pb = cfg.playbook || {};
  const rate = typeof pb.productMentionRate === 'number' ? pb.productMentionRate : 1;
  // 默认每条都带产品（引流目的），rate 调低才会出现纯干货条目
  const allow = allowProduct === undefined ? Math.random() < rate : Boolean(allowProduct);

  const productRule = allow
    ? `这条要带到产品，但必须是「真实用户在讲自己的做法时顺口提到」，不是推荐、不是介绍功能。

本次指定的提及方式（必须按这个来，不要用其他套路）：${MENTION_STYLES[Math.floor(Math.random() * MENTION_STYLES.length)]}

硬要求：
- 产品只出现在后半段，前面必须先有具体的干货或经历，且干货至少占一半篇幅
- 只讲一个具体用法，绝不罗列功能
- 产品全名最多出现一次，说完就收，不要重复强调
- 绝对不能出现：统一管理、一键、自动同步、沉淀、资产、神器、强烈推荐、效率翻倍、值得一试、平替
- 读起来要像「我刚好在用，顺口提一句」，不是「我来安利」`
    : `这条不要提任何产品名，也不要暗示存在某个工具能解决。就写一条纯干货评论，把它当成你自己在评论区交朋友。`;

  const sys = `你在 B 站 / 知乎评论区用个人账号写评论。目标：看起来像一个真实用户在随手回复，不像运营号，也不像 AI。

产品背景（仅供你判断话题，不等于每次都要提）：${cfg.productContext}

写作硬约束：
${STYLE_RULES}

真人感对照：
${STYLE_EXAMPLES}

本次产品提及规则：${productRule}

运营纪律（同时遵守）：
${(pb.discipline || []).map((d, i) => `${i + 1}. ${d}`).join('\n')}
${(pb.examples || []).length ? `\n团队积累过的真实口吻（只学语气，禁止照抄内容）：\n${(pb.examples || []).map((e) => `- ${e}`).join('\n')}\n` : ''}
直接输出评论正文，不要引号、不要解释、不要 markdown。`;

  let avoid = '';
  if (avoidDrafts.length) {
    avoid = `\n\n以下评论已经用过（含其他条目的草稿）。你的开头方式、产品那一句的写法、结尾方式都必须和它们不同，同一个表述不能再用第二次：\n${avoidDrafts
      .map((d) => `- ${String(d).trim()}`)
      .join('\n')}`;
  }
  const user = `平台：${item.platform}（${item.type}）\n标题：${item.title}\n内容摘要：${truncate(
    item.summary || '（无摘要）',
    200,
  )}\n（切入方向仅作参考，和内容不符就忽略：${item.angle || '无'}）${avoid}`;
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];

  const productName = String(pb.productName || 'AISync');
  let text = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    text = (await chat(messages, { temperature: 1, maxTokens: 600 })).trim().replace(/^["「『]|["」』]$/g, '');
    // prompt 管不住模型偶尔漏掉产品名，这里强制兜一层：没带上就重写
    if (!allow || text.includes(productName)) break;
  }
  return text;
}

export { llmConfigured };
