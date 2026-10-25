import { fetchJson, truncate, sleep, dedupeById } from '../util.js';

export const id = 'hackernews';
export const label = 'Hacker News';

export async function fetchSource(config) {
  const out = [];
  const since = Math.floor((Date.now() - (config.lookbackDays || 14) * 86_400_000) / 1000);
  for (const kw of config.keywords || []) {
    const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=created_at_i>${since},points>2&query=${encodeURIComponent(kw)}`;
    try {
      const { json } = await fetchJson(url, {}, { timeoutMs: 15_000 });
      for (const h of (json?.hits || []).slice(0, config.maxPerKeyword || 8)) {
        out.push({
          id: `hn:${h.objectID}`,
          platform: 'hackernews',
          type: 'story',
          title: h.title || h.story_title || '',
          author: h.author || '',
          url: `https://news.ycombinator.com/item?id=${h.objectID}`,
          summary: truncate(h.story_text || h.comment_text || '', 200),
          publishedAt: h.created_at ? new Date(h.created_at + 'Z').toISOString() : null,
          stats: { points: h.points ?? null, comments: h.num_comments ?? null },
        });
      }
    } catch (e) {
      if (!out.length) throw e;
    }
    await sleep(300);
  }
  return dedupeById(out);
}
