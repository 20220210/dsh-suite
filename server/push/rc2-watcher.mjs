// rc.2 实例的事件监听：把「回合结束 / 需要审批 / 需要回答」转给主推送服务（复用订阅与 Web Push）
import fs from 'node:fs';
import { WebSocket } from 'ws';

const DSH = 'http://127.0.0.1:3081';
const BRIDGE = 'http://127.0.0.1:19393';
const NOTIFY = 'http://127.0.0.1:19400/push/notify';
const STORE = '/root/.dsh-rc2/storages/workspace.json';
const log = (...a) => console.log(new Date().toISOString(), ...a);

let cookie = '';
let cookieAt = 0;
let titles = new Map();
let grouped = new Set();
let groupedAt = 0;
let ws = null;
let retry = 0;

async function getCookie(force) {
  if (!force && cookie && Date.now() - cookieAt < 4 * 60 * 1000) return cookie;
  const r = await fetch(`${BRIDGE}/cookie`);
  if (!r.ok) throw new Error('bridge ' + r.status);
  const v = r.headers.get('x-rc2-cookie') || '';
  if (!v) throw new Error('cookie 为空');
  cookie = v;
  cookieAt = Date.now();
  return cookie;
}

async function rpc(method, args) {
  const r = await fetch(`${DSH}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: await getCookie() },
    body: JSON.stringify({ type: 'client-request', rpcId: 'rc2push-' + Date.now(), method, payload: { args } }),
  });
  const j = await r.json();
  if (j.result?.ok !== true) throw new Error(method + ': ' + (j.result?.error?.message || 'fail'));
  return j.result.value;
}

async function refreshTitles() {
  try {
    const v = await rpc('session/list', { _request: {} });
    titles = new Map((v.items || []).map((it) => [it.sessionId, it.projections?.values?.title || '会话']));
    log('标题已刷新', titles.size, '个会话');
  } catch (e) { log('刷新标题失败', String(e.message).slice(0, 120)); }
}

function loadGrouped() {
  if (groupedAt && Date.now() - groupedAt < 60 * 1000) return grouped;
  try {
    const d = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    const set = new Set();
    for (const w of Object.values(d?.tables?.workspaces || {})) {
      for (const sid of w?.sessionIds || []) set.add(sid);
    }
    grouped = set;
    groupedAt = Date.now();
  } catch (e) { log('读取工作区失败', String(e.message).slice(0, 100)); }
  return grouped;
}

async function notify(payload) {
  try {
    const r = await fetch(NOTIFY, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, inst: 'rc2' }),
    });
    const j = await r.json().catch(() => ({}));
    log('转发推送', payload.tag, 'sent=' + (j.sent ?? '?'));
  } catch (e) { log('转发推送失败', String(e.message).slice(0, 120)); }
}

function connect() {
  if (ws) { try { ws.close(); } catch {} }
  getCookie().then((ck) => {
    ws = new WebSocket(`ws://127.0.0.1:3081/api/remote.mux`, { headers: { cookie: ck } });
    ws.on('open', () => {
      retry = 0;
      ws.send(JSON.stringify({ type: 'open', streamId: 'rc2push', endpoint: '$events', payload: { args: {} } }));
      log('rc.2 事件监听已连接');
    });
    ws.on('message', async (raw) => {
      let f; try { f = JSON.parse(raw.toString()); } catch { return; }
      if (f.type !== 'item' || f.streamId !== 'rc2push') return;
      const v = f.value || {};
      const isGrouped = (sid) => !sid || loadGrouped().has(sid);
      try {
        if (v.type === 'waterfall') {
          const sid = v.agentId || '';
          const title = titles.get(sid) || '会话';
          if (!isGrouped(sid)) return;
          if (v.event === 'approval/request') {
            const req = v.request || {};
            await notify({ title: '需要你审批（rc.2）', body: title + (req.toolName ? '：' + req.toolName : ''), sessionId: sid, tag: 'rc2-approval-' + v.eventId });
          } else if (v.event === 'user-questions/request') {
            const q = (v.request?.questions || [])[0]?.question || '需要你回答';
            await notify({ title: '需要你回答（rc.2）', body: title + '：' + String(q).slice(0, 60), sessionId: sid, tag: 'rc2-question-' + v.eventId });
          }
        } else if (v.type === 'emit' && v.event === 'api-session/status') {
          const [sid, running] = v.args || [];
          if (running === false && isGrouped(sid)) {
            await notify({ title: '已完成（rc.2）', body: titles.get(sid) || '会话已完成', sessionId: sid, tag: 'rc2-done-' + sid });
          }
        }
      } catch (e) { log('处理事件失败', String(e.message).slice(0, 120)); }
    });
    ws.on('close', () => {
      retry += 1;
      const delay = Math.min(2000 * retry, 30000);
      log('rc.2 事件连接断开，' + delay + 'ms 后重连');
      setTimeout(start, delay);
    });
    ws.on('error', (e) => log('rc.2 事件连接错误', String(e.message).slice(0, 120)));
  }).catch((e) => {
    retry += 1;
    const delay = Math.min(3000 * retry, 30000);
    log('rc.2 初始化失败，' + delay + 'ms 后重试：' + String(e.message).slice(0, 100));
    setTimeout(start, delay);
  });
}

async function start() {
  try {
    await refreshTitles();
    loadGrouped();
    connect();
  } catch (e) {
    retry += 1;
    log('rc.2 初始化失败，稍后重试：' + String(e.message).slice(0, 120));
    setTimeout(start, Math.min(3000 * retry, 30000));
  }
}

setInterval(() => { refreshTitles().catch(() => {}); }, 5 * 60 * 1000);
start();
