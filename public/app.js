/* 评论雷达前端：单页应用，无框架、无构建、无外部依赖（局域网服务器离线可用） */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

let view = localStorage.getItem('cr.view') || 'pending';
let platformFilter = 'all';
let itemsCache = [];
let statusCache = null;
let configCache = null;
let pollTimer = null;

/* ---------- 工具 ---------- */

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '';
  const v = Number(n);
  if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿';
  if (v >= 10000) return (v / 10000).toFixed(1) + '万';
  return String(v);
}

function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (Number.isNaN(s)) return '';
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}

function scoreTier(score) {
  if (score >= 0.8) return 's-high';
  if (score >= 0.6) return 's-mid';
  return 's-low';
}

const PF_LABEL = { bilibili: 'B站', zhihu: '知乎', hackernews: 'HN' };
const TYPE_LABEL = { video: '视频', question: '问题', story: '帖子' };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    renderLogin();
    throw new Error('未登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 局域网 http 下 navigator.clipboard 不可用，降级 execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 2400);
}

const LOGO = `<svg width="40" height="40" viewBox="0 0 32 32" aria-hidden="true">
  <circle cx="16" cy="16" r="13" fill="none" stroke="#5A4BE0" stroke-width="2" opacity=".22"/>
  <circle cx="16" cy="16" r="8" fill="none" stroke="#5A4BE0" stroke-width="2" opacity=".5"/>
  <circle cx="16" cy="16" r="3" fill="#5A4BE0"/>
  <circle cx="23" cy="9" r="3" fill="#FB7299"/>
</svg>`;

/* ---------- 登录 ---------- */

function renderLogin(err = '') {
  stopPolling();
  $('#app').innerHTML = `
    <div class="login-wrap">
      <div class="login-card" id="login-card">
        ${LOGO}
        <h1>评论雷达</h1>
        <p>内容监控 · AI 草稿 · 人工发布</p>
        <form id="login-form">
          <input type="password" id="login-pw" placeholder="访问密码" autocomplete="current-password" autofocus>
          <button class="btn btn-primary" type="submit" id="login-btn">进入</button>
          <div class="login-err">${escapeHtml(err)}</div>
        </form>
      </div>
    </div>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#login-pw').value }) });
      boot();
    } catch (ex) {
      const card = $('#login-card');
      card.classList.remove('shake');
      void card.offsetWidth;
      card.classList.add('shake');
      $('#login-btn').disabled = false;
      $('#login-btn').textContent = '进入';
      $('.login-err').textContent = ex.message || '密码错误';
    }
  });
}

/* ---------- 骨架 ---------- */

function renderShellSkeleton() {
  $('#app').innerHTML = `
    <div class="app-shell">
      <header class="topbar"><div class="brand">${LOGO}</div></header>
      <div class="layout"><main class="main"><div class="main-inner">
        ${'<div class="card skeleton"></div>'.repeat(3)}
      </div></main></div>
    </div>`;
}

/* ---------- 主框架 ---------- */

const VIEWS = {
  pending: { title: '待审队列', status: 'pending', desc: '确认草稿后打开原文手动发布，再回来标记「已发布」。频率和真实性靠自己把握。', icon: '◉' },
  unscored: { title: '未评分', status: 'unscored', desc: '已抓取但尚未评分的条目（LLM 未配置或评分失败时出现，配置好后点「立即抓取」补跑）。', icon: '◌' },
  posted: { title: '已发布', status: 'posted', desc: '已人工发布的评论留档。', icon: '✓' },
  discarded: { title: '已丢弃', status: 'discarded', desc: '不打算评论的条目。', icon: '✕' },
  low_score: { title: '低分过滤', status: 'low_score', desc: 'AI 认为相关度不足的内容，仅作留档。', icon: '▽' },
  settings: { title: '设置', icon: '⚙' },
};

function renderShell() {
  const counts = statusCache?.counts || {};
  const nav = (key, label, countKey) => `
    <a data-view="${key}" class="${view === key ? 'active' : ''}" data-icon="${VIEWS[key].icon}">
      <span>${label}</span>
      <span class="count ${countKey === 'pending' && counts.pending > 0 ? 'hot' : ''}">${counts[countKey] ?? 0}</span>
    </a>`;

  const sources = Object.entries(statusCache?.sources || {})
    .map(([key, s]) => {
      const cls = !s.enabled ? 'off' : s.ok === false ? 'err' : 'ok';
      const tip = s.error ? ` title="${escapeHtml(s.label + '：' + s.error)}"` : '';
      return `<div class="source-row ${cls}" ${tip}><span class="dot"></span><span>${escapeHtml(s.label)}</span><span class="cnt">${s.count ?? ''}</span></div>`;
    })
    .join('');

  $('#app').innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">${LOGO}
          <div><div class="brand-name">评论雷达</div><div class="brand-sub">Comment Radar</div></div>
        </div>
        <div class="topbar-right">
          <span class="run-pill" id="run-pill"><span class="dot"></span><span id="run-pill-text">…</span></span>
          <button class="btn btn-primary" id="btn-run">立即抓取</button>
          <button class="btn-ghost" id="btn-logout" title="退出登录">退出</button>
        </div>
      </header>
      <div class="layout">
        <aside class="sidebar">
          <nav class="nav">
            <div class="nav-group-label">队列</div>
            ${nav('pending', '待审', 'pending')}
            ${nav('unscored', '未评分', 'unscored')}
            <div class="nav-group-label" style="margin-top:14px">归档</div>
            ${nav('posted', '已发布', 'posted')}
            ${nav('discarded', '已丢弃', 'discarded')}
            ${nav('low_score', '低分过滤', 'low_score')}
            <div class="nav-group-label" style="margin-top:14px">管理</div>
            ${nav('settings', '设置', null).replace(/<span class="count[^>]*>.*?<\/span>/, '')}
          </nav>
          <div class="sources">
            <div class="sources-title">数据源</div>
            ${sources || '<div class="source-row off"><span class="dot"></span><span>无</span></div>'}
          </div>
        </aside>
        <main class="main"><div class="main-inner" id="main-inner"></div></main>
      </div>
    </div>`;

  $$('.nav a').forEach((a) => a.addEventListener('click', () => switchView(a.dataset.view)));
  $('#btn-logout').addEventListener('click', async () => {
    document.cookie = 'cr_token=; Max-Age=0; Path=/';
    renderLogin();
  });
  $('#btn-run').addEventListener('click', triggerRun);
  updateRunPill();
  renderMain();
}

function updateRunPill() {
  const pill = $('#run-pill');
  if (!pill) return;
  const t = $('#run-pill-text');
  if (statusCache?.running) {
    pill.classList.add('is-running');
    t.textContent = '抓取中…';
  } else {
    pill.classList.remove('is-running');
    const last = statusCache?.lastRun;
    t.textContent = last ? `上次抓取 ${new Date(last.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · 每 ${statusCache?.fetchIntervalMinutes ?? 30} 分钟` : '尚未抓取';
  }
}

function switchView(v) {
  view = v;
  localStorage.setItem('cr.view', v);
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
  renderMain();
}

/* ---------- 主区渲染 ---------- */

function renderMain() {
  if (view === 'settings') return renderSettings();
  const cfg = VIEWS[view];
  const main = $('#main-inner');
  main.innerHTML = `
    <div class="main-head">
      <div><h2>${cfg.title}</h2><div class="desc">${cfg.desc}</div></div>
      <div class="chips" id="platform-chips">
        ${['all', 'bilibili', 'zhihu', 'hackernews'].map((p) => `<span class="chip ${platformFilter === p ? 'active' : ''}" data-pf="${p}">${p === 'all' ? '全部' : PF_LABEL[p]}</span>`).join('')}
        ${view === 'pending' || view === 'unscored' ? '<button class="btn-ghost primary" id="btn-redraft-all" title="用当前话术库把这一栏的草稿全部重写一遍">↻ 全部重新生成</button>' : ''}
      </div>
    </div>
    <div id="banner"></div>
    <div id="list">${'<div class="card skeleton"></div>'.repeat(3)}</div>`;

  const redraftAllBtn = $('#btn-redraft-all');
  if (redraftAllBtn) redraftAllBtn.addEventListener('click', triggerRedraftAll);

  $$('#platform-chips .chip').forEach((c) => c.addEventListener('click', () => {
    platformFilter = c.dataset.pf;
    $$('#platform-chips .chip').forEach((x) => x.classList.toggle('active', x === c));
    loadItems();
  }));

  if (view === 'unscored' && statusCache && !statusCache.llm.configured) {
    $('#banner').innerHTML = `<div class="banner">未配置 LLM API Key，条目只抓取、不评分不起草。<a data-goto="settings">去设置</a></div>`;
  }
  const bannerLink = $('#banner a[data-goto]');
  if (bannerLink) bannerLink.addEventListener('click', () => switchView('settings'));

  loadItems();
}

const EMPTY_SVG = `<svg width="120" height="84" viewBox="0 0 120 84" fill="none">
  <circle cx="52" cy="42" r="38" stroke="#D6D6E3" stroke-width="2" stroke-dasharray="4 6"/>
  <circle cx="52" cy="42" r="24" stroke="#C9C4EE" stroke-width="2"/>
  <circle cx="52" cy="42" r="10" fill="#5A4BE0" opacity=".85"/>
  <circle cx="92" cy="22" r="5" fill="#FB7299"/>
  <path d="M70 34 L88 24" stroke="#FB7299" stroke-width="2" stroke-linecap="round"/>
</svg>`;

async function loadItems() {
  const cfg = VIEWS[view];
  if (!cfg || !cfg.status) return;
  try {
    const data = await api(`/api/items?status=${cfg.status}&platform=${platformFilter}`);
    itemsCache = data.items;
    statusCache = { ...statusCache, counts: data.counts, lastRun: data.lastRun, running: data.running, redraftJob: data.redraftJob };
    updateRunPill();
    updateNavCounts();
    updateRedraftAllState();
    renderList();
  } catch (e) {
    if (e.message !== '未登录') {
      $('#list').innerHTML = `<div class="empty">${EMPTY_SVG}<h3>加载失败</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
  }
}

function updateRedraftAllState() {
  const btn = $('#btn-redraft-all');
  if (!btn) return;
  const job = statusCache?.redraftJob;
  if (job && !job.finishedAt) {
    btn.disabled = true;
    btn.textContent = `重写中 ${job.done}/${job.total}`;
  } else {
    btn.disabled = false;
    btn.textContent = '↻ 全部重新生成';
  }
}

function updateNavCounts() {
  const counts = statusCache?.counts || {};
  $$('.nav a').forEach((a) => {
    const key = a.dataset.view;
    if (!VIEWS[key]?.status) return;
    const c = a.querySelector('.count');
    if (c) {
      c.textContent = counts[key] ?? 0;
      c.classList.toggle('hot', key === 'pending' && counts.pending > 0);
    }
  });
}

function renderList() {
  const list = $('#list');
  if (!itemsCache.length) {
    const isPending = view === 'pending';
    list.innerHTML = `
      <div class="empty">${EMPTY_SVG}
        <h3>${isPending ? '队列为空' : '这里还没有内容'}</h3>
        <p>${isPending ? '等下一轮抓取，或现在手动跑一次' : '换个平台筛选看看，或调整关键词'}</p>
        ${isPending ? '<button class="btn btn-primary" onclick="document.getElementById(\'btn-run\').click()">立即抓取</button>' : ''}
      </div>`;
    return;
  }
  if (view === 'pending') {
    list.innerHTML = itemsCache.map((it, i) => itemCard(it, i)).join('');
  } else {
    list.innerHTML = itemsCache.map((it, i) => rowCard(it, i)).join('');
  }
  bindCardEvents();
}

function itemCard(it, i) {
  const stats = [
    it.stats?.views !== null && it.stats?.views !== undefined ? `▶ ${fmtNum(it.stats.views)}` : '',
    it.stats?.comments ? `💬 ${fmtNum(it.stats.comments)}` : '',
    it.stats?.heat ? `热度 ${fmtNum(it.stats.heat)}` : '',
    it.stats?.points ? `${fmtNum(it.stats.points)} 分` : '',
  ].filter(Boolean).join(' · ');
  const draftArea = it.draft
    ? `<div class="draft-head">
         <span class="label">AI 草稿 · 可编辑</span>
         <button class="btn-ghost primary" data-act="redraft" title="换一版">↻ 重新生成</button>
         <span class="char">${it.draft.length} 字</span>
       </div>
       <textarea data-act="draft" spellcheck="false">${escapeHtml(it.draft)}</textarea>`
    : `<div class="draft-head"><span class="label">AI 草稿</span><span class="char"></span>
         <button class="btn-ghost primary" data-act="redraft">生成草稿</button></div>
       <div class="draft-empty">还没有草稿（可能生成失败），点右上「生成草稿」重试。</div>`;

  return `
  <article class="card item" data-id="${escapeHtml(it.id)}" style="--i:${i}">
    <div class="item-head">
      <span class="pf pf-${it.platform}">${PF_LABEL[it.platform] || it.platform}</span>
      <span class="type">${TYPE_LABEL[it.type] || ''}</span>
      <span class="score ${scoreTier(it.score)}">${it.score != null ? Number(it.score).toFixed(2) : '—'}</span>
      ${it.angle ? `<span class="angle">${escapeHtml(it.angle)}</span>` : ''}
      <span class="meta">${[escapeHtml(it.author || ''), timeAgo(it.publishedAt), stats].filter(Boolean).join(' · ')}</span>
    </div>
    <a class="item-title" href="${escapeHtml(it.url)}" target="_blank" rel="noopener">${escapeHtml(it.title)}</a>
    ${it.summary ? `<p class="item-summary">${escapeHtml(it.summary)}</p>` : ''}
    ${it.scoreReason ? `<details class="reason"><summary>评分理由</summary><p>${escapeHtml(it.scoreReason)}</p></details>` : ''}
    <div class="draft-box">${draftArea}</div>
    <div class="item-actions">
      <button class="btn btn-primary" data-act="copy" ${it.draft ? '' : 'disabled'}>复制评论</button>
      <a class="btn btn-outline" href="${escapeHtml(it.url)}" target="_blank" rel="noopener">打开原文 ↗</a>
      <span class="spacer"></span>
      <button class="btn btn-success" data-act="posted">标记已发布</button>
      <button class="btn-ghost danger" data-act="discarded">丢弃</button>
    </div>
  </article>`;
}

function rowCard(it, i) {
  const draft = it.editedDraft || it.draft;
  const canRestore = view === 'posted' || view === 'discarded';
  const score = it.score != null ? `<span class="score ${scoreTier(it.score)}">${Number(it.score).toFixed(2)}</span>` : '';
  const stats = [it.stats?.views ? `▶ ${fmtNum(it.stats.views)}` : '', it.stats?.heat ? `热度 ${fmtNum(it.stats.heat)}` : ''].filter(Boolean).join(' · ');
  return `
  <article class="card row-card" data-id="${escapeHtml(it.id)}" style="--i:${i}">
    <span class="pf pf-${it.platform}">${PF_LABEL[it.platform] || it.platform}</span>
    ${score}
    <a class="item-title" href="${escapeHtml(it.url)}" target="_blank" rel="noopener">${escapeHtml(it.title)}</a>
    <span class="meta">${[timeAgo(it.publishedAt || it.firstSeenAt), stats].filter(Boolean).join(' · ')}</span>
    ${canRestore ? '<button class="btn-ghost" data-act="pending">恢复待审</button>' : ''}
    ${view === 'posted' && draft ? `<div class="draft-snip">${escapeHtml(draft)}</div>` : ''}
    ${view === 'low_score' && it.scoreReason ? `<div class="draft-snip">${escapeHtml(it.scoreReason)}</div>` : ''}
  </article>`;
}

function bindCardEvents() {
  const list = $('#list');
  if (!list) return;
  // 点击委托只绑一次（#list 元素在视图内复用，重复绑定会导致动作触发多次）
  if (!list._bound) {
    list._bound = true;
    list.addEventListener('click', onListClick);
  }
  $$('textarea[data-act="draft"]', list).forEach((ta) => {
    autosize(ta);
    ta.addEventListener('input', () => {
      autosize(ta);
      const card = ta.closest('.card');
      const char = card.querySelector('.char');
      if (char) char.textContent = ta.value.length + ' 字';
    });
    ta.addEventListener('change', async () => {
      const id = ta.closest('.card').dataset.id;
      try {
        await api(`/api/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ draft: ta.value }) });
      } catch (e) {
        toast('草稿保存失败：' + e.message, 'err');
      }
    });
  });

  async function onListClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.tagName === 'TEXTAREA') return;
    const card = btn.closest('.card');
    const id = card?.dataset.id;
    const act = btn.dataset.act;
    if (!id || !act) return;
    const item = itemsCache.find((x) => x.id === id);
    if (!item) return;

    try {
      if (act === 'copy') {
        const text = card.querySelector('textarea')?.value ?? item.draft;
        const ok = await copyText(text);
        if (ok) {
          toast('已复制，去原文发布吧');
          const orig = btn.textContent;
          btn.textContent = '已复制 ✓';
          setTimeout(() => (btn.textContent = orig), 1500);
        } else {
          toast('复制失败，请手动全选草稿复制', 'err');
        }
        return;
      }
      if (act === 'redraft') {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> 生成中';
        try {
          const { item: updated } = await api(`/api/items/${encodeURIComponent(id)}/redraft`, { method: 'POST' });
          Object.assign(item, updated);
          renderList();
          toast('已生成新草稿');
        } finally {
          btn.disabled = false;
        }
        return;
      }
      if (act === 'posted' || act === 'discarded' || act === 'pending') {
        await api(`/api/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status: act }) });
        itemsCache = itemsCache.filter((x) => x.id !== id);
        renderList();
        updateNavCounts();
        toast(act === 'posted' ? '已记录发布 ✓' : act === 'discarded' ? '已丢弃' : '已恢复待审');
        refreshStatus();
      }
    } catch (e) {
      if (e.message !== '未登录') toast(e.message, 'err');
      if (act === 'redraft') renderList();
    }
  }
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

/* ---------- 批量重生 ---------- */

async function triggerRedraftAll() {
  const btn = $('#btn-redraft-all');
  const count = statusCache?.counts?.[VIEWS[view].status] ?? 0;
  if (!count) return toast('这一栏没有条目');
  if (!confirm(`把「${VIEWS[view].title}」里的 ${count} 条草稿全部用当前话术库重写一遍？\n已手动改过的草稿会被覆盖。`)) return;

  btn.disabled = true;
  btn.textContent = '启动中…';
  try {
    const r = await api('/api/redraft-all', { method: 'POST', body: JSON.stringify({ status: VIEWS[view].status }) });
    toast(`开始重写 ${r.total} 条，进度会实时更新`);
    pollRedraft();
  } catch (e) {
    if (e.message !== '未登录') toast(e.message, 'err');
    btn.disabled = false;
    btn.textContent = '↻ 全部重新生成';
  }
}

function pollRedraft() {
  const tick = async () => {
    await refreshStatus();
    try {
      const data = await api(`/api/items?status=${view === 'unscored' ? 'unscored' : 'pending'}&platform=${platformFilter}`);
      statusCache = { ...statusCache, counts: data.counts, redraftJob: data.redraftJob };
      itemsCache = data.items;
      updateNavCounts();
      renderList();
      updateRedraftAllState();
    } catch {
      /* 轮询失败继续 */
    }
    const job = statusCache?.redraftJob;
    if (job && !job.finishedAt) setTimeout(tick, 3000);
    else if (job) toast(`重写完成：${job.done - job.failed} 条成功${job.failed ? `，${job.failed} 条失败` : ''}`);
  };
  setTimeout(tick, 2000);
}

/* ---------- 立即抓取 ---------- */

async function triggerRun() {
  const btn = $('#btn-run');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 抓取中';
  statusCache = { ...(statusCache || {}), running: true };
  updateRunPill();
  try {
    const { run } = await api('/api/run', { method: 'POST' });
    if (run?.skipped) {
      toast('已有抓取在进行中');
    } else {
      const errs = run?.errors?.length ? `，${run.errors.length} 个错误` : '';
      toast(`新增 ${run.added} 条 · 评分 ${run.scored} · 起草 ${run.drafted}${errs}`);
    }
  } catch (e) {
    if (e.message !== '未登录') toast('抓取超时/失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '立即抓取';
    await refreshStatus();
    if (view !== 'settings') loadItems();
  }
}

async function refreshStatus() {
  try {
    statusCache = await api('/api/status');
    updateRunPill();
    updateNavCounts();
    updateRedraftAllState();
    const box = $('.sources');
    if (box) {
      const sources = Object.entries(statusCache.sources || {})
        .map(([key, s]) => {
          const cls = !s.enabled ? 'off' : s.ok === false ? 'err' : 'ok';
          const tip = s.error ? ` title="${escapeHtml(s.label + '：' + s.error)}"` : '';
          return `<div class="source-row ${cls}" ${tip}><span class="dot"></span><span>${escapeHtml(s.label)}</span><span class="cnt">${s.count ?? ''}</span></div>`;
        })
        .join('');
      box.innerHTML = `<div class="sources-title">数据源</div>${sources || '<div class="source-row off"><span class="dot"></span><span>无</span></div>'}`;
    }
  } catch {
    /* 轮询失败静默 */
  }
}

/* ---------- 设置 ---------- */

async function renderSettings() {
  const main = $('#main-inner');
  main.innerHTML = '<div class="card skeleton" style="height:200px"></div>';
  let cfg;
  try {
    cfg = await api('/api/config');
  } catch (e) {
    if (e.message !== '未登录') main.innerHTML = `<div class="empty">${EMPTY_SVG}<h3>配置加载失败</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }
  configCache = cfg;
  const llm = cfg.llm || {};

  main.innerHTML = `
    <div class="main-head"><div><h2>设置</h2><div class="desc">关键词、数据源、评分阈值与话术库。改完记得保存，抓取间隔即时生效。</div></div></div>

    <div class="form-section">
      <h3>监控关键词</h3>
      <div class="hint">用于 B 站搜索与 Hacker News 检索；知乎热榜为全量抓取后由 AI 按这些关键词的语境筛选。</div>
      <div class="kw-editor" id="kw-editor">
        ${cfg.keywords.map((k) => `<span class="kw-chip">${escapeHtml(k)}<b title="移除">×</b></span>`).join('')}
        <input id="kw-input" placeholder="输入后回车添加，如：AI 编程">
      </div>
    </div>

    <div class="form-section">
      <h3>数据源</h3>
      <div class="hint">只读抓取公开内容，不登录任何平台账号。</div>
      <div class="switch-row"><span class="name">B 站</span><span class="note">视频搜索（按发布时间）</span>
        <label class="switch"><input type="checkbox" id="src-bilibili" ${cfg.sources.bilibili ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label></div>
      <div class="switch-row"><span class="name">知乎</span><span class="note">热榜（全量，AI 筛选）</span>
        <label class="switch"><input type="checkbox" id="src-zhihu" ${cfg.sources.zhihu ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label></div>
      <div class="switch-row"><span class="name">Hacker News</span><span class="note">英文内容，按需开启</span>
        <label class="switch"><input type="checkbox" id="src-hackernews" ${cfg.sources.hackernews ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label></div>
    </div>

    <div class="form-section">
      <h3>抓取与评分</h3>
      <div class="field-row">
        <div class="field"><label>抓取间隔</label>
          <select id="f-interval">
            ${[10, 15, 30, 60, 120, 240].map((m) => `<option value="${m}" ${cfg.fetchIntervalMinutes === m ? 'selected' : ''}>每 ${m} 分钟</option>`).join('')}
          </select></div>
        <div class="field"><label>回看天数（只收最近 N 天发布的内容）</label>
          <input type="number" id="f-lookback" min="1" max="60" value="${cfg.lookbackDays}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>评分阈值（低于此分进低分归档）</label>
          <div class="range-row"><input type="range" id="f-threshold" min="0.3" max="0.9" step="0.05" value="${cfg.scoreThreshold}"><output id="f-threshold-out">${cfg.scoreThreshold}</output></div></div>
        <div class="field"><label>每个关键词最多收取</label>
          <input type="number" id="f-maxkw" min="1" max="20" value="${cfg.maxPerKeyword}"></div>
      </div>
    </div>

    <div class="form-section">
      <h3>话术库（AI 起草的依据）</h3>
      <div class="hint">对应运营方案里的「评论话术示例库 + 合规红线」。</div>
      <div class="field"><label>产品口径（告诉 AI 我们是什么）</label>
        <textarea id="f-product" spellcheck="false">${escapeHtml(cfg.productContext)}</textarea></div>
      <div class="field"><label>评论纪律（每行一条，AI 必须遵守）</label>
        <textarea id="f-discipline" spellcheck="false">${escapeHtml((cfg.playbook?.discipline || []).join('\n'))}</textarea></div>
      <div class="field"><label>真实口吻示例（每行一条，只学语气不照抄）</label>
        <textarea id="f-examples" spellcheck="false">${escapeHtml((cfg.playbook?.examples || []).join('\n'))}</textarea></div>
      <div class="field"><label>产品提及率（0~1，越低越像真人；0.25 约每 4 条提一次）</label>
        <div class="range-row"><input type="range" id="f-mention-rate" min="0" max="1" step="0.05" value="${cfg.playbook?.productMentionRate ?? 0.25}"><output id="f-mention-out">${cfg.playbook?.productMentionRate ?? 0.25}</output></div></div>
    </div>

    <div class="form-section">
      <h3>LLM 与访问</h3>
      <div class="hint">任何 OpenAI 兼容接口均可（智谱 GLM / DeepSeek 等）。</div>
      <div class="field-row">
        <div class="field"><label>API Base URL</label><input type="text" id="f-llm-url" value="${escapeHtml(llm.baseUrl)}" placeholder="https://open.bigmodel.cn/api/paas/v4"></div>
        <div class="field"><label>模型</label><input type="text" id="f-llm-model" value="${escapeHtml(llm.model)}" placeholder="glm-4-flash"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>API Key ${llm.keySet ? '<span style="color:var(--success)">· 已设置</span>' : '<span style="color:var(--danger)">· 未设置</span>'}</label>
          <input type="password" id="f-llm-key" placeholder="${llm.keySet ? '留空保持不变' : '粘贴 key'}" autocomplete="new-password"></div>
        <div class="field"><label>访问密码（改 UI 登录密码）</label>
          <input type="password" id="f-password" placeholder="留空保持不变" autocomplete="new-password"></div>
      </div>
    </div>

    <div class="save-bar">
      <button class="btn btn-primary" id="btn-save">保存设置</button>
      <span class="note" id="save-note"></span>
      <span class="spacer"></span>
      <button class="btn-ghost" id="btn-export">导出数据 JSON</button>
    </div>`;

  // 关键词编辑
  const editor = $('#kw-editor');
  const kwInput = $('#kw-input');
  const addKw = () => {
    const v = kwInput.value.trim().replace(/[,，]$/, '');
    if (!v) return;
    if ($$('.kw-chip', editor).some((c) => c.textContent.trim() === v)) {
      toast('关键词已存在');
      return;
    }
    const chip = document.createElement('span');
    chip.className = 'kw-chip';
    chip.innerHTML = `${escapeHtml(v)}<b title="移除">×</b>`;
    editor.insertBefore(chip, kwInput);
    kwInput.value = '';
  };
  kwInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addKw();
    }
  });
  editor.addEventListener('click', (e) => {
    if (e.target.tagName === 'B') e.target.closest('.kw-chip').remove();
  });
  editor.addEventListener('click', () => kwInput.focus());

  $('#f-threshold').addEventListener('input', (e) => ($('#f-threshold-out').textContent = e.target.value));
  $('#f-mention-rate').addEventListener('input', (e) => ($('#f-mention-out').textContent = e.target.value));

  $('#btn-export').addEventListener('click', () => {
    window.open('/api/export', '_blank');
  });

  $('#btn-save').addEventListener('click', async () => {
    const btn = $('#btn-save');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 保存中';
    const payload = {
      keywords: $$('.kw-chip', editor).map((c) => c.textContent.trim().slice(0, -1)),
      sources: {
        bilibili: $('#src-bilibili').checked,
        zhihu: $('#src-zhihu').checked,
        hackernews: $('#src-hackernews').checked,
      },
      fetchIntervalMinutes: Number($('#f-interval').value),
      lookbackDays: Math.max(1, Number($('#f-lookback').value) || 14),
      scoreThreshold: Number($('#f-threshold').value),
      maxPerKeyword: Math.max(1, Number($('#f-maxkw').value) || 8),
      productContext: $('#f-product').value.trim(),
      playbook: {
        discipline: $('#f-discipline').value.split('\n').map((s) => s.trim()).filter(Boolean),
        examples: $('#f-examples').value.split('\n').map((s) => s.trim()).filter(Boolean),
        productMentionRate: Number($('#f-mention-rate').value),
      },
      llm: {
        baseUrl: $('#f-llm-url').value.trim(),
        model: $('#f-llm-model').value.trim(),
        apiKey: $('#f-llm-key').value.trim(),
      },
      password: $('#f-password').value,
    };
    try {
      await api('/api/config', { method: 'PUT', body: JSON.stringify(payload) });
      $('#save-note').textContent = '已保存 ' + new Date().toLocaleTimeString('zh-CN');
      toast('设置已保存');
      refreshStatus();
    } catch (e) {
      if (e.message !== '未登录') toast('保存失败：' + e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '保存设置';
    }
  });
}

/* ---------- 启动与轮询 ---------- */

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    if (view !== 'settings' && view !== 'login') {
      loadItems();
    }
    refreshStatus();
  }, 45_000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function boot() {
  renderShellSkeleton();
  try {
    statusCache = await api('/api/status');
  } catch (e) {
    if (e.message === '未登录') return;
  }
  renderShell();
  startPolling();
}

boot();
