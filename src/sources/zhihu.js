import { fetchJson, stripHtml, truncate } from '../util.js';

export const id = 'zhihu';
export const label = '知乎热榜';

// 知乎热榜 Web API 已要求登录，移动端 API 仍可匿名只读
const UA = 'osee2unifiedRelease/23.30.1 (iPhone; iOS 17.4; Scale/3.00)';

export async function fetchSource() {
  const { json } = await fetchJson(
    'https://api.zhihu.com/topstory/hot-list?limit=50',
    { headers: { 'user-agent': UA } },
    { timeoutMs: 15_000 },
  );
  if (!json || !Array.isArray(json.data)) throw new Error('知乎热榜返回异常');
  return json.data
    .map((d) => {
      const q = d.target || {};
      return {
        id: `zhihu:q${q.id}`,
        platform: 'zhihu',
        type: 'question',
        title: stripHtml(q.title || '').trim(),
        author: '',
        url: `https://www.zhihu.com/question/${q.id}`,
        summary: truncate(stripHtml(d.card_string || q.content_excerpt || ''), 200),
        publishedAt: null,
        stats: { heat: d.detail_text ? Number(String(d.detail_text).replace(/\D/g, '')) || null : null },
      };
    })
    .filter((it) => it.title);
}
