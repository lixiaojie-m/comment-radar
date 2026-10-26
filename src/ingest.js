import { fetchJson, truncate, unescapeHtml } from './util.js';

/**
 * 抖音、小红书这类平台的详情页服务端拿不到任何内容（抖音返回 JS 壳，小红书跳登录），
 * 只能由用户把看到的内容手动投递进来。这里在可行时尽量补齐标题和摘要。
 */

export const PLATFORMS = [
  { id: 'douyin', label: '抖音', hosts: ['douyin.com', 'iesdouyin.com', 'v.douyin.com'] },
  { id: 'xiaohongshu', label: '小红书', hosts: ['xiaohongshu.com', 'xhslink.com'] },
  { id: 'toutiao', label: '今日头条', hosts: ['toutiao.com'] },
  { id: 'bilibili', label: 'B 站', hosts: ['bilibili.com', 'b23.tv'] },
  { id: 'zhihu', label: '知乎', hosts: ['zhihu.com'] },
  { id: 'manual', label: '手动', hosts: [] },
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function detectPlatform(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'manual';
  }
  const hit = PLATFORMS.find((p) => p.hosts.some((h) => host === h || host.endsWith('.' + h)));
  return hit ? hit.id : 'manual';
}

// 只有这些短链域名才值得跟一次 302；普通链接一旦跟随重定向，
// 可能被平台跳到 404/登录页，把用户投递的原始地址污染掉
const SHORT_LINK_HOSTS = ['v.douyin.com', 'xhslink.com', 'b23.tv', 't.cn'];

/** 短链先跟一次 302 拿到真实地址；其他链接原样返回 */
async function resolveUrl(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
  if (!SHORT_LINK_HOSTS.includes(host)) return url;
  try {
    const { res } = await fetchJson(url, { redirect: 'follow', headers: { 'user-agent': UA } }, { timeoutMs: 12_000 });
    return res.url || url;
  } catch {
    return url;
  }
}

function pickMeta(html, names) {
  for (const name of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
    const m = html.match(re);
    if (m && m[1]) return unescapeHtml(m[1]);
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i');
    const m2 = html.match(re2);
    if (m2 && m2[1]) return unescapeHtml(m2[1]);
  }
  return '';
}

/** 尽力抓取标题与摘要；抓不到返回空，由用户手填兜底 */
export async function enrichFromUrl(url) {
  const finalUrl = await resolveUrl(url);
  let title = '';
  let summary = '';
  try {
    const { text } = await fetchJson(
      finalUrl,
      { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' } },
      { timeoutMs: 15_000 },
    );
    title = pickMeta(text, ['og:title', 'twitter:title']).trim();
    summary = truncate(pickMeta(text, ['og:description', 'description', 'twitter:description']).trim(), 200);
    if (!title) {
      const m = text.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
      if (m) title = unescapeHtml(m[1]).trim();
    }
  } catch {
    // 平台挡住就交给用户填
  }
  return { finalUrl, title, summary };
}
