'use strict';
const CE_MODE = localStorage.getItem('dshm.ce') === '1';   // 富文本输入模式（实验）

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

const BUILD = '91';   // 部署时由脚本替换成时间戳
/* DSH 移动端 PWA —— 会话列表 / 对话流 / 发消息 / 双向审批
 * 协议：POST /api/<method> {type:'client-request',rpcId,method,payload:{args}}
 *       WS  /api/remote.mux  {type:'open',streamId,endpoint,payload:{args}} */

const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const rid = () => 'w-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const nowTZ = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const state = { workspaces: [], archived: new Set(), view: 'list', sessions: [], sessionId: null, clientId: null, pending: new Map(), ws: null, followWs: null, live: null, running: false, mode: 'queue', images: [], files: [], toolCount: 0, shownRpc: new Set(), queue: [], thinkRow: null, thinkPhase: 'thinking', toolLabel: '', catalog: null, model: null, stats: null, turnStart: null, turnSteps: 0, ticker: null, followRetry: 0, wsRetry: 0, connState: 'ok' };

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------- 认证 ---------- */
async function rpc(method, args, { retry = true, rpcId } = {}) {
  const envId = rpcId || rid();
  const body = JSON.stringify({ type: 'client-request', rpcId: envId, method, payload: { args: args ?? {} } });
  const res = await fetch(`/api/${method}`, {
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

async function login() {
  if (loginAttempted) { showGate('登录失败，请关掉页面重新打开'); throw new Error('未登录'); }
  loginAttempted = true;
  showGate('正在登录…');
  try {
    const tok = (await (await fetch('/_dsh/token', { credentials: 'same-origin' })).text()).trim();
    if (!tok) throw new Error('拿不到令牌');
    // 走 nginx 跳板：/m/login?token=… -> DSH 种 30 天 cookie -> 303 回到 /m/
    location.replace('/m/login?token=' + encodeURIComponent(tok));
    await new Promise(() => {});
  } catch (e) {
    loginAttempted = false;
    showGate('自动登录失败：' + e.message + '\n点下面按钮重试，或先在 Safari 里打开本页并输入密码。');
    throw e;
  }
}

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
  const ws = new WebSocket(`wss://${location.host}/api/remote.mux`);
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
    if (changed) {
      if (state.archivedReady) state.archivedReady();
      if (state.view === 'list') loadSessions().catch(() => {});
    }
  };
  ws.onclose = () => setTimeout(openWorkspaceStream, 3000);
}

/* ---------- 会话列表 ---------- */
async function loadSessions() {
  const value = await rpc('session/list', { _request: {} });
  const items = (value?.items || [])
    .filter((it) => !state.archived.has(it.sessionId))          // 归档会话不显示（和电脑端一致）
    .filter((it) => it.blank !== true)                          // 空白会话不显示（电脑端也不显示）
    .slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  state.sessions = items;
  const box = $('#sessions'); box.replaceChildren();
  if (!items.length) { box.append(el('div', 'empty', '还没有会话')); return; }

  // 按工作区分组（和电脑端侧栏一致）
  const wsOf = (sid) => state.workspaces.find((w) => w.sessionIds.has(sid));
  const used = new Set();
  const groups = [];
  for (const w of state.workspaces) {
    const list = items.filter((it) => w.sessionIds.has(it.sessionId));
    if (list.length) { groups.push({ title: w.title, path: w.path, list }); list.forEach((x) => used.add(x.sessionId)); }
  }
  const rest = items.filter((it) => !used.has(it.sessionId));
  if (rest.length) groups.push({ title: '未分组', path: '', list: rest });

  for (const g of groups) {
    const h = el('div', 'ws-group');
    h.append(el('span', 'ws-title', g.title));
    if (g.path) h.append(el('span', 'ws-path', g.path));
    box.append(h);
    for (const it of g.list) box.append(buildRow(it));
  }
  return;
}

function buildRow(it) {
  {
    const v = it.projections?.values || {};
    const row = el('div', 'row');
    row.append(el('div', 't', v.title || (it.blank ? '（空白会话）' : it.sessionId.slice(8, 16))));
    const meta = el('div', 'm');
    meta.append(el('span', null, it.cwd ? it.cwd.split('/').slice(-2).join('/') : ''),
      el('span', null, fmtTime(it.updatedAt || Date.now())));
    if (it.running) meta.append(el('span', 'badge run', '运行中'));
    if (v.sessionStats?.turns) meta.append(el('span', 'badge', v.sessionStats.turns + ' 轮'));
    row.append(meta);
    row.onclick = () => openSession(it);
    return row;
  }
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
      row.onclick = () => selectModel(g.id, model).catch(() => {});
      list.append(row);
    }
  }
}

async function selectModel(provider, model) {
  if (!state.sessionId) return;
  // 尽量沿用当前 reasoningEffort；模型不支持就用它自己的最大档
  const efforts = (model.reasoning?.efforts || []).map((x) => x.id);
  let effort = state.model?.reasoningEffort;
  if (!effort || (efforts.length && !efforts.includes(effort))) {
    effort = efforts.includes('max') ? 'max' : (efforts[efforts.length - 1] || undefined);
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

/* ---------- 下拉刷新 ---------- */
function bindPullToRefresh() {
  const scroller = $('#sessions');
  const ptr = $('#ptr');
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
    try {
      // 先看有没有新版本：有就整页重载，顺带把代码更新掉
      const r = await fetch('/m/build.txt?t=' + Date.now(), { cache: 'no-store' });
      const remote = (await r.text()).trim();
      if (remote && remote !== String(BUILD)) {
        ptr.textContent = '发现新版本，正在更新…';
        location.reload();
        return;
      }
      await loadSessions();
    } catch (e) { toast('刷新失败：' + e.message, 4000); }
    busy = false;
    ptr.classList.remove('loading');
    ptr.textContent = '已刷新';
    setTimeout(() => { ptr.classList.remove('on'); ptr.textContent = '下拉刷新'; }, 450);
  };
  scroller.addEventListener('touchend', finish, { passive: true });
  scroller.addEventListener('touchcancel', finish, { passive: true });
}

/* ---------- 会话详情 ---------- */
async function openSession(it) {
  state.sessionId = it.sessionId;
  const v = it.projections?.values || {};
  $('#title').textContent = v.title || it.sessionId.slice(8, 16);
  showView('chat');
  $('#messages').replaceChildren(el('div', 'empty', '加载中…'));
  state.view = 'chat';
  state.live = null; setRunning(false);
  state.shownRpc = new Set();
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
  await openEvents();            // 审批流（全局长连）
  openFollow(it.sessionId);      // 对话流
}

function showView(name) {
  const chat = name === 'chat';
  $('#view-chat').hidden = !chat;
  $('#view-list').hidden = chat;
  $('#back').hidden = !chat;
  if (!chat) { $('#title').textContent = 'DSH'; stopTicker(); }
}

function closeSession() {
  if (state.followWs) { try { state.followWs.close(); } catch {} state.followWs = null; }
  showView('list');
  $('#title').textContent = 'DSH'; $('#pending').replaceChildren();
  state.view = 'list'; state.sessionId = null;
}

function openFollow(sessionId) {
  if (state.followWs) { try { state.followWs.close(); } catch {} }
  const ws = new WebSocket(`wss://${location.host}/api/remote.mux`);
  ws.__buf = ''; state.followWs = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'open', streamId: 'follow', endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 80 } } } }));
  };
  ws.onmessage = (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    if (f.type === 'item' && f.streamId === 'follow') onFollowValue(f.value);
    else if (f.type === 'error') toast('对话流错误：' + (f.error?.message || ''), 6000);
  };
  ws.onopen = ((orig) => () => { state.followRetry = 0; state.connState = 'ok'; renderStats(); orig(); })(ws.onopen);
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
      if (txt) box.append(el('div', 'msg user', txt));
      break;
    }
    case 'assistant/message': {
      if (state.live?.bubble) { state.live.bubble.remove(); state.live = null; }
      const content = d.message?.content || d.content || [];
      const think = content.filter((p) => p?.type === 'reasoning').map((p) => p.text).join('\n');
      const txt = textOf(content);
      if (!txt && !think) break;
      if (think && (!state.thinkRow || state.thinkRow.streamed === 0)) appendThink(think);   // 流式已写过的不要重复
      if (!txt) break;
      const bubble = el('div', 'msg bot');
      bubble.append(document.createTextNode(txt));
      box.append(bubble);
      break;
    }
    case 'step/start': state.turnSteps++; state.thinkPhase = 'thinking'; state.toolLabel = ''; break;
    case 'tool/call': {
      state.toolCount = (state.toolCount || 0) + 1;
      state.thinkPhase = 'tool';
      let desc = '';
      try { desc = (JSON.parse(d.arguments || '{}').description || '').slice(0, 30); } catch {}
      const label = TOOL_LABELS[d.name] || d.name || '工具';
      state.toolLabel = desc ? (label + '：' + desc) : label;
      renderThinkSummary();
      renderStats();
      break;
    }
    case 'approval/asked': box.append(el('div', 'msg sys', '请求授权：' + (d.toolName || d.tool || ''))); break;
    case 'approval/decided': box.append(el('div', 'msg sys', '授权结果：' + (d.outcome || ''))); break;
    case 'turn/start': {
      setRunning(true);
      state.turnStart = e.time || Date.now();
      state.turnSteps = 0;
      state.toolCount = 0;
      state.thinkStart = e.time || Date.now();
      state.thinkPhase = 'thinking';
      state.toolLabel = '';
      state.thinkRow = makeThinkRow(box);
      if (state.thinkRow) state.thinkRow.summary.textContent = '思考中…';
      renderStats();
      break;
    }
    case 'turn/end': {
      setRunning(false);
      if (state.turnStart) {
        const dur = (e.time || Date.now()) - state.turnStart;
        box.append(el('div', 'msg sys', `本轮用时 ${fmtDur(dur)}`));
        state.turnStart = null;
        renderStats();
      }
      if (state.thinkRow) {
        const r = state.thinkRow;
        if (r.chars > 0) {
          const secs = Math.max(1, Math.round(((e.time || Date.now()) - (state.thinkStart || 0)) / 1000));
          r.summary.textContent = `已完成，用时 ${secs} 秒 · ${r.chars} 字`;
        } else {
          r.el.remove();
        }
        r.el.open = false;
        state.thinkRow = null;
      }
      const err = d.reason?.error?.message;
      if (err) box.append(el('div', 'msg sys', '出错：' + err));
      break;
    }
    default: break;
  }
}

function onAssistantStream(frame) {
  if (!frame) return;
  if (frame.type === 'start') {
    const bubble = el('div', 'msg bot live');
    bubble.dataset.attempt = frame.attemptId || '';
    const think = el('div', 'think-live'); think.hidden = true;
    const text = el('div', 'live-text');
    bubble.append(think, text);
    $('#messages').append(bubble);
    state.live = { attemptId: frame.attemptId, bubble, think, text, thinkChars: 0, thinking: false };
    if (!state.thinkStart) state.thinkStart = Date.now();
    scrollBottom(true);
    return;
  }
  if (!state.live || state.live.attemptId !== frame.attemptId) return;
  if (frame.type === 'chunk') {
    const c = frame.chunk || {};
    if (c.type === 'text-delta' && c.text) {
      if (state.live.thinking) { state.live.think.hidden = true; state.live.thinking = false; }
      state.live.text.append(document.createTextNode(c.text));
      scrollBottom();
    } else if (c.type === 'reasoning-delta' && c.text) {
      if (!state.thinkRow) state.thinkRow = makeThinkRow($('#messages'));
      state.thinkRow.streamed += c.text.length;
      appendThink(c.text);
      if (!state.live.thinking) { state.live.thinking = true; state.live.think.hidden = false; }
      state.live.think.textContent = '思考中…';
    }
    return;
  }
  if (frame.type === 'end') {
    if (state.live.bubble) state.live.bubble.classList.remove('live');
    return;
  }
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
function bindMode() {
  const btn = $('#mode'); if (!btn) return;
  btn.textContent = state.mode === 'steer' ? '插话' : '排队';
  btn.classList.toggle('steer', state.mode === 'steer');
  btn.onclick = () => {
    state.mode = state.mode === 'steer' ? 'queue' : 'steer';
    btn.textContent = state.mode === 'steer' ? '插话' : '排队';
    btn.classList.toggle('steer', state.mode === 'steer');
    toast(state.mode === 'steer' ? '插话模式：这条会直接插进当前回合' : '排队模式：等这一轮跑完再发', 2200);
  };
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

function makeThinkRow(box) {
  const det = document.createElement('details');
  det.className = 'think';
  const summary = document.createElement('summary');
  summary.textContent = '思考中…';
  const body = el('div', 'think-body');
  det.append(summary, body);
  box.append(det);
  scrollBottom();
  return { el: det, summary, body, chars: 0, streamed: 0 };
}

function appendThink(text) {
  if (!text) return;
  if (!state.thinkRow) state.thinkRow = makeThinkRow($('#messages'));
  const r = state.thinkRow;
  r.chars += text.length;
  if (r.body.textContent.length < 60000) {
    r.body.append(document.createTextNode(r.body.textContent ? '\n\n' + text : text));
  }
  renderThinkSummary();
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

async function pickImages(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try { state.images.push(await fileToImage(f)); }
    catch { toast('图片处理失败：' + f.name, 4000); }
  }
  renderThumbs();
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
      requestId, sessionId: state.sessionId, mode: state.mode,
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
  const ws = new WebSocket(`wss://${location.host}/api/remote.mux`);
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
$('#back').onclick = closeSession;
$('#refresh').onclick = () => { if (state.view === 'list') loadSessions().catch((e) => toast(e.message)); else if (state.sessionId) { const it = state.sessions.find((s) => s.sessionId === state.sessionId); if (it) openSession(it); } };
$('#stop').onclick = (e) => { e.preventDefault(); stopRun(); };
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

$('#attach').onclick = () => pickFileOnce({ accept: 'image/*', multiple: true, onPick: pickImages });
$('#attachfile').onclick = () => pickFileOnce({ multiple: true, onPick: pickFiles });
let verTaps = 0, verTapTimer = null;
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
bindMode();
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
  navigator.serviceWorker.register('sw.js', { scope: '/m/' })
    .then((reg) => reg.update().catch(() => {}))   // 每次打开都检查 SW 是否有更新
    .catch(() => {});
}

function showVersion() { const el0 = $('#ver'); if (el0) el0.textContent = 'v' + BUILD; }
showVersion();

(async function boot() {
  $('#messages').replaceChildren();
  $('#gate-btn').onclick = () => { hideGate(); login().catch(() => {}); };
  await ensureAuthCookie();
  // 等归档集合到位再拉列表，避免先闪出已归档会话
  const archivedGate = new Promise((resolve) => { state.archivedReady = resolve; });
  openWorkspaceStream();
  await Promise.race([archivedGate, new Promise((r) => setTimeout(r, 1500))]);
  try {
    await loadSessions();
    hideGate();
  } catch (e) {
    if (/未登录/.test(e.message)) { showGate('需要登录后才能查看会话'); return; }
    showGate('加载失败：' + e.message + '\n点下面按钮重试');
    return;
  }
  openEvents();
})();
