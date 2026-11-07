'use strict';
const CE_MODE = localStorage.getItem('dshm.ce') === '1';   // 富文本输入模式（实验）
// 实例：可在顶部按钮切换（localStorage 记住）；/m2/ 路径强制 rc.2。所有 API 自动加前缀。
const PATH_RC2 = location.pathname.startsWith('/m2');
// 推送点击会带 ?inst=rc2|main，先把这个显式意图写进本地，再决定实例
const URL_INST = new URLSearchParams(location.search).get('inst');
if (URL_INST === 'rc2' || URL_INST === 'main') { try { localStorage.setItem('dshm.inst', URL_INST); } catch {} }
let INSTANCE = PATH_RC2 ? 'rc2' : (localStorage.getItem('dshm.inst') === 'rc2' ? 'rc2' : 'main');
const IS_RC2 = INSTANCE === 'rc2';
const API_BASE = IS_RC2 ? '/m2' : '';
const HOME_PATH = IS_RC2 ? '/m2/' : '/m/';

/** 顶部按钮：主实例 ↔ rc.2 实例。切到 rc.2 时先去 /m2/login 种 cookie 再回来。 */
function wireInstanceSwitch() {
  const btn = document.getElementById('inst');
  if (btn) {
    btn.textContent = IS_RC2 ? 'rc2' : '主';
    btn.title = IS_RC2 ? '当前 rc.2 实例，点击切回主实例' : '当前主实例，点击切到 rc.2 实例';
    btn.onclick = () => {
      if (IS_RC2) {
        localStorage.setItem('dshm.inst', 'main');
        location.href = '/m/';
        return;
      }
      localStorage.setItem('dshm.inst', 'rc2');
      // 先让 nginx 用 dshm 换一个 rc.2 的 cookie，成功后回 /m/
      location.href = '/m2/login?back=' + encodeURIComponent('/m/');
    };
  }
}
wireInstanceSwitch();

function showFatal(msg) {
  try {
    let box = document.getElementById('fatal');
    if (!box) {
      box = document.createElement('div');
      box.id = 'fatal';
      box.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;background:#7f1d1d;color:#fff;' +
        'font:12px/1.4 ui-monospace,Menlo,monospace;padding:8px 10px;white-space:pre-wrap;max-height:40vh;overflow:auto';
      document.body.appendChild(box);
    }
    box.textContent += 'JS错误: ' + msg + '\n';
  } catch {}
}
window.addEventListener('error', (e) => showFatal(e.message || String(e.error || 'unknown')));
window.addEventListener('unhandledrejection', (e) => showFatal((e.reason && (e.reason.message || e.reason)) || 'promise rejected'));

const BUILD = '148';   // 部署时由脚本替换成时间戳
/* DSH 移动端 PWA —— 会话列表 / 对话流 / 发消息 / 双向审批
 * 协议：POST /api/<method> {type:'client-request',rpcId,method,payload:{args}}
 *       WS  /api/remote.mux  {type:'open',streamId,endpoint,payload:{args}} */

const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const rid = () => 'w-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const nowTZ = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const pendingDeepLink = new URLSearchParams(location.search).get('session');
const state = { listScroll: 0, touching: false, listSig: '', workspaces: [], expandedGroups: new Set(), pinned: new Set(), archived: new Set(), view: 'list', sessions: [], sessionId: null, clientId: null, pending: new Map(), ws: null, followWs: null, live: null, running: false, mode: 'steer', images: [], files: [], toolCount: 0, toolRow: null, shownRpc: new Set(), queue: [], thinkRow: null, thinkPhase: 'thinking', toolLabel: '', catalog: null, model: null, stats: null, turnStart: null, turnSteps: 0, ticker: null, followRetry: 0, wsRetry: 0, connState: 'ok' };

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------- 认证 ---------- */
async function rpc(method, args, { retry = true, rpcId } = {}) {
  const envId = rpcId || rid();
  const body = JSON.stringify({ type: 'client-request', rpcId: envId, method, payload: { args: args ?? {} } });
  const res = await fetch(`${API_BASE}/api/${method}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body,
  });
  if (res.status === 401 || res.status === 403) {
    if (retry) { await login(); return rpc(method, args, { retry: false, rpcId }); }
    throw new Error('未登录');
  }
  let json; try { json = await res.json(); } catch { throw new Error('响应解析失败 HTTP ' + res.status); }
  const result = json?.result;
  if (!result || result.ok !== true) throw new Error(result?.error?.message || '请求失败');
  return result.value;
}

let loginAttempted = false;
/* 启动时保证 dshm cookie 存在：这个 cookie 是"BasicAuth 只输一次"的关键。
   之前只在 401 时才取 token，所以老用户从没触发过发 cookie 的请求，重开就又要 BasicAuth。 */
function showGate(msg) {
  reportErr('gate: ' + msg);
  const g = $('#gate'); if (!g) return;
  const t = $('#gate-text');
  if (t) t.textContent = msg || '请输入访问密码';
  g.hidden = false;
}
function hideGate() {
  const g = $('#gate'); if (g) g.hidden = true;
}

async function ensureAuthCookie() {
  try { await fetch('/_dsh/token', { credentials: 'same-origin', cache: 'no-store' }); } catch {}
}

async function passwordLogin(pw) {
  try {
    showGate('正在登录…');
    const r = await fetch('/_dsh/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'dsh', pass: pw }),
    });
    if (!r.ok) { showGate('密码不正确，请重新输入'); return; }
    // 已经拿到 dshm cookie，再走一次跳板换 DSH 登录 cookie
    const tokRes = await fetch('/_dsh/token', { credentials: 'same-origin', cache: 'no-store' });
    const tok = tokRes.ok ? (await tokRes.text()).trim() : '';
    if (IS_RC2) { location.replace(HOME_PATH); return; }   // rc.2 由 nginx 注入 cookie，不用主实例跳板
    if (tok && !tok.startsWith('<')) { location.replace('/m/login?token=' + encodeURIComponent(tok)); return; }
    location.replace(HOME_PATH);
  } catch (e) {
    showGate('登录失败：' + e.message);
  }
}

async function login() {
  if (IS_RC2) {
    // rc.2 实例：让 nginx 用 dshm 换一个 rc.2 的 cookie，再回到当前页
    location.replace('/m2/login?back=' + encodeURIComponent(location.pathname));
    await new Promise(() => {});
  }
  if (loginAttempted) { showGate('登录失败，请关掉页面重新打开'); throw new Error('未登录'); }
  loginAttempted = true;
  showGate('正在登录…');
  try {
    const res = await fetch('/_dsh/token', { credentials: 'same-origin', cache: 'no-store' });
    const tok = (await res.text()).trim();
    if (!res.ok || !tok || tok.startsWith('<')) {
      // 没有 BasicAuth 凭据 / cookie 失效：让用户输密码
      loginAttempted = false;
      showGate('需要访问密码（输一次即可长期免登录）');
      const inp = $('#gate-pass'); if (inp) inp.focus();
      throw new Error('需要密码');
    }
    if (IS_RC2) { location.replace(HOME_PATH); await new Promise(() => {}); }
    // 走 nginx 跳板：/m/login?token=… -> DSH 种 30 天 cookie -> 303 回到 /m/
    location.replace('/m/login?token=' + encodeURIComponent(tok));
    await new Promise(() => {});
  } catch (e) {
    loginAttempted = false;
    showGate('自动登录失败：' + e.message + '\n点下面按钮重试，或先在 Safari 里打开本页并输入密码。');
    throw e;
  }
}

/* ---------- 错误上报（诊断用） ---------- */
let lastErrAt = 0;
function reportErr(msg, err) {
  try {
    const now = Date.now();
    if (now - lastErrAt < 2000) return;
    lastErrAt = now;
    const stack = err && err.stack ? String(err.stack).slice(0, 900) : '';
    const body = JSON.stringify({ m: String(msg).slice(0, 400), stack, v: BUILD, t: now, u: location.href, sw: !!navigator.serviceWorker?.controller });
    navigator.sendBeacon ? navigator.sendBeacon('/m/err', body) : fetch('/m/err', { method: 'POST', body, keepalive: true }).catch(() => {});
  } catch {}
}
window.addEventListener('error', (e) => reportErr('error: ' + (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || 0)));
window.addEventListener('unhandledrejection', (e) => reportErr('reject: ' + ((e.reason && (e.reason.message || e.reason)) || 'unknown')));

/* ---------- 工具 ---------- */
function fmtTime(ms) {
  const d = new Date(ms); const t = Date.now() - ms;
  if (t < 60e3) return '刚刚';
  if (t < 3600e3) return Math.floor(t / 60e3) + ' 分钟前';
  if (t < 86400e3) return Math.floor(t / 3600e3) + ' 小时前';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
const textOf = (content) => (content || []).filter((p) => p?.type === 'text').map((p) => p.text).join('');

/* ---------- 工作区流：拿归档集合（电脑端不显示的会话，手机也不显示）---------- */
function openWorkspaceStream() {
  const ws = new WebSocket(`wss://${location.host}${API_BASE}/api/remote.mux`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'open', streamId: 'wks', endpoint: 'workspace/follow', payload: { args: {} } }));
  ws.onmessage = (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    if (f.type !== 'item' || f.streamId !== 'wks') return;
    const v = f.value || {};
    // baseline 包了一层：{type:'baseline', value:{items, archivedSessionIds, pinnedSessionIds}}
    const payload = v.type === 'baseline' ? (v.value || {}) : v;
    let changed = false;
    if (Array.isArray(payload.items)) {
      state.workspaces = payload.items.map((w) => ({
        id: w.workspaceId, title: w.title || (w.path || '').split('/').filter(Boolean).pop() || '工作区',
        path: w.path || '', sessionIds: new Set(w.sessionIds || []),
      }));
      changed = true;
    }
    if (Array.isArray(payload.archivedSessionIds)) {
      state.archived = new Set(payload.archivedSessionIds);
      changed = true;
    }
    if (Array.isArray(payload.pinnedSessionIds)) {
      state.pinned = new Set(payload.pinnedSessionIds);
      changed = true;
    }
    if (changed) {
      saveWorkspacesCache();
      if (state.archivedReady) state.archivedReady();
      if (state.view === 'list') loadSessions().catch(() => {});
    }
  };
  ws.onclose = () => setTimeout(openWorkspaceStream, 3000);
}

/* ---------- 会话列表 ---------- */

function paintSessionList(items, fromCache) {
  const box = $('#sessions');
  if (!box) return;
  // 数据指纹：完全相同时不重建 DOM（避免返回列表时整块重绘导致手滑不动）
  // 注意：展开/收起状态、置顶集合也必须进指纹，否则“展开剩余 N 个”点了不会重绘（历史 bug）
  const sig = items.map((it) => it.sessionId + '|' + (it.updatedAt || 0) + '|' + (it.running ? 1 : 0) +
    '|' + (it.projections?.values?.title || '') + '|' + (it.projections?.values?.sessionStats?.turns || 0)).join(',')
    + '#' + fromCache
    + '#' + Array.from(state.expandedGroups || []).sort().join('|')
    + '#' + Array.from(state.pinned || []).sort().join('|');
  if (sig === state.listSig) return;
  // 手指正在屏幕上：等松手后再重建
  if (state.touching) { state.pendingListPaint = () => paintSessionList(items, fromCache); return; }
  state.listSig = sig;
  state.pendingListPaint = null;
  // 重绘前记住滚动位置：列表刷新时若把 scrollTop 清零，用户正在滑的第一下会被"吞掉"
  const keepTop = box.scrollTop;
  box.replaceChildren();
  if (!items.length) { box.append(el('div', 'empty', '还没有会话')); return; }
  if (fromCache) box.append(el('div', 'cached-hint', '显示的是上次的列表，正在刷新…'));

  const used = new Set();
  const groups = [];
  for (const w of state.workspaces) {
    const rawIds = w.sessionIds;
    const ids = rawIds && typeof rawIds.has === 'function'
      ? rawIds
      : new Set(Array.isArray(rawIds) ? rawIds : []);
    const list = items.filter((it) => ids.has(it.sessionId));
    if (list.length) {
      groups.push({ title: w.title, path: w.path, list });
      list.forEach((x) => used.add(x.sessionId));
    }
  }
  const rest = items.filter((it) => !used.has(it.sessionId));
  if (rest.length) groups.push({ title: '未分组', path: '', list: rest });

  const LIMIT = 4;
  for (const g of groups) {
    g.list.sort((a, b) =>
      ((state.pinned.has(b.sessionId) ? 1 : 0) - (state.pinned.has(a.sessionId) ? 1 : 0)) ||
      ((b.running === true) - (a.running === true)) ||
      ((b.updatedAt || 0) - (a.updatedAt || 0)));
    const key = (g.path || g.title) + '';
    const expanded = state.expandedGroups.has(key);
    const h = el('div', 'ws-group');
    h.append(el('span', 'ws-title', g.title));
    if (g.path) h.append(el('span', 'ws-path', g.path));
    const addBtn = el('button', 'ws-add', '＋');
    addBtn.title = '在工作区 ' + g.title + ' 新建对话';
    const wsInfo = state.workspaces.find((w) => (w.path || w.title) + '' === key);
    addBtn.onclick = (e) => { e.stopPropagation(); createSession(wsInfo || null); };
    h.append(addBtn);
    box.append(h);
    const shown = expanded ? g.list : g.list.slice(0, LIMIT);
    for (const it of shown) box.append(buildRow(it));
    if (g.list.length > LIMIT) {
      const more = el('button', 'ws-more');
      const restCount = g.list.length - LIMIT;
      more.textContent = expanded ? '收起 ⌃' : ('展开剩余 ' + restCount + ' 个 ⌄');
      more.onclick = () => {
        if (expanded) state.expandedGroups.delete(key); else state.expandedGroups.add(key);
        paintSessionList(items, fromCache);
      };
      box.append(more);
    }
  }
  if (keepTop > 0) { box.scrollTop = keepTop; state.listScroll = keepTop; }
}

// 轻量列表（服务器侧裁剪，87KB 而不是 1.95MB，iPhone 解析不卡）
function mapLightItem(it) {
  const p = it.project || {};
  return {
    sessionId: it.sessionId,
    running: it.running === true,
    updatedAt: it.updatedAt || 0,
    cwd: it.cwd || '',
    blank: it.blank === true,
    projections: {
      values: {
        title: p.title || '',
        sessionStats: {
          turns: p.turns || 0, decodeMs: p.decodeMs || 0, decodeTokens: p.decodeTokens || 0,
          llmMs: p.llmMs || 0, toolMs: p.toolMs || 0,
        },
        tokenUsage: { outputTokens: p.outputTokens || 0 },
        contextPressure: { pressureTokens: p.pressureTokens || 0, contextWindow: p.contextWindow || 0 },
        modelSelection: p.model ? { next: p.model, lastUsed: p.model } : null,
        todos: p.todos || undefined,
        goal: p.goal || undefined,
        inbox: p.inbox || undefined,
      },
    },
  };
}

async function fetchSessionList() {
  try {
    const r = await fetch(`${API_BASE}/m/list`, { cache: 'no-store' });
    const j = await r.json();
    if (j && j.ok && Array.isArray(j.items) && j.items.length) {
      return { items: j.items.map(mapLightItem) };
    }
  } catch {}
  return await rpc('session/list', { _request: {} });
}

async function loadSessions() {
  const slowTimer = setTimeout(() => toast('服务器较慢，正在读取会话…', 3000), 8000);
  let value;
  try {
    value = await fetchSessionList();
  } finally {
    clearTimeout(slowTimer);
  }
  const items = (value?.items || [])
    .filter((it) => !state.archived.has(it.sessionId))
    .filter((it) => it.blank !== true)
    .slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  state.sessions = items;
  state.sessionsLoaded = true;
  saveSessionsCache(items);
  paintSessionList(items, false);
}

function buildRow(it) {
  const v = it.projections?.values || {};
  const row = el('div', 'row');
  const info = el('div', 'row-info');
  const isPinned = state.pinned.has(it.sessionId);
  const titleLine = el('div', 't');
  if (isPinned) titleLine.append(el('span', 'pin', '📌'));
  titleLine.append(document.createTextNode(v.title || (it.blank ? '（空白会话）' : it.sessionId.slice(8, 16))));
  info.append(titleLine);
  row.append(info);
  if (it.running) row.append(el('span', 'badge run', '运行中'));
  const more = el('button', 'row-more', '⋯');
  more.onclick = (e) => { e.stopPropagation(); openRowMenu(it); };
  row.append(more);
  row.onclick = () => openSession(it);
  return row;
}

/* ---------- 模型切换 ---------- */
function fmtDur(ms) {
  const s0 = Math.max(0, Math.round(ms / 1000));
  if (s0 < 60) return s0 + ' 秒';
  const m = Math.floor(s0 / 60), r = s0 % 60;
  if (m < 60) return r ? `${m} 分 ${r} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

function renderStats() {
  const bar = $('#stats'); if (!bar) return;
  const st = state.stats;
  const parts = [];
  if (st) {
    if (st.decodeMs > 0 && st.decodeTokens > 0) parts.push(Math.round(st.decodeTokens / (st.decodeMs / 1000)) + ' tok/s');
    if (st.cpuMs) parts.push('用时 ' + fmtDur(st.cpuMs));
  }
  if (state.toolCount) parts.push('工具 ' + state.toolCount);
  if (state.turnStart) parts.push('本轮 ' + fmtDur(Date.now() - state.turnStart));
  if (state.connState === 'reconnecting') parts.push('连接中…');
  if (state.connState === 'offline') parts.push('离线');
  bar.textContent = parts.join(' · ') || '—';
}

function startTicker() {
  if (state.ticker) return;
  state.ticker = setInterval(() => { if (state.turnStart) { renderStats(); renderThinkSummary(); } }, 1000);
}
function stopTicker() { if (state.ticker) { clearInterval(state.ticker); state.ticker = null; } }

function renderModelBar() {
  const bar = $('#modelbar'); if (!bar) return;
  const m = state.model;
  $('#modelname').textContent = m ? `${m.provider} / ${m.model}${m.reasoningEffort ? ' · ' + m.reasoningEffort : ''}` : '模型（默认）';
}

async function ensureCatalog() {
  if (state.catalog) return state.catalog;
  state.catalog = await rpc('session/modelCatalog', {});
  return state.catalog;
}

function closeModelSheet() { $('#modelsheet').hidden = true; }

async function openModelSheet() {
  const list = $('#model-list');
  list.replaceChildren(el('div', 'mgroup', '加载中…'));
  $('#modelsheet').hidden = false;
  let cat;
  try { cat = await ensureCatalog(); }
  catch (e) { list.replaceChildren(el('div', 'mgroup', '加载失败：' + e.message)); return; }
  list.replaceChildren();
  const cur = state.model;
  for (const g of cat.groups || []) {
    list.append(el('div', 'mgroup', g.name || g.id));
    for (const model of g.models || []) {
      const row = el('div', 'mrow');
      const left = el('div');
      left.append(el('div', 'mname', model.name || model.id));
      const bits = [model.id];
      if (cur && cur.provider === g.id && cur.model === model.id) bits.push('当前');
      left.append(el('div', 'msub', bits.join(' · ')));
      row.append(left);
      if (cur && cur.provider === g.id && cur.model === model.id) row.classList.add('cur');
      row.onclick = () => pickModel(g.id, model);
      list.append(row);
    }
  }
}

function pickModel(provider, model) {
  const efforts = model.reasoning?.efforts || [];
  if (!efforts.length) { selectModel(provider, model, undefined).catch(() => {}); return; }
  const list = $('#model-list');
  list.replaceChildren();
  const head = el('div', 'mgroup', '推理强度 · ' + (model.name || model.id));
  head.style.display = 'flex';
  head.style.alignItems = 'center';
  head.style.gap = '8px';
  const back = el('button', 'mback', '‹ 返回');
  back.onclick = () => openModelSheet().catch(() => {});
  head.prepend(back);
  list.append(head);

  const cur = state.model;
  const curSame = cur && cur.provider === provider && cur.model === model.id;
  const defaultRow = el('div', 'mrow');
  defaultRow.append(el('div', 'mname', '不指定（用模型默认）'));
  defaultRow.onclick = () => selectModel(provider, model, undefined).catch(() => {});
  list.append(defaultRow);

  for (const e of efforts) {
    const row = el('div', 'mrow');
    const left = el('div');
    left.append(el('div', 'mname', e.name || e.id));
    if (e.description) left.append(el('div', 'msub', e.description));
    row.append(left);
    if (curSame && cur.reasoningEffort === e.id) { row.classList.add('cur'); left.append(el('div', 'msub', '当前')); }
    row.onclick = () => selectModel(provider, model, e.id).catch(() => {});
    list.append(row);
  }
}

async function selectModel(provider, model, explicitEffort) {
  if (!state.sessionId) return;
  const efforts = (model.reasoning?.efforts || []).map((x) => x.id);
  let effort = explicitEffort;
  if (effort === undefined) {
    // 没显式指定时：沿用当前档位，不兼容就用最大档
    effort = state.model?.reasoningEffort;
    if (!effort || (efforts.length && !efforts.includes(effort))) effort = undefined;
  }
  const req = { sessionId: state.sessionId, provider, model: model.id };
  if (effort) req.reasoningEffort = effort;
  closeModelSheet();
  try {
    await rpc('session/selectModel', { request: req });
    state.model = { provider, model: model.id, reasoningEffort: effort };
    renderModelBar();
    toast('已切换：' + provider + ' / ' + model.id, 2500);
  } catch (e) { toast('切换失败：' + e.message, 5000); }
}

/* ---------- 手机推送（Web Push） ---------- */
function urlB64ToU8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function pushSubscription() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch { return null; }
}

async function updateBell() {
  const b = $('#bell');
  if (!b) return;
  const sub = await pushSubscription();
  const on = !!sub && Notification.permission === 'granted';
  b.textContent = on ? '🔔' : '🔕';
  b.classList.toggle('on', on);
  b.title = on ? '通知已开启（点击关闭）' : '点击开启通知';
}

async function togglePush() {
  const b = $('#bell');
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      toast('此设备/浏览器不支持推送（需 iOS 16.4+ 且已添加到主屏幕）', 5000);
      return;
    }
    const sub = await pushSubscription();
    if (sub) {
      await fetch('/push/unsubscribe', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
      toast('通知已关闭', 2000);
      updateBell();
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('你拒绝了通知权限，可在系统设置里重新打开', 4000); return; }
    const info = await (await fetch('/push/vapid', { cache: 'no-store' })).json();
    const reg = await navigator.serviceWorker.ready;
    const newSub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToU8(info.publicKey),
    });
    const r = await fetch('/push/subscribe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(newSub.toJSON()),
    });
    if (!r.ok) throw new Error('订阅保存失败 ' + r.status);
    toast('通知已开启：回合结束 / 需要审批 / 需要回答都会提醒', 4000);
    updateBell();
  } catch (e) {
    toast('开启失败：' + e.message, 5000);
  }
}

/* ---------- 会话列表本地缓存（服务器慢时先显示旧列表） ---------- */
const CACHE_SESSIONS = 'dsh.cache.sessions.v1';
const CACHE_WS = 'dsh.cache.workspaces.v1';
// 离线缓存：7 天过期、最多 300 条会话 / 50 个工作区（避免无限膨胀，也减少丢手机时的暴露面）
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX_SESSIONS = 300;
const CACHE_MAX_WS = 50;

function clearOfflineCache() {
  try { localStorage.removeItem(CACHE_SESSIONS); } catch {}
  try { localStorage.removeItem(CACHE_WS); } catch {}
}

function saveSessionsCache(items) {
  try {
    const slim = items.map((it) => ({
      sessionId: it.sessionId,
      running: it.running === true,
      blank: it.blank === true,
      cwd: it.cwd || '',
      updatedAt: it.updatedAt || 0,
      title: it.projections?.values?.title || '',
      turns: it.projections?.values?.sessionStats?.turns || 0,
    }));
    localStorage.setItem(CACHE_SESSIONS, JSON.stringify({ at: Date.now(), items: slim.slice(0, CACHE_MAX_SESSIONS) }));
  } catch {}
}

function readSessionsCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_SESSIONS) || 'null');
    if (!raw || !Array.isArray(raw.items)) return null;
    if (!raw.at || Date.now() - raw.at > CACHE_TTL_MS) { localStorage.removeItem(CACHE_SESSIONS); return null; }
    const items = raw.items.map((x) => ({
      sessionId: x.sessionId,
      running: x.running,
      blank: x.blank,
      cwd: x.cwd,
      updatedAt: x.updatedAt,
      projections: { values: { title: x.title, sessionStats: { turns: x.turns } } },
    }));
    return { at: raw.at, items };
  } catch { return null; }
}

function saveWorkspacesCache() {
  try {
    const list = state.workspaces.map((w) => ({
      id: w.id, title: w.title, path: w.path,
      sessionIds: Array.from(w.sessionIds || []),
    }));
    localStorage.setItem(CACHE_WS, JSON.stringify({ at: Date.now(), list: list.slice(0, CACHE_MAX_WS) }));
  } catch {}
}

function readWorkspacesCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_WS) || 'null');
    if (raw && raw.at && Date.now() - raw.at > CACHE_TTL_MS) { localStorage.removeItem(CACHE_WS); return null; }
    if (raw && Array.isArray(raw.list)) {
      return raw.list.map((w) => ({
        id: w.id, title: w.title, path: w.path,
        sessionIds: new Set(Array.isArray(w.sessionIds) ? w.sessionIds : []),
      }));
    }
  } catch {}
  return null;
}

/** 先用缓存把列表画出来（避免空白/像连不上），再等真实数据替换 */
function renderFromCache() {
  const cached = readSessionsCache();
  if (!cached) return false;
  if (!state.workspaces.length) {
    const ws = readWorkspacesCache();
    if (ws) state.workspaces = ws;
  }
  const items = cached.items.filter((it) => !state.archived.has(it.sessionId) && it.blank !== true);
  if (!items.length) return false;
  paintSessionList(items, true);
  return true;
}

/* ---------- 刷新列表（含版本检测） ---------- */
async function refreshListWithVersion(ptrEl) {
  try {
    const r = await fetch('/m/build.txt?t=' + Date.now(), { cache: 'no-store' });
    const remote = (await r.text()).trim();
    if (remote && remote !== String(BUILD)) {
      if (ptrEl) ptrEl.textContent = '发现新版本，正在更新…';
      location.reload();
      return;
    }
    await loadSessions();
    return true;
  } catch (e) {
    toast('刷新失败：' + e.message, 4000);
    return false;
  }
}

/* ---------- 下拉刷新 ---------- */
function bindPull(scrollerSel, ptrSel, onRefresh) {
  const scroller = $(scrollerSel);
  const ptr = $(ptrSel);
  if (!scroller || !ptr) return;
  let startY = null, armed = false, busy = false;

  scroller.addEventListener('touchstart', (e) => {
    if (busy) return;
    if (scroller.scrollTop <= 0) { startY = e.touches[0].clientY; armed = false; }
    else startY = null;
  }, { passive: true });

  scroller.addEventListener('touchmove', (e) => {
    if (startY === null || busy) return;
    if (scroller.scrollTop > 0) { startY = null; return; }
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) { ptr.classList.remove('on'); return; }
    armed = dy > 70;
    ptr.classList.add('on');
    ptr.textContent = armed ? '松开刷新' : '下拉刷新';
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  const finish = async () => {
    if (startY === null) { ptr.classList.remove('on'); return; }
    const shouldRefresh = armed;
    startY = null; armed = false;
    if (!shouldRefresh) { ptr.classList.remove('on'); return; }
    busy = true;
    ptr.textContent = '刷新中…';
    ptr.classList.add('loading');
    try { await onRefresh(ptr); } catch (e) { toast('刷新失败：' + e.message, 4000); }
    busy = false;
    ptr.classList.remove('loading');
    ptr.textContent = '已刷新';
    setTimeout(() => { ptr.classList.remove('on'); ptr.textContent = '下拉刷新'; }, 450);
  };

  scroller.addEventListener('touchend', finish, { passive: true });
  scroller.addEventListener('touchcancel', finish, { passive: true });
}

function bindPullToRefresh() {
  // 列表页：查版本 + 刷数据
  bindPull('#sessions', '#ptr', async (ptr) => { await refreshListWithVersion(ptr); });
  // 对话页：重新拉当前会话
  bindPull('#messages', '#ptr2', async () => {
    if (!state.sessionId) return;
    const it = state.sessions.find((s) => s.sessionId === state.sessionId);
    if (it) await openSession(it);
    else await openFollow(state.sessionId);
    scrollBottom(true);
  });
}

/* ---------- 会话详情 ---------- */
async function createSession(ws) {
  try {
    const req = {};
    if (ws?.id) req.workspaceId = ws.id;
    else if (ws?.path) req.cwd = ws.path;
    const v = await rpc('session/create', { request: req });
    const sid = v?.sessionId;
    if (!sid) throw new Error('未返回会话 id');
    toast('已新建对话', 1500);
    const item = {
      sessionId: sid,
      running: false,
      projections: { values: { title: '新对话' } },
      cwd: ws?.path || '',
    };
    await openSession(item);
  } catch (e) {
    toast('新建失败：' + e.message, 4000);
  }
}

async function openSession(it) {
  try { state.listScroll = $('#sessions') ? $('#sessions').scrollTop : 0; } catch {}
  state.sessionId = it.sessionId;
  const v = it.projections?.values || {};
  $('#title').textContent = v.title || it.sessionId.slice(8, 16);
  showView('chat');
  updateJumpBtn();
  $('#messages').replaceChildren(el('div', 'empty', '加载中…'));
  state.view = 'chat';
  clearLiveBubbles(); setRunning(false); clearThinkLine();
  const tk = $('#tasks'); if (tk) { tk.replaceChildren(); tk.hidden = true; }
  state.shownRpc = new Set();
  // 恢复服务端排队消息：连续发多条时，只有第一条已落成消息，其余还在 inbox（next-turn/next-step）
  state.queue = [];
  const inbox = v.inbox || {};
  for (const q of [...(inbox.nextTurn || []), ...(inbox.nextStep || [])]) {
    if (q && q.text) state.queue.push({ itemId: q.id, requestId: q.rpcId || null, text: q.text });
  }
  if (typeof renderQueue === 'function') renderQueue();
  state.model = v.modelSelection?.next || v.modelSelection?.lastUsed || null;
  state.stats = null;
  if (v.sessionStats) {
    const ss = v.sessionStats;
    const tu = v.tokenUsage || {};
    state.stats = {
      turns: ss.turns, steps: ss.steps,
      decodeMs: ss.decodeMs, decodeTokens: ss.decodeTokens,
      cpuMs: (ss.llmMs || 0) + (ss.toolMs || 0),
      outputTokens: tu.outputTokens,
      contextPct: v.contextPressure?.contextWindow
        ? Math.round(100 * (v.contextPressure.pressureTokens || 0) / v.contextPressure.contextWindow) : null,
    };
    if (state.stats.contextPct !== null) renderStats();
  }
  renderModelBar(); renderStats(); startTicker();
  if (Array.isArray(v.todos)) renderTasks(v.todos);
  state.goal = v.goal?.goal || v.goal || null;
  renderGoal();
  // 让 iOS 侧滑返回 / 安卓返回键能回到列表
  if (history.state?.dshView !== 'chat') history.pushState({ dshView: 'chat', sessionId: it.sessionId }, '');
  await openEvents();            // 审批流（全局长连）
  openFollow(it.sessionId);      // 对话流
}

function showView(name) {
  const chat = name === 'chat';
  $('#view-chat').hidden = !chat;
  $('#view-list').hidden = chat;
  $('#back').hidden = !chat;
  const nc = $('#newchat'); if (nc) nc.hidden = chat;
  if (!chat) {
    $('#title').textContent = 'DSH'; stopTicker();
    // iOS 上 display:none 恢复显示后，滚动层要等一次布局才吃手势（表现为「第一下滑不动」）。
    // 这里强制 reflow + 微调 1px 把滚动层唤醒，再把位置还原。
    const box = $('#sessions');
    if (box) {
      void box.offsetHeight;
      const want = Math.max(0, state.listScroll || 0);
      box.scrollTop = want;
      requestAnimationFrame(() => {
        box.scrollTop = want + 1;
        requestAnimationFrame(() => { box.scrollTop = want; });
      });
      armFirstTouchProbe();
    }
  }
}

/** 诊断用：回到列表后第一次触摸如果 400ms 内没产生滚动，上报一次 */
function armFirstTouchProbe() {
  const box = $('#sessions');
  if (!box) return;
  const startTop = box.scrollTop;
  let done = false;
  const onMove = () => {
    if (done) return;
    done = true;
    setTimeout(() => {
      box.removeEventListener('touchmove', onMove);
      if (Math.abs(box.scrollTop - startTop) < 2) reportErr('first-touch-no-scroll build=' + BUILD);
    }, 400);
  };
  box.addEventListener('touchmove', onMove, { passive: true, once: true });
}

function closeSession() {
  const t0 = (performance && performance.now) ? performance.now() : Date.now();
  if (state.followWs) { try { state.followWs.close(); } catch {} state.followWs = null; }
  showView('list');
  const t1 = (performance && performance.now) ? performance.now() : Date.now();
  $('#title').textContent = 'DSH'; $('#pending').replaceChildren();
  state.view = 'list'; state.sessionId = null;
  requestAnimationFrame(() => {
    // 回到列表后再把聊天 DOM 清空（释放大快照/图片的内存与合成层，避免 iOS 卡几秒）
    setTimeout(() => {
      try {
        if (state.view !== 'list') return;
        const box2 = $('#messages'); if (box2) box2.replaceChildren();
        const others = ['#tasks', '#goalbar', '#queue', '#thumbs', '#pending'];
        for (const sel of others) { const e2 = $(sel); if (e2) { e2.replaceChildren(); e2.hidden = true; } }
        rendered.clear();
        const t2 = (performance && performance.now) ? performance.now() : Date.now();
        const total = t2 - t0;
        if (total > 500) reportErr('slow-back total=' + Math.round(total) + 'ms show=' + Math.round(t1 - t0) + 'ms clear=' + Math.round(t2 - (t1 + 0)));
      } catch {}
    }, 0);
  });
  // 列表数据延迟刷新：先保证能立刻滑动，不被重绘卡住；用户又点进会话就不刷了
  setTimeout(() => {
    if (state.view === 'list' && !state.touching) loadSessions().catch(() => {});
  }, 600);
}

function openFollow(sessionId) {
  if (state.followWs) { try { state.followWs.close(); } catch {} }
  const ws = new WebSocket(`wss://${location.host}${API_BASE}/api/remote.mux`);
  ws.__buf = ''; state.followWs = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'open', streamId: 'follow', endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 24 } } } }));
  };
  ws.onmessage = (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    if (f.type === 'item' && f.streamId === 'follow') onFollowValue(f.value);
    else if (f.type === 'error') toast('对话流错误：' + (f.error?.message || ''), 6000);
  };
  ws.onopen = ((orig) => () => {
    state.connState = 'ok'; renderStats();
    clearTimeout(state.followStableTimer);
    state.followStableTimer = setTimeout(() => { state.followRetry = 0; }, 5000);
    orig();
  })(ws.onopen);
  ws.onclose = () => {
    state.connState = 'reconnecting'; renderStats();
    if (state.view !== 'chat' || state.sessionId !== sessionId) { state.connState = 'ok'; return; }
    state.followRetry += 1;
    const delay = Math.min(800 * Math.pow(1.8, state.followRetry - 1), 15000);
    setTimeout(() => {
      if (state.view === 'chat' && state.sessionId === sessionId) openFollow(sessionId);
    }, delay);
  };
  ws.onerror = () => { /* 静默：锁屏/切后台导致的断连是常态，靠 onclose 重连即可 */ };
}

const rendered = new Set();
function onFollowValue(v) {
  if (!v) return;
  if (v.type === 'snapshot') {
    $('#messages').replaceChildren();
    rendered.clear();
    const box = $('#messages');
    for (const r of v.records || []) renderRecord(r, box);
    scrollBottom(true);
    return;
  }
  if (v.type === 'event') { renderRecord(v, $('#messages')); scrollBottom(); return; }
  if (v.type === 'assistant-stream') { onAssistantStream(v.frame); return; }
}

/** 按事件 seq 插入节点：重连/补发的事件可能乱序到达，按 seq 保证顺序（用户消息不会被放到思考行下面） */
function placeNode(box, node, seq) {
  if (seq) node.dataset.seq = String(seq);
  if (!seq) { box.appendChild(node); return node; }
  let ref = null;
  for (let i = box.children.length - 1; i >= 0; i -= 1) {
    const c = box.children[i];
    const cs = Number(c.dataset && c.dataset.seq);
    if (!cs) continue;
    if (cs <= seq) { ref = c.nextSibling; break; }
  }
  if (ref) box.insertBefore(node, ref); else box.appendChild(node);
  return node;
}

function renderRecord(rec, box) {
  const e = rec.event || rec;            // snapshot: {type:'event',event:{...}}  live: {type:'event',...}?
  if (!e || e.type === undefined) return;
  const key = e.seq ? e.seq + ':' + e.type : null;
  if (key && rendered.has(key)) return;
  if (key) rendered.add(key);
  const d = e.data || {};
  switch (e.type) {
    case 'user/message': {
      const src = d.source || {};
      // 只显示真人发的消息；runtime-context / time-context / harness 注入的不显示
      if (src.kind && src.kind !== 'user') break;
      // 自己刚发的那条已经在本地显示过，durable 事件回来时不要再加一遍
      if (src.rpcId) {
        const qi = state.queue.findIndex((q) => q.requestId === src.rpcId);
        if (qi >= 0) { state.queue.splice(qi, 1); renderQueue(); }
        if (state.shownRpc.has(src.rpcId)) break;   // 已本地显示过
      }
      const txt = textOf(d.content);
      if (txt) {
        const b = el('div', 'msg user');
        b.append(document.createTextNode(txt));
        b.append(makeFoot({ text: txt, time: e.time }));
        placeNode(box, b, e.seq);
      }
      break;
    }
    case 'assistant/message': {
      if (state.live?.bubble) { state.live.bubble.remove(); state.live = null; }
      const content = d.message?.content || d.content || [];
      const think = content.filter((p) => p?.type === 'reasoning').map((p) => p.text).join('\n');
      const txt = textOf(content);
      if (!txt && !think) break;
      if (think && state.turnStart) {
        if (!state.thinkRow || state.thinkRow.streamed === 0) appendThink(think);
      } else if (think && !state.turnStart) {
        const det = document.createElement('details');
        det.className = 'think turn-think';
        const sum = document.createElement('summary');
        sum.textContent = '已完成 · ' + think.length + ' 字 ⌄';
        const body = el('div', 'think-body', think.slice(0, 60000));
        det.append(sum, body);
        placeNode(box, det, e.seq);
      }
      if (!txt) break;
      const bubble = el('div', 'msg bot md');
      bubble.innerHTML = mdToHtml(txt);
      bubble.append(makeFoot({
        text: txt,
        usage: d.usage?.totalTokens,
        seq: e.seq,
        messageId: d.message?.id,
        time: e.time,
      }));
      placeNode(box, bubble, e.seq);
      break;
    }
    case 'step/start': state.turnSteps++; state.thinkPhase = 'thinking'; state.toolLabel = ''; break;
    case 'tool/call': {
      state.toolCount = (state.toolCount || 0) + 1;
      if (['create_goal', 'update_goal', 'get_goal'].includes(d.name)) setTimeout(() => refreshGoal().catch(() => {}), 600);
      if (d.name === 'todo_write') {
        try {
          const args = JSON.parse(d.arguments || '{}');
          if (Array.isArray(args.todos)) renderTasks(args.todos);
        } catch {}
      }
      state.thinkPhase = 'tool';
      let desc = '';
      try { desc = (JSON.parse(d.arguments || '{}').description || '').slice(0, 30); } catch {}
      const label = TOOL_LABELS[d.name] || d.name || '工具';
      state.toolLabel = desc ? (label + '：' + desc) : label;
      // 一次回合里只保留一条“工具调用”折叠行，避免一屏横条
      if (!state.toolRow) {
        const det = document.createElement('details');
        det.className = 'tool-row';
        const sum = document.createElement('summary');
        sum.textContent = '⚙ 工具调用 0 次 ⌄';
        const list = el('div', 'tool-list');
        det.append(sum, list);
        // 紧跟在动态状态行后面
        det.dataset.seq = String(e.seq || 0);
        if (state.thinkRow?.el?.parentNode === box) state.thinkRow.el.after(det);
        else placeNode(box, det, e.seq);
        state.toolRow = { el: det, sum, list, count: 0 };
      }
      state.toolRow.count += 1;
      state.toolRow.sum.textContent = '⚙ 工具调用 ' + state.toolRow.count + ' 次 ⌄';
      state.toolRow.list.append(el('div', 'tool-line', state.toolLabel));
      scrollBottom();
      renderThinkSummary();
      renderStats();
      break;
    }
    case 'approval/asked': placeNode(box, el('div', 'msg sys', '请求授权：' + (d.toolName || d.tool || '')), e.seq); break;
    case 'approval/decided': placeNode(box, el('div', 'msg sys', '授权结果：' + (d.outcome || '')), e.seq); break;
    case 'turn/start': {
      setRunning(true);
      state.thinkRow = null;
      state.turnStart = e.time || Date.now();
      state.turnSteps = 0;
      state.toolCount = 0;
      state.thinkStart = e.time || Date.now();
      state.toolRow = null;
      state.thinkPhase = 'thinking';
      state.toolLabel = '';
      state.thinkRow = makeThinkRow(box, e.seq);
      if (state.thinkRow) state.thinkRow.summary.textContent = '思考中…';
      renderStats();
      break;
    }
    case 'turn/end': {
      setRunning(false);
      clearLiveBubbles();   // 跑完就别留闪动的光标记号
      if (state.turnStart) {
        const dur = (e.time || Date.now()) - state.turnStart;
        placeNode(box, el('div', 'msg sys', `本轮用时 ${fmtDur(dur)}`), e.seq);
        state.turnStart = null;
        renderStats();
      }
      if (state.thinkRow) {
        const r = state.thinkRow;
        const secs = Math.max(1, Math.round(((e.time || Date.now()) - (state.thinkStart || 0)) / 1000));
        if (r.chars > 0) {
          r.summary.textContent = `已完成，用时 ${secs} 秒 ⌄`;
        } else {
          r.el.remove();
        }
        r.el.open = false;
        state.thinkRow = null;
      }
      refreshGoal().catch(() => {});
      const err = d.reason?.error?.message;
      if (err) box.append(el('div', 'msg sys', '出错：' + err));
      break;
    }
    default: break;
  }
}

function clearLiveBubbles() {
  document.querySelectorAll('#messages .msg.live').forEach((n) => n.remove());
  state.live = null;
}

function onAssistantStream(frame) {
  if (!frame) return;
  if (frame.type === 'start') {
    clearLiveBubbles();
    // 先不建气泡：模型可能只想很久不出字，空气泡+光标看着像 bug
    state.live = { attemptId: frame.attemptId, bubble: null };
    return;
  }
  if (!state.live || state.live.attemptId !== frame.attemptId) return;

  if (frame.type === 'chunk') {
    const c = frame.chunk || {};
    if (c.type === 'text-delta' && c.text) {
      if (!state.live.bubble) {
        const b = el('div', 'msg bot live');
        state.live.bubble = b;
        $('#messages').append(b);
      }
      state.live.bubble.append(document.createTextNode(c.text));
      scrollBottom();
    } else if (c.type === 'reasoning-delta' && c.text) {
      if (!state.thinkRow) state.thinkRow = makeThinkRow();
      state.thinkRow.streamed += c.text.length;
      appendThink(c.text);
    }
    return;
  }

  if (frame.type === 'end') {
    if (state.live.bubble) state.live.bubble.classList.remove('live');
  }
}

function updateJumpBtn() {
  const m = $('#messages'), b = $('#jumpbtn');
  if (!m || !b) return;
  const away = m.scrollHeight - m.scrollTop - m.clientHeight;
  const show = state.view === 'chat' && away > 200;
  if (b.hidden !== !show) b.hidden = !show;
}

function scrollBottom(force) {
  const m = $('#messages'); if (!m) return;
  const near = m.scrollHeight - m.scrollTop - m.clientHeight < 200;
  if (!force && !near) return;
  // 视图刚切过来 / 内容刚插入时高度还没算好，赋值会落空，所以多补几次
  const jump = () => { try { m.scrollTo({ top: m.scrollHeight, behavior: 'instant' }); } catch { m.scrollTop = m.scrollHeight; } };
  jump();
  requestAnimationFrame(jump);
  setTimeout(jump, 120);
  setTimeout(jump, 350);
}

/* ---------- 运行状态 / 停止 / 发送模式 ---------- */
function setRunning(running) {
  state.running = running;
  const stop = $('#stop'); if (stop) stop.hidden = !running;
}
async function stopRun() {
  if (!state.sessionId) return;
  try { await rpc('session/cancel', { request: { sessionId: state.sessionId } }); toast('已请求停止', 2000); }
  catch (e) { toast('停止失败：' + e.message, 4000); }
}


function fmtTokens(n) {
  if (!n) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
}
function fmtClock(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function makeFoot({ text, usage, seq, messageId, time }) {
  const foot = el('div', 'msg-foot');
  const copy = el('button', 'act', '⧉');
  copy.title = '复制';
  copy.onclick = async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(text || ''); toast('已复制', 1200); }
    catch { toast('复制失败', 2000); }
  };
  foot.append(copy);
  if (messageId) {
    const up = el('button', 'act', '👍');
    const down = el('button', 'act', '👎');
    const vote = async (rating, btn) => {
      btn.classList.add('on');
      try {
        await rpc('messageFeedback/put', { request: { sessionId: state.sessionId, messageId, rating, ifVersion: null } });
        toast(rating === 'positive' ? '已好评' : '已差评', 1500);
      } catch (err) {
        btn.classList.remove('on');
        toast('反馈失败：' + err.message, 3000);
      }
    };
    up.onclick = (e) => { e.stopPropagation(); vote('positive', up); };
    down.onclick = (e) => { e.stopPropagation(); vote('negative', down); };
    foot.append(up, down);
    const fork = el('button', 'act', '⑂');
    fork.title = '从这里分叉会话';
    fork.onclick = async (e) => {
      e.stopPropagation();
      if (!seq) { toast('这条消息不支持分叉', 2000); return; }
      try {
        const v = await rpc('session/fork', { request: { sessionId: state.sessionId, atSeq: seq } });
        toast('已创建分支会话', 2200);
        const sid = v?.sessionId || v?.id;
        await loadSessions().catch(() => {});
        if (sid) { const item = state.sessions.find((x) => x.sessionId === sid); if (item) openSession(item); }
      } catch (err) { toast('分叉失败：' + err.message, 3000); }
    };
    foot.append(fork);
  }
  if (usage) foot.append(el('span', 'usage', '用量 ' + fmtTokens(usage) + ' tok'));
  if (time) foot.append(el('span', 'time', fmtClock(time)));
  return foot;
}


/* ---------- 轻量 Markdown 渲染（先转义再拼标签，防注入） ---------- */
function escHtml(x) {
  return String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function mdInline(x) {
  let t = escHtml(x);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  return t;
}
function mdToHtml(src) {
  const text = String(src || '').replace(/\r\n/g, '\n');
  const blocks = [];
  // 先抽出围栏代码块，避免内部内容被当 Markdown
  const staged = text.replace(/```([\w+#.-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    blocks.push({ lang: (lang || '').trim(), code: code.replace(/\n$/, '') });
    return '\u0000CODE' + (blocks.length - 1) + '\u0000';
  });
  const lines = staged.split('\n');
  const out = [];
  let i = 0;
  let listType = null;
  const closeList = () => { if (listType) { out.push('</' + listType + '>'); listType = null; } };

  const isTableSep = (ln) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(ln.trim());
  const splitRow = (ln) => ln.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  while (i < lines.length) {
    let ln = lines[i];

    // 代码块占位
    const mCode = ln.match(/^\u0000CODE(\d+)\u0000$/);
    if (mCode) {
      closeList();
      const b = blocks[Number(mCode[1])];
      out.push('<pre><code>' + escHtml(b.code) + '</code></pre>');
      i += 1;
      continue;
    }

    if (!ln.trim()) { closeList(); i += 1; continue; }

    // 表格：当前行像表头且下一行是分隔行
    if (ln.trim().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList();
      const head = splitRow(ln);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(splitRow(lines[i])); i += 1; }
      let html = '<div class="tbl"><table><thead><tr>' + head.map((c) => '<th>' + mdInline(c) + '</th>').join('') + '</tr></thead><tbody>';
      for (const r of rows) html += '<tr>' + r.map((c) => '<td>' + mdInline(c) + '</td>').join('') + '</tr>';
      html += '</tbody></table></div>';
      out.push(html);
      continue;
    }

    // 标题
    let m = ln.match(/^(#{1,6})\s+(.*)$/);
    if (m) { closeList(); const lv = Math.min(m[1].length + 2, 6); out.push('<h' + lv + '>' + mdInline(m[2]) + '</h' + lv + '>'); i += 1; continue; }

    // 分隔线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(ln)) { closeList(); out.push('<hr>'); i += 1; continue; }

    // 引用
    if (/^\s*>\s?/.test(ln)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      out.push('<blockquote>' + mdInline(buf.join(' ')) + '</blockquote>');
      continue;
    }

    // 列表
    m = ln.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (m) {
      const want = /\d/.test(m[2]) ? 'ol' : 'ul';
      if (listType !== want) { closeList(); out.push('<' + want + '>'); listType = want; }
      out.push('<li>' + mdInline(m[3]) + '</li>');
      i += 1;
      continue;
    }

    // 普通段落（连续行合并）
    closeList();
    const para = [ln];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\u0000CODE|>\s?|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]) && !(lines[i].trim().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
      para.push(lines[i]); i += 1;
    }
    out.push('<p>' + mdInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
  }
  closeList();
  return out.join('\n');
}

/* ---------- 会话行操作（置顶 / 归档 / 重命名） ---------- */
function openRowMenu(it) {
  const sheet = $('#rowmenu'); const list = $('#row-list');
  if (!sheet || !list) return;
  $('#rowmenu-title').textContent = (it.projections?.values?.title || '会话') + '';
  list.replaceChildren();
  const pinned = state.pinned.has(it.sessionId);

  const mk = (icon, label, onclick, danger) => {
    const b = el('button', 'row-act' + (danger ? ' danger' : ''));
    b.append(el('span', 'ri', icon), el('span', 'rl', label));
    b.onclick = () => { sheet.hidden = true; onclick(); };
    return b;
  };

  list.append(mk('📌', pinned ? '取消置顶' : '置顶会话', async () => {
    try {
      await rpc(pinned ? 'workspace/unpinSession' : 'workspace/pinSession', { request: { sessionId: it.sessionId } });
      if (pinned) state.pinned.delete(it.sessionId); else state.pinned.add(it.sessionId);
      toast(pinned ? '已取消置顶' : '已置顶', 1600);
      await loadSessions();
    } catch (e) { toast('操作失败：' + e.message, 3500); }
  }));

  list.append(mk('✏️', '重命名', () => {
    // iOS 独立模式不支持 prompt()，改成面板内输入
    const cur = it.projections?.values?.title || '';
    list.replaceChildren();
    const row2 = el('div', 'gnew');
    const inp = el('input'); inp.value = cur; inp.placeholder = '新的会话标题';
    const save = el('button', null, '保存');
    const doRename = async () => {
      const title = inp.value.trim();
      if (!title || title === cur) { sheet.hidden = true; return; }
      try {
        await rpc('session/rename', { request: { sessionId: it.sessionId, title } });
        sheet.hidden = true;
        toast('已重命名', 1600);
        await loadSessions();
      } catch (e) { toast('重命名失败：' + e.message, 3500); }
    };
    save.onclick = doRename;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doRename(); } });
    row2.append(inp, save);
    list.append(row2);
    setTimeout(() => inp.focus(), 100);
  }));

  list.append(mk('🗄', '归档会话', async () => {
    try {
      await rpc('workspace/archiveSession', { request: { sessionId: it.sessionId, stopActivity: true } });
      state.archived.add(it.sessionId);
      toast('已归档', 1600);
      await loadSessions();
    } catch (e) { toast('归档失败：' + e.message, 3500); }
  }, true));

  sheet.hidden = false;
}

/* ---------- 加号菜单（对齐电脑端：添加 / 指令） ---------- */
function plusRow(icon, title, desc, onclick) {
  const row = el('button', 'plus-row');
  row.append(el('span', 'pi', icon), el('span', 'pt', title));
  if (desc) row.append(el('span', 'pd', desc));
  row.onclick = () => { $('#plusmenu').hidden = true; onclick(); };
  return row;
}

function openPlusMenu() {
  const box = $('#plus-list'); if (!box) return;
  box.replaceChildren();
  box.append(el('div', 'plus-sec', '添加'));
  box.append(plusRow('📄', '文件', '任意文件，上传后随消息发送', () => pickFileOnce({ multiple: true, onPick: pickFiles })));
  box.append(plusRow('🎯', '目标', '设置或查看长期任务目标', () => openGoalSheet()));
  box.append(el('div', 'plus-sec', '指令'));
  box.append(plusRow('⚙', '模型', '选择本会话使用的模型', () => openModelSheet().catch(() => {})));
  $('#plusmenu').hidden = false;
}

/* ---------- 目标（goals） ---------- */
const PHASE_TEXT = { active: '进行中', paused: '已暂停', blocked: '受阻', complete: '已完成' };

function renderGoal() {
  const bar = $('#goalbar'); if (!bar) return;
  const g = state.goal;
  if (!g) { bar.hidden = true; bar.replaceChildren(); return; }
  bar.hidden = false;
  bar.replaceChildren();
  bar.append(el('span', null, '🎯'), el('span', 'gobj', g.objective || '（目标）'),
    el('span', 'gphase', PHASE_TEXT[g.phase] || g.phase || ''));

  const quick = el('div', 'gquick');
  if (g.phase === 'active') {
    const p = el('button', null, '暂停');
    p.onclick = (e) => { e.stopPropagation(); goalAction('pause'); };
    quick.append(p);
  } else if (g.phase === 'paused') {
    const r = el('button', null, '继续');
    r.onclick = (e) => { e.stopPropagation(); goalAction('resume'); };
    quick.append(r);
  }
  const ed = el('button', null, '编辑');
  ed.onclick = (e) => { e.stopPropagation(); openGoalSheet(true); };
  quick.append(ed);
  bar.append(quick);
}

async function refreshGoal() {
  if (!state.sessionId) return;
  try {
    const v = await rpc('goals/get', { agentId: state.sessionId });
    state.goal = v || null;
  } catch { state.goal = null; }
  renderGoal();
}

async function goalAction(kind) {
  const g = state.goal; if (!g?.id) return;
  const args = { agentId: state.sessionId, ref: { id: g.id, revision: g.revision } };
  try {
    await rpc('goals/' + kind, args);
    toast('目标已' + ({ pause: '暂停', resume: '继续', complete: '完成', clear: '清除' }[kind] || kind), 1800);
    await refreshGoal();
    if ($('#goalsheet').hidden === false) openGoalSheet();
  } catch (e) { toast('操作失败：' + e.message, 4000); }
}

async function editGoal(objective) {
  const g = state.goal; if (!g?.id || !objective?.trim()) return;
  try {
    await rpc('goals/edit', { agentId: state.sessionId, ref: { id: g.id, revision: g.revision }, request: { objective: objective.trim() } });
    toast('目标已更新', 1800);
    await refreshGoal();
    openGoalSheet();
  } catch (e) { toast('修改失败：' + e.message, 4000); }
}

async function createGoal(objective) {
  if (!objective || !objective.trim()) return;
  try {
    await rpc('goals/create', { agentId: state.sessionId, request: { objective: objective.trim() } });
    toast('目标已创建', 2000);
    await refreshGoal();
    openGoalSheet();
  } catch (e) { toast('创建失败：' + e.message, 4000); }
}

function openGoalSheet(editMode) {
  const sheet = $('#goalsheet'); const body = $('#goal-body');
  if (!sheet || !body) return;
  sheet.hidden = false;
  body.replaceChildren();
  const g = state.goal;
  if (g) {
    body.append(el('div', 'gobj', g.objective || '（目标）'));
    body.append(el('div', 'gmeta',
      `状态：${PHASE_TEXT[g.phase] || g.phase} · 已进行 ${g.roundsStarted ?? 0}/${g.maxGoalRounds ?? '?'} 轮` +
      (g.phase === 'blocked' && g.blockedReason ? ` · 受阻原因：${g.blockedReason.message}` : '')));
    const btns = el('div', 'gbtns');
    if (g.phase === 'active') {
      const p = el('button', null, '暂停'); p.onclick = () => goalAction('pause'); btns.append(p);
      const c = el('button', 'primary', '标记完成'); c.onclick = () => goalAction('complete'); btns.append(c);
    } else if (g.phase === 'paused') {
      const r = el('button', 'primary', '继续'); r.onclick = () => goalAction('resume'); btns.append(r);
    } else if (g.phase === 'complete') {
      const cl = el('button', null, '清除目标'); cl.onclick = () => goalAction('clear'); btns.append(cl);
    }
    if (btns.children.length) body.append(btns);
  }
  const editing = !!(editMode && g);
  body.append(el('div', 'ghint', editing ? '修改目标内容：' : (g ? '创建新目标会替换当前目标：' : '当前没有目标，可以创建一个：')));
  const row = el('div', 'gnew');
  const inp = el('input');
  inp.placeholder = '目标内容，例如：完成手机端目标面板';
  if (editing) inp.value = g.objective || '';
  const btn = el('button', null, editing ? '保存' : '创建');
  btn.onclick = () => (editing ? editGoal(inp.value) : createGoal(inp.value));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); (editing ? editGoal : createGoal)(inp.value); } });
  row.append(inp, btn);
  body.append(row);
}

/* ---------- 目标任务（todo_write） ---------- */
const TASK_ICON = { completed: '✅', in_progress: '🔄', pending: '⬜', cancelled: '✖️' };

function renderTasks(todos) {
  const box = $('#tasks'); if (!box) return;
  box.replaceChildren();
  if (!todos || !todos.length) { box.hidden = true; return; }
  box.hidden = false;
  const done = todos.filter((t) => t.status === 'completed').length;
  const det = document.createElement('details');
  det.className = 'tasks';
  const sum = document.createElement('summary');
  sum.textContent = `目标任务 ${done}/${todos.length} 完成 ⌄`;
  det.append(sum);
  const ul = el('div', 'task-list');
  for (const t of todos) {
    const row = el('div', 'task-row');
    row.append(el('span', 'ti', TASK_ICON[t.status] || '⬜'), el('span', 'tx', t.content || ''));
    ul.append(row);
  }
  det.append(ul);
  box.append(det);
}

/* ---------- 思考行（一个回合一条，持续写入） ---------- */
const TOOL_LABELS = { bash: '运行命令', read: '读取文件', write: '写入文件', edit: '修改文件',
  glob: '查找文件', grep: '搜索内容', web_search: '搜索网页', web_fetch: '抓取网页', task: '子任务' };

function renderThinkSummary() {
  const r = state.thinkRow; if (!r) return;
  const secs = state.turnStart ? Math.round((Date.now() - state.turnStart) / 1000) : 0;
  if (state.thinkPhase === 'tool' && state.toolLabel) {
    r.summary.textContent = `${state.toolLabel} · 用时 ${secs} 秒`;
  } else {
    r.summary.textContent = secs > 0 ? `深度求索中，用时 ${secs} 秒…` : '深度求索中…';
  }
}

function makeThinkRow(seq) {
  const box = $('#messages');
  if (!box) return null;
  const det = document.createElement('details');
  det.className = 'think turn-think';
  const summary = document.createElement('summary');
  summary.textContent = '深度求索中…';
  const body = el('div', 'think-body');
  det.append(summary, body);
  placeNode(box, det, seq || 0);
  scrollBottom(true);
  return { el: det, summary, body, chars: 0, streamed: 0, seq: seq || 0 };
}

function clearThinkLine() {
  state.thinkRow = null;
  const box = $('#thinkline');
  if (box) { box.replaceChildren(); box.hidden = true; }
}

function appendThink(text) {
  if (!text) return;
  if (!state.thinkRow) state.thinkRow = makeThinkRow();
  const r = state.thinkRow;
  r.chars += text.length;
  if (r.body.textContent.length < 60000) r.body.append(document.createTextNode(text));
  renderThinkSummary();
  if (r.el.open) r.body.scrollTop = r.body.scrollHeight;
  if (r.el.open) scrollBottom();
}

/* ---------- 等待区（排队消息） ---------- */
function renderQueue() {
  const box = $('#queue'); if (!box) return;
  box.replaceChildren();
  if (!state.queue.length) { box.hidden = true; return; }
  box.hidden = false;
  state.queue.forEach((item, i) => {
    const row = el('div', 'qitem');
    row.append(el('span', 'tag', '排队中'), el('span', 't', item.text || '（消息）'));
    if (item.itemId) {
      const jump = el('button', 'steer', '插队');
      jump.onclick = async () => {
        jump.disabled = true;
        try {
          await rpc('session/updateQueue', { request: { sessionId: state.sessionId, itemId: item.itemId, action: { kind: 'steer' } } });
          state.queue.splice(i, 1); renderQueue();
          toast('已插队，马上插进当前回合', 2000);
        } catch (e) {
          jump.disabled = false;
          toast('插队失败：' + e.message, 4000);
        }
      };
      row.append(jump);
    }
    const x = el('button', null, '×');
    x.onclick = async () => {
      if (item.itemId) {
        try { await rpc('session/updateQueue', { request: { sessionId: state.sessionId, itemId: item.itemId, action: { kind: 'remove' } } }); }
        catch (e) { toast('取消失败：' + e.message, 4000); return; }
      }
      state.queue.splice(i, 1); renderQueue();
    };
    row.append(x);
    box.append(row);
  });
}

function spliceQueue(d2) {
  if (d2.target !== 'next-turn') return;   // 只关心“等下一轮”的排队区
  // 移除：host 的 start/removedCount 是按它自己的队列算的，
  // 本地还有“刚发出、host 尚未回执”的占位项，必须跳过它们。
  if (d2.removedCount) {
    let idx = d2.start, removed = 0;
    while (removed < d2.removedCount && idx < state.queue.length) {
      if (state.queue[idx].itemId) { state.queue.splice(idx, 1); removed += 1; }
      else idx += 1;
    }
  }
  (d2.inserted || []).forEach((it, idx) => {
    const rpcId = it.source?.rpcId;
    const txt = textOf(it.content) || '';
    const exist = rpcId ? state.queue.findIndex((q) => q.requestId === rpcId) : -1;
    if (exist >= 0) {
      // 本地已经有占位项：补上 host 分配的 itemId，避免出现两条
      state.queue[exist] = { ...state.queue[exist], itemId: it.id, text: txt || state.queue[exist].text };
    } else {
      state.queue.splice(d2.start + idx, 0, { itemId: it.id, requestId: rpcId, text: txt });
    }
  });
  renderQueue();
}

/* 保险：输入栏必须落在可视区里。若被推出（或上面留了大空），自动修正偏移 */
let clampTimer = null;
function clampComposer() {
  const vv = window.visualViewport;
  const comp = $('#composer'), app = document.getElementById('app');
  const root = document.documentElement;
  if (!comp || !app) return;
  // 键盘收起时必须完全复位，否则可能把整页推出屏幕（黑屏）
  if (!document.body.classList.contains('kb-open')) {
    root.style.setProperty('--vv-top', '0px');
    return;
  }
  if (!vv) return;
  const targetBottom = Math.round(vv.height);
  const rect = comp.getBoundingClientRect();
  const delta = Math.round(rect.bottom - targetBottom);
  if (Math.abs(delta) <= 6) return;
  if (Math.abs(delta) > 400) { root.style.setProperty('--vv-top', '0px'); return; }  // 异常值不复用
  const curTop = parseFloat(getComputedStyle(app).getPropertyValue('--vv-top')) || 0;
  const next = Math.max(-300, Math.min(300, curTop - delta));
  root.style.setProperty('--vv-top', Math.round(next) + 'px');
}
function scheduleClamp() {
  clearTimeout(clampTimer);
  clampTimer = setTimeout(clampComposer, 120);
  setTimeout(clampComposer, 450);
  setTimeout(clampComposer, 1200);
}

/* ---------- 图片 ---------- */
async function fileToImage(file) {
  const bitmap = await createImageBitmap(file);
  const MAX = 1600;
  let { width, height } = bitmap;
  const scale = Math.min(1, MAX / Math.max(width, height));
  width = Math.round(width * scale); height = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
  return { name: file.name || ('photo-' + Date.now() + '.jpg'), mediaType: 'image/jpeg', data: dataUrl.split(',')[1] };
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function renderThumbs() {
  const box = $('#thumbs');
  box.replaceChildren();
  if (!state.images.length && !state.files.length) { box.hidden = true; return; }
  box.hidden = false;
  state.images.forEach((img, i) => {
    const d = el('div', 'thumb');
    const im = document.createElement('img');
    im.src = 'data:' + img.mediaType + ';base64,' + img.data;
    const x = el('button', null, '×');
    x.onclick = () => { state.images.splice(i, 1); renderThumbs(); };
    d.append(im, x);
    box.append(d);
  });
  state.files.forEach((f, i) => {
    const d = el('div', 'fcard');
    d.append(el('div', 'n', f.name), el('div', 's', fmtBytes(f.bytes)));
    const x = el('button', null, '×');
    x.onclick = () => { state.files.splice(i, 1); renderThumbs(); };
    d.append(x);
    box.append(d);
  });
}

function resetViewportSoon() {
  const vv = window.visualViewport;
  const kb = vv ? (window.innerHeight - vv.height) > 120 : false;
  if (!kb) {
    document.documentElement.style.setProperty('--vv-top', '0px');
    document.documentElement.style.setProperty('--app-h', '100vh');
  }
  setTimeout(syncViewport, 200);
  setTimeout(syncViewport, 700);
}

async function handlePickedFiles(files) {
  const imgs = files.filter((f) => (f.type || '').startsWith('image/'));
  const others = files.filter((f) => !(f.type || '').startsWith('image/'));
  if (imgs.length) await pickImages(imgs);
  if (others.length) await pickFiles(others);
}

async function pickImages(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try { state.images.push(await fileToImage(f)); }
    catch { toast('图片处理失败：' + f.name, 4000); }
  }
  renderThumbs();
  resetViewportSoon();
}

/* ---------- 文件上传 ---------- */
async function uploadFile(file) {
  if (!state.sessionId) throw new Error('先进入一个会话');
  if (file.size > 60 * 1024 * 1024) throw new Error('文件太大（>60MB）');
  const url = `/api/session/uploadFileBinary?sessionId=${encodeURIComponent(state.sessionId)}&name=${encodeURIComponent(file.name)}`;
  const res = await fetch(url, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  const json = await res.json().catch(() => null);
  if (!json || json.ok !== true) throw new Error(json?.error?.message || ('上传失败 HTTP ' + res.status));
  return { receiptId: json.value.receiptId, name: json.value.file?.name || file.name, bytes: json.value.file?.bytes || file.size };
}

async function pickFiles(files) {
  for (const f of files) {
    try {
      const meta = await uploadFile(f);
      state.files.push(meta);
    } catch (e) { toast('文件上传失败：' + e.message, 5000); }
  }
  renderThumbs();
  resetViewportSoon();
}

/* ---------- 发送 ---------- */
function readInput() {
  const elm = $('#input');
  if (!elm) return '';
  return CE_MODE ? (elm.innerText || '').replace(/\u00a0/g, ' ').trim() : elm.value.trim();
}
function writeInput(v) {
  const elm = $('#input');
  if (!elm) return;
  if (CE_MODE) elm.textContent = v || ''; else elm.value = v || '';
  elm.style.height = 'auto';
}

async function sendPrompt() {
  const input = $('#input'); const text = readInput();
  const imgs = state.images.slice();
  const fls = state.files.slice();
  if ((!text && !imgs.length && !fls.length) || !state.sessionId) return;
  const content = [];
  for (const img of imgs) content.push({ type: 'image', mediaType: img.mediaType, data: img.data, name: img.name });
  for (const f of fls) content.push({ type: 'file', receiptId: f.receiptId });
  if (text) content.push({ type: 'text', text });
  const queued = state.mode === 'queue' && state.running;
  writeInput('');
  state.images = []; state.files = []; renderThumbs();
  const requestId = rid();
  const envId = rid();
  try {
    await rpc('session/prompt', { request: {
      requestId, sessionId: state.sessionId, mode: 'steer',
      content, clientTimeZone: nowTZ(),
    }}, { rpcId: envId });
    if (!queued) state.shownRpc.add(requestId);   // 实测 source.rpcId === 我们发的 requestId
    if (queued) {
      state.queue.push({ requestId, text: text || (imgs.length ? '［图片］' : '') + (fls.length ? '［文件］' : '') });
      renderQueue();
      scrollBottom(true);
      return;
    }
    const bubble = el('div', 'msg user');
    if (text) bubble.append(document.createTextNode(text));
    for (const img of imgs) {
      const im = document.createElement('img'); im.className = 'att';
      im.src = 'data:' + img.mediaType + ';base64,' + img.data;
      bubble.append(im);
    }
    for (const f of fls) bubble.append(el('div', 'fcard', '📎 ' + f.name));
    $('#messages').append(bubble);
    // 插话模式下当前回合还在跑：状态行要跟到这条消息下面，别停在上面
    if (state.thinkRow) {
      $('#messages').append(state.thinkRow.el);
      if (state.toolRow) $('#messages').append(state.toolRow.el);
    }
    scrollBottom(true);
    requestAnimationFrame(() => scrollBottom(true));
  } catch (e) {
    toast('发送失败：' + e.message, 5000);
    writeInput(text); state.images = imgs; state.files = fls; renderThumbs();
  }
}

/* ---------- 审批 / 提问（$events） ---------- */
function openEvents() {
  if (state.ws && state.ws.readyState <= 1) return;
  const ws = new WebSocket(`wss://${location.host}${API_BASE}/api/remote.mux`);
  state.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'open', streamId: 'ev', endpoint: '$events', payload: { args: {} } }));
  ws.onmessage = (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    if (f.type !== 'item' || f.streamId !== 'ev') return;
    const v = f.value || {};
    if (v.type === 'ready') { state.clientId = v.clientId; return; }
    if (v.type === 'waterfall') { state.pending.set(v.eventId, v); renderPending(); return; }
    if (v.type === 'cancel') { state.pending.delete(v.eventId); renderPending(); return; }
    if (v.type === 'emit') {
      const [sid, running] = v.args || [];
      if (v.event === 'api-session/status' && sid === state.sessionId && running === false) toast('这一轮跑完了', 2000);
      return;
    }
  };
  ws.onopen = ((orig) => () => { state.wsRetry = 0; orig(); })(ws.onopen);
  ws.onclose = () => {
    if (state.ws && state.ws.readyState <= 1) return;
    state.wsRetry += 1;
    const delay = Math.min(1000 * Math.pow(1.8, state.wsRetry - 1), 20000);
    setTimeout(() => { if (!state.ws || state.ws.readyState > 1) openEvents(); }, delay);
  };
}

function renderPending() {
  const box = $('#pending'); box.replaceChildren();
  for (const [eventId, wf] of state.pending) {
    // 不按 agentId 过滤：agentId 与 sessionId 的对应关系不保证一一相等，漏掉审批更糟
    const card = el('div', 'card');
    if (wf.event === 'approval/request') {
      const r = wf.request || {};
      card.append(el('div', 'h', '请求授权' + (r.toolName ? ' · ' + r.toolName : '')));
      card.append(el('div', 'b', String(r.reason || r.message || '需要你确认这个操作')));
      const btns = el('div', 'btns');
      const no = el('button', 'no', '拒绝'); no.onclick = () => answer(eventId, 'rejected');
      const ok = el('button', 'ok', '允许'); ok.onclick = () => answer(eventId, 'allowed-once');
      btns.append(no, ok); card.append(btns);
    } else if (wf.event === 'user-questions/request') {
      const qs = wf.request?.questions || [];
      card.append(el('div', 'h', '需要你回答'));
      const answers = [];
      for (const q of qs) {
        card.append(el('div', 'b', (q.header ? q.header + '：' : '') + (q.question || '')));
        const inp = el('input'); inp.placeholder = '输入回答…'; card.append(inp);
        answers.push({ q, inp });
      }
      const btns = el('div', 'btns');
      const ok = el('button', 'ok', '提交');
      ok.onclick = () => {
        const payload = { answers: answers.map(({ q, inp }) => ({ id: q.id, selected: [], custom: inp.value.trim() || null })) };
        answerRaw(eventId, payload);
      };
      btns.append(ok); card.append(btns);
    } else { continue; }
    box.append(card);
  }
}

async function answer(eventId, value) { return answerRaw(eventId, value); }

async function answerRaw(eventId, value) {
  if (!state.clientId) { toast('事件流未就绪，稍后重试', 3000); return; }
  try {
    await rpc('$events/result', {
      clientId: state.clientId, eventId,
      outcome: { kind: 'result', value },
    });
    state.pending.delete(eventId); renderPending();
  } catch (e) { toast('提交失败：' + e.message, 5000); }
}

/* ---------- 启动 ---------- */
$('#back').onclick = () => {
  if (history.state?.dshView === 'chat') history.back();
  else closeSession();
};
window.addEventListener('popstate', () => {
  if (state.view === 'chat') closeSession();
});
$('#newchat').onclick = () => createSession(null);
$('#bell').onclick = () => togglePush().catch(() => {});
updateBell().catch(() => {});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const d = ev.data || {};
    if (d.type === 'open-session' && d.sessionId) {
      const it = state.sessions.find((x) => x.sessionId === d.sessionId);
      if (it) openSession(it);
    }
  });
}
$('#stop').onclick = (e) => { e.preventDefault(); stopRun(); };
$('#sessions').addEventListener('touchstart', () => { state.touching = true; }, { passive: true });
$('#sessions').addEventListener('touchend', () => {
  state.touching = false;
  if (state.pendingListPaint) { const f = state.pendingListPaint; state.pendingListPaint = null; setTimeout(f, 30); }
}, { passive: true });
$('#sessions').addEventListener('touchcancel', () => {
  state.touching = false;
  if (state.pendingListPaint) { const f = state.pendingListPaint; state.pendingListPaint = null; setTimeout(f, 30); }
}, { passive: true });
$('#messages').addEventListener('scroll', updateJumpBtn, { passive: true });
$('#jumpbtn').onclick = () => { scrollBottom(true); updateJumpBtn(); };
$('#input').addEventListener('focus', () => { setTimeout(syncViewport, 120); setTimeout(syncViewport, 420); });
$('#input').addEventListener('blur', () => { setTimeout(syncViewport, 120); setTimeout(syncViewport, 420); });
// 文件选择器按需创建、用完立即移除：页面上只保留输入框一个表单控件，
// 免得 iOS 认为有多个字段而弹出「上一项/下一项/完成」辅助栏。
function pickFileOnce({ accept = '', multiple = false, onPick }) {
  const inp = document.createElement('input');
  inp.type = 'file';
  if (accept) inp.setAttribute('accept', accept);
  if (multiple) inp.multiple = true;
  inp.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0';
  inp.addEventListener('change', () => {
    const files = Array.from(inp.files || []);
    inp.remove();
    Promise.resolve(onPick(files)).catch(() => {});
  });
  document.body.appendChild(inp);
  inp.click();
}

function closeAttachMenu() { $('#attachmenu').hidden = true; }
$('#attach').onclick = (e) => { e.stopPropagation(); openGoalSheet(); };
$('#attachimg').onclick = (e) => {
  e.stopPropagation();
  // 不限制 accept：系统面板里照片/拍照/选取文件都能用；
  // 图片走压缩内联，其它文件走上传
  pickFileOnce({ multiple: true, onPick: handlePickedFiles });
};
const rowClose = $('#row-close'); if (rowClose) rowClose.onclick = () => { $('#rowmenu').hidden = true; };
const rowMask = $('#rowmenu')?.querySelector('.sheet-mask'); if (rowMask) rowMask.onclick = () => { $('#rowmenu').hidden = true; };
const plusClose = $('#plus-close'); if (plusClose) plusClose.onclick = () => { $('#plusmenu').hidden = true; };
const plusMask = $('#plusmenu')?.querySelector('.sheet-mask'); if (plusMask) plusMask.onclick = () => { $('#plusmenu').hidden = true; };
$('#pick-image').onclick = (e) => {
  e.stopPropagation(); closeAttachMenu();
  pickFileOnce({ accept: 'image/*', multiple: true, onPick: pickImages });
};
$('#pick-file').onclick = (e) => {
  e.stopPropagation(); closeAttachMenu();
  pickFileOnce({ multiple: true, onPick: pickFiles });
};
document.addEventListener('click', closeAttachMenu);
let verTaps = 0, verTapTimer = null;
let verHoldTimer = null;
$('#ver').addEventListener('pointerdown', () => {
  clearTimeout(verHoldTimer);
  verHoldTimer = setTimeout(() => { clearOfflineCache(); toast('已清除本地离线缓存', 2000); }, 900);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => $('#ver').addEventListener(ev, () => clearTimeout(verHoldTimer)));
$('#ver').addEventListener('click', () => {
  verTaps += 1;
  clearTimeout(verTapTimer);
  verTapTimer = setTimeout(() => { verTaps = 0; }, 800);
  if (verTaps >= 3) {
    verTaps = 0;
    localStorage.setItem('dshm.ce', CE_MODE ? '0' : '1');
    toast(CE_MODE ? '切回普通输入框…' : '切到富文本输入模式…', 1200);
    setTimeout(() => location.reload(), 600);
  }
});
$('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendPrompt(); });   // 回车走 keydown，这里只兜底
$('#input').addEventListener('focus', scheduleClamp);
$('#input').addEventListener('blur', scheduleClamp);
if (CE_MODE) {
  const ta = $('#input');
  const div = document.createElement('div');
  div.id = 'input';
  div.contentEditable = 'true';
  div.setAttribute('role', 'textbox');
  div.dataset.placeholder = '发消息…';
  ta.replaceWith(div);
}
$('#input').addEventListener('input', (e) => { const t = e.target; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 120) + 'px'; });
$('#input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.isComposing || e.keyCode === 229) return;   // 中文输入法组词中
  if (e.shiftKey) return;                            // Shift+Enter 换行
  e.preventDefault();
  sendPrompt();
});
let listTimer = null;
function startListPolling() {
  if (listTimer) return;
  listTimer = setInterval(() => {
    if (!document.hidden && state.view === 'list') loadSessions().catch(() => {});
  }, 15000);
}
// 上滑或点击消息区 -> 收起键盘（免得滚动时键盘一直挂着）
let msgTouchY = null;
$('#messages').addEventListener('touchstart', (e) => { msgTouchY = e.touches[0].clientY; }, { passive: true });
$('#messages').addEventListener('touchmove', (e) => {
  if (msgTouchY === null) return;
  const dy = Math.abs(e.touches[0].clientY - msgTouchY);
  if (dy > 14 && document.activeElement === $('#input')) $('#input').blur();
}, { passive: true });
$('#messages').addEventListener('touchend', () => { msgTouchY = null; }, { passive: true });

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  // 锁屏解锁后视口参数会短暂错乱：先复位，再在两次延迟后校准
  resumedAt = Date.now();
  baseH = Math.max(baseH, window.innerHeight);
  document.documentElement.style.setProperty('--app-h', baseH + 'px');
  document.documentElement.style.setProperty('--vv-top', '0px');
  document.body.classList.remove('kb-open');
  setTimeout(syncViewport, 60);
  setTimeout(syncViewport, 400);
  setTimeout(syncViewport, 1400);
  if (state.view === 'list') loadSessions().catch(() => {});
  // 锁屏/切后台会让 WS 被系统掐断：回到前台立刻重连，不等退避
  if (state.sessionId) {
    if (!state.followWs || state.followWs.readyState > 1) {
      state.followRetry = 0; openFollow(state.sessionId);
    }
    if (!state.ws || state.ws.readyState > 1) { state.wsRetry = 0; openEvents(); }
  }
});
window.addEventListener('online', () => {
  state.connState = 'ok';
  if (state.view === 'list') loadSessions().catch(() => {});
  if (state.sessionId) {
    if (!state.followWs || state.followWs.readyState > 1) { state.followRetry = 0; openFollow(state.sessionId); }
    if (!state.ws || state.ws.readyState > 1) { state.wsRetry = 0; openEvents(); }
  }
});
window.addEventListener('offline', () => { state.connState = 'offline'; renderStats(); });

// 列表页静默刷新：每 30 秒拉一次（/m/list 很轻），保证「运行中」标记不会一直停在旧状态
setInterval(() => {
  try {
    if (state.view !== 'list') return;
    if (document.visibilityState && document.visibilityState !== 'visible') return;
    loadSessions().catch(() => {});
  } catch {}
}, 30000);
document.addEventListener('visibilitychange', () => {
  try {
    if (document.visibilityState === 'visible' && state.view === 'list') loadSessions().catch(() => {});
  } catch {}
});
$('#goalbar').onclick = () => openGoalSheet();
$('#goal-close').onclick = () => { $('#goalsheet').hidden = true; };
$('#goalsheet').querySelector('.sheet-mask').onclick = () => { $('#goalsheet').hidden = true; };
$('#modelbar').onclick = () => openModelSheet().catch(() => {});
$('#sheet-close').onclick = closeModelSheet;
$('#modelsheet').querySelector('.sheet-mask').onclick = closeModelSheet;
bindPullToRefresh();
startListPolling();

/* iOS 键盘弹出时 innerHeight/100dvh 不会跟着变，导致输入框和键盘之间空一大块。
   用 visualViewport.height 实时同步 app 高度，输入框就会贴着键盘。 */
function showViewportDebug() {
  const elv = $('#ver'); if (!elv) return;
  elv.textContent = 'v' + BUILD;
}
let resumedAt = 0;
let baseH = window.innerHeight;   // 无键盘时的基准高度（取见过的最大值）

function syncViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  const h = vv ? Math.round(vv.height) : window.innerHeight;
  if (window.innerHeight > baseH || baseH < 300) baseH = window.innerHeight;
  const guarded = Date.now() - resumedAt < 1200;
  // 键盘弹起判定：可视高度比基准矮一大截（iOS 里 innerHeight 和 vv.height 都可能变小）
  const keyboardOpen = !guarded && (baseH - Math.min(window.innerHeight, h) > 120);
  if (keyboardOpen) {
    root.style.setProperty('--app-h', h + 'px');
    root.style.setProperty('--vv-top', Math.round(vv ? (vv.offsetTop || 0) : 0) + 'px');
  } else {
    const closedH = (baseH > 300 ? baseH : window.innerHeight) || window.innerHeight;
    root.style.setProperty('--app-h', Math.max(300, Math.round(closedH)) + 'px');
    root.style.setProperty('--vv-top', '0px');
  }
  document.body.classList.toggle('kb-open', keyboardOpen);
  scheduleClamp();
  const elv = $('#ver');
  if (elv) elv.textContent = 'v' + BUILD;
  if (state.view === 'chat') scrollBottom(true);
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewport);
  window.visualViewport.addEventListener('scroll', syncViewport);
}
window.addEventListener('orientationchange', () => setTimeout(syncViewport, 250));
window.addEventListener('resize', syncViewport);
setTimeout(syncViewport, 0);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { scope: IS_RC2 ? '/m2/' : '/m/' })
    .then((reg) => reg.update().catch(() => {}))   // 每次打开都检查 SW 是否有更新
    .catch(() => {});
}

function showVersion() { const el0 = $('#ver'); if (el0) el0.textContent = 'v' + BUILD; }
showVersion();

(async function boot() {
  $('#messages').replaceChildren();
  $('#gate-btn').onclick = () => {
    const inp = $('#gate-pass');
    const pw = inp && inp.value ? inp.value.trim() : '';
    if (pw) { passwordLogin(pw).catch(() => {}); return; }
    hideGate();
    login().catch(() => {});
  };
  const offBtn = $('#gate-offline');
  if (offBtn) offBtn.onclick = () => {
    if (renderFromCache()) { hideGate(); toast('已进入离线缓存视图', 2500); }
    else toast('还没有缓存数据', 2500);
  };
  const passEl = $('#gate-pass');
  if (passEl) passEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#gate-btn').click(); } });
  await ensureAuthCookie();
  // 等归档集合到位再拉列表，避免先闪出已归档会话
  const archivedGate = new Promise((resolve) => { state.archivedReady = resolve; });
  openWorkspaceStream();
  await Promise.race([archivedGate, new Promise((r) => setTimeout(r, 1500))]);
  // 先用本地缓存把列表画出来（服务器慢时也不至于白屏）
  let cachedShown = false;
  try { cachedShown = renderFromCache(); hideGate(); } catch (e) { reportErr('renderFromCache failed', e); }
  try {
    await loadSessions();
    hideGate();
  } catch (e) {
    reportErr('boot load failed', e);
    if (cachedShown) { toast('刷新失败（正在显示缓存列表）：' + e.message, 4000); return; }
    reportErr('boot gate: ' + e.message, e);
    if (/未登录/.test(e.message)) { showGate('需要登录后才能查看会话'); return; }
    showGate('加载失败：' + e.message + '\n点下面按钮重试');
    return;
  }
  openEvents();
})();
