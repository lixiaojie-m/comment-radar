import { fetchJson, stripHtml, truncate, sleep, dedupeById } from '../util.js';

export const id = 'toutiao';
export const label = '今日头条';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 从 `data: {...}` 里取出第一个配平的 JSON 对象 */
function extractBalanced(text, from) {
  const start = text.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 头条搜索页把结果以「每条一个 data-for="ala-data" 的 script 块」内嵌进 HTML，
 * 卡片类型有六七种变体，只取各变体共有的 title/abstract/source/group_id。
 */
function parseCards(html) {
  const out = [];
  const re = /<script[^>]*data-for="ala-data"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    const dataAt = body.indexOf('data:');
    if (dataAt < 0) continue;
    const raw = extractBalanced(body, dataAt);
    if (!raw) continue;
    let card;
    try {
      card = JSON.parse(raw);
    } catch {
      continue;
    }
    const title = stripHtml(card.title || (card.display?.hits?.[0]?.title ?? '')).trim();
    const groupId = card.group_id || card.groupId;
    // 纯视频卡（热搜位）没有 group_id，也没有可评论的文章页，跳过
    if (!title || !groupId) continue;
    out.push({
      id: `toutiao:${groupId}`,
      platform: 'toutiao',
      type: 'article',
      title,
      author: String(card.source || '').trim(),
      url: `https://www.toutiao.com/article/${groupId}/`,
      summary: truncate(stripHtml(card.abstract || card.hot_board_summary || ''), 200),
      publishedAt: card.behot_time || card.create_time ? new Date((card.behot_time || card.create_time) * 1000).toISOString() : null,
      stats: {
        comments: card.comment_count ?? null,
        views: card.read_count ?? null,
        likes: card.digg_count ?? null,
      },
    });
  }
  return out;
}

export async function fetchSource(config) {
  const out = [];
  const errors = [];
  // 搜索页单次要拉近 2MB HTML，关键词太多既浪费带宽也更容易被限，只取前若干个
  const keywords = (config.keywords || []).slice(0, 6);

  for (const kw of keywords) {
    const url = `https://so.toutiao.com/search?keyword=${encodeURIComponent(kw)}&pd=synthesis`;
    try {
      const { res, text } = await fetchJson(
        url,
        { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', referer: 'https://so.toutiao.com/' } },
        { timeoutMs: 25_000 },
      );
      if (res.status !== 200 || !text.includes('ala-data')) {
        errors.push(`「${kw}」: HTTP ${res.status} 或无内嵌数据`);
        continue;
      }
      out.push(...parseCards(text));
    } catch (e) {
      errors.push(`「${kw}」: ${e.message}`);
    }
    await sleep(2500);
  }

  if (!out.length) throw new Error(`toutiao 未取到内容${errors.length ? '：' + errors.join('；') : ''}`);
  return dedupeById(out);
}
