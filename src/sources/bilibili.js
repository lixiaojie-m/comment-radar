import { fetchJson, stripHtml, unescapeHtml, truncate, sleep, dedupeById } from '../util.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const id = 'bilibili';
export const label = 'B 站';

// 搜索接口需要 buvid3 等匿名 cookie，首次（或失效时）访问首页获取
let cookie = null;
let cookieAt = 0;

async function ensureCookie(force = false) {
  if (!force && cookie && Date.now() - cookieAt < 86_400_000) return cookie;
  const { res } = await fetchJson('https://www.bilibili.com', { headers: { 'user-agent': UA } }, { timeoutMs: 15_000 });
  const jars =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
  const pairs = jars.map((c) => c.split(';')[0]).filter((c) => /^(buvid3|b_nut|b_lsid|_uuid)=/.test(c));
  if (!pairs.length) throw new Error('无法获取 bilibili 匿名 cookie');
  cookie = pairs.join('; ');
  cookieAt = Date.now();
  return cookie;
}

export async function fetchSource(config) {
  const out = [];
  const errors = [];
  const lookbackMs = (config.lookbackDays || 14) * 86_400_000;

  for (const kw of config.keywords || []) {
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&order=pubdate&page=1&keyword=${encodeURIComponent(kw)}`;
    let data = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 3 && !data; attempt++) {
      try {
        const ck = await ensureCookie(attempt > 0);
        const { json } = await fetchJson(
          url,
          { headers: { 'user-agent': UA, referer: 'https://search.bilibili.com/', cookie: ck } },
          { timeoutMs: 15_000 },
        );
        if (json && json.code === 0 && json.data) {
          data = json.data;
        } else {
          lastErr = new Error(`code=${json?.code ?? '非JSON'} ${json?.message || ''}`);
          await ensureCookie(true);
        }
      } catch (e) {
        lastErr = e;
      }
    }
    if (!data) {
      errors.push(`「${kw}」: ${lastErr?.message || '未知错误'}`);
      continue;
    }
    for (const r of (data.result || []).slice(0, config.maxPerKeyword || 8)) {
      const pubMs = (r.pubdate || 0) * 1000;
      if (Date.now() - pubMs > lookbackMs) continue;
      if (!r.aid || !r.bvid) continue;
      out.push({
        id: `bilibili:${r.aid}`,
        platform: 'bilibili',
        type: 'video',
        title: unescapeHtml(String(r.title || '').replace(/<[^>]*>/g, '')).trim(),
        author: r.author || '',
        url: `https://www.bilibili.com/video/${r.bvid}`,
        summary: truncate(stripHtml(r.description || ''), 200),
        publishedAt: pubMs ? new Date(pubMs).toISOString() : null,
        stats: { views: r.play ?? null, comments: r.review ?? null },
      });
    }
    await sleep(1200 + Math.random() * 800); // 搜索接口礼貌间隔
  }

  if (!out.length && errors.length) throw new Error(`bilibili 全部关键词失败：${errors.join('；')}`);
  return dedupeById(out);
}
