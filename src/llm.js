import { getConfig, llmConfigured } from './config.js';
import { fetchJson, sleep, truncate } from './util.js';

// 有的 provider 不认 thinking 字段，首次被拒后本次进程内不再发送
let thinkingSupported = true;

/**
 * OpenAI 兼容 chat 调用，带超时与 429/5xx 重试。
 *
 * DeepSeek 把 deepseek-chat 路由到了思考模型（返回 model=deepseek-flash 且带 reasoning_content），
 * 思考过程会先吃掉 max_tokens 预算：约束越多思考越长，正文越容易为空。起草这类任务不需要推理，
 * 默认关掉思考；预算被撑满时也会自动关掉重试。
 */
async function chat(messages, { json = false, temperature = 0.7, maxTokens = 1200, _retry = 0 } = {}) {
  const cfg = getConfig().llm;
  const body = { model: cfg.model, messages, temperature, max_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };
  if (cfg.disableThinking !== false && thinkingSupported) body.thinking = { type: 'disabled' };

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
      if (data.error) {
        const msg = String(data.error.message || JSON.stringify(data.error)).slice(0, 120);
        // 该接口不认 thinking 参数：降级去掉再试
        if (body.thinking && /thinking|unknown|unsupported|invalid/i.test(msg)) {
          thinkingSupported = false;
          return chat(messages, { json, temperature, maxTokens, _retry });
        }
        throw new Error(msg);
      }

      const choice = data.choices?.[0];
      const text = choice?.message?.content ?? '';
      const reasoning = choice?.message?.reasoning_content ?? '';

      if (choice?.finish_reason === 'length' && maxTokens < 4000 && _retry < 2) {
        return chat(messages, { json, temperature, maxTokens: maxTokens * 2, _retry: _retry + 1 });
      }
      // 正文被思考过程挤空：确认模型会先思考，关掉后重试
      if (!text && reasoning && _retry < 2) {
        thinkingSupported = false;
        return chat(messages, { json, temperature, maxTokens, _retry: _retry + 1 });
      }
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

// 中文 AI 文本的高频痕迹词，出现在评论区立刻露馅
const AI_TELL_WORDS = [
  '其实', '确实', '这块', '那套', '沉淀', '闭环', '赋能', '抓手', '干货',
  '省事', '省心', '丝滑', '优雅', '神器', '宝藏', '一键', '码住', '亲测',
  '值得', '建议', '本质上', '核心在于', '颗粒度', '维度', '层面', '组合拳',
  '性价比', '这套玩法', '事半功倍', '事半功倍',
];

// ★ 真实感的关键：真人评论一般不完整、不总结、不做广告收尾
const buildStyleRules = (minLen, maxLen) => `1. 长度必须落在 ${minLen}~${maxLen} 字之间（含标点），这是硬性要求，超出范围会被打回重写。宁可短。
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

const STYLE_EXAMPLES = `（左边是 AI 味，右边是真人；学右边，绝不学左边）

AI：「这个 skill 我试了下，脚本逐帧渲染那套确实稳，比让模型直接吐视频靠谱多了。补充个思路：这种代码型 skill 很适合沉淀成团队资产，省下的时间够多打磨两个新技能了。」
真人：「逐帧渲染这招我服，不过我 1080p 跑一分钟要四十分钟」

AI：「技能变现这块我试过一阵，光有想法不行，得有靠谱的工具链支撑。」
真人：「变现我试过，卡点不在工具，在没人愿意掏钱」

AI：「多 agent 并行最怕的就是互相覆盖，我之前的笨办法是给每个 agent 单独开 Git 分支，合并前先 diff 一遍，能挡掉大部分冲突。」
真人：「八个 agent 改同一个文件，早上起来 30 个冲突，差点心梗」

AI：「看完最大的感受是，Stripe 快不是因为模型多强，而是把上下文沉淀下来了。」
真人：「在 Stripe 待过的朋友说他们内部文档比代码还多，挺反直觉的」

—— 带产品的真人写法（重点是"顺口一提"，不是"介绍功能"）——

AI 味：「我后来用 AISync 统一管理所有技能，跨平台自动同步，效率提升明显，强烈推荐。」
真人：「我也差不多，后来按 agent 分了目录，顺手丢 AISync 里，换机器直接拉回来」
更短：「改错文件我也踩过，现在都挂 AISync 了」`;

/** 单条起草：avoidDrafts 是最近已发评论，用于避开雷同句式 */
export async function draftOne(item, avoidDrafts = [], { allowProduct } = {}) {
  const cfg = getConfig();
  const pb = cfg.playbook || {};
  const rate = typeof pb.productMentionRate === 'number' ? pb.productMentionRate : 1;
  // 默认每条都带产品（引流目的），rate 调低才会出现纯干货条目
  const allow = allowProduct === undefined ? Math.random() < rate : Boolean(allowProduct);

  const minLen = Math.max(5, Number(pb.minLength) || 20);
  const maxLen = Math.max(minLen, Number(pb.maxLength) || 40);

  const productRule = allow
    ? `这条要带到产品，但必须是「真实用户在讲自己的做法时顺口提到」，不是推荐、不是介绍功能。

本次指定的提及方式（必须按这个来，不要用其他套路）：${MENTION_STYLES[Math.floor(Math.random() * MENTION_STYLES.length)]}

硬要求：
- 全篇只有 ${minLen}~${maxLen} 字，干货和产品都必须极度精简，产品那句最好五六个字带过
- 产品只出现在后半段，前面必须先有具体的干货或经历
- 只讲一个具体用法，绝不罗列功能
- 产品全名最多出现一次，说完就收，不要重复强调
- 绝对不能出现：统一管理、一键、自动同步、沉淀、资产、神器、强烈推荐、效率翻倍、值得一试、平替
- 读起来要像「我刚好在用，顺口提一句」，不是「我来安利」`
    : `这条不要提任何产品名，也不要暗示存在某个工具能解决。就写一条纯干货评论，把它当成你自己在评论区交朋友。`;

  const sys = `你在 B 站 / 知乎评论区用个人账号写评论。目标：看起来像一个真实用户在随手回复，不像运营号，也不像 AI。

产品背景（仅供你判断话题，不等于每次都要提）：${cfg.productContext}

写作硬约束：
${buildStyleRules(minLen, maxLen)}

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
  // 模型常把产品名写成小写，统一成规范写法（用前后非字母断言，避免动到 aisync.io 这类域名前缀）
  const normalizeName = (s) => (productName === 'AISync' ? s.replace(/(?<![A-Za-z])aisync(?![A-Za-z])/gi, 'AISync') : s);
  // 中文按字符数算，不能用 .length（emoji 等会算成 2）
  const charLen = (s) => [...s].length;

  // 字数和产品名都靠代码兜底：模型对长度约束的遵从度很低，只写在 prompt 里必然跑偏
  // 重试时把上一次的结果和偏差一起喂回去，让它定向压缩，比单纯重抽有效得多
  let conversation = messages;
  let best = null;
  let bestPenalty = Infinity;
  for (let attempt = 0; attempt < 4; attempt++) {
    const t = normalizeName((await chat(conversation, { temperature: 1, maxTokens: 800 })).trim().replace(/^["「『]|["」』]$/g, ''));
    const len = charLen(t);
    const missingProduct = allow && !t.toLowerCase().includes(productName.toLowerCase());
    const lengthPenalty = len < minLen ? minLen - len : len > maxLen ? len - maxLen : 0;
    const penalty = lengthPenalty + (missingProduct ? 100 : 0);
    if (penalty === 0) return t;
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = t;
    }

    if (attempt === 3) break;
    const advice = missingProduct
      ? `这条没有提到 ${productName}，必须在后半段用一句极短的话带上。`
      : len > maxLen
        ? `这条 ${len} 字，超了 ${len - maxLen} 字。砍掉铺垫、解释和第二个例子，只留一个最具体的细节加产品那句。`
        : `这条 ${len} 字，还差 ${minLen - len} 字，补充一个具体细节凑到范围内。`;
    conversation = [
      ...messages,
      { role: 'assistant', content: t },
      { role: 'user', content: `${advice}总长必须落在 ${minLen}~${maxLen} 字之间（含标点）。直接给改写后的评论正文，不要解释。` },
    ];
  }
  return best;
}

export { llmConfigured };
