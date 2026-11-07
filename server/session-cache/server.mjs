// session/list 缓存层（带 mtime 增量）
//
// 背景：DSH 的 session/list 每次要遍历解析 133 个会话日志（解压后 1.5GB，单核 100~140 秒）。
// 原来这层只有「全量快照 + 过期先用旧值」：命中时很快，但每次刷新仍是一次 100 秒的全量。
//
// 这版加了增量：自己 stat 会话目录（18ms），按 mtime/size 判断哪些会话变了，
// 只对变了的会话读尾部 zstd 帧（每个 ~20-80ms）拿到最新 seq / 时间 / 标题，
// 直接补进上一份快照里 —— 绝大多数刷新根本不需要再问 DSH。
//
// 策略：
//   无变化            → 什么都不做（0 秒，也不打 DSH）
//   老会话有变化      → 尾部增量补丁（毫秒级，列表立刻更新）
//   出现/消失会话目录 → 触发一次全量刷新对账（去抖 + 有会话在跑就延后）
//   兜底              → 每 30 分钟或 /cache/refresh 手动全量一次
//
// 环境变量（都可不设）：DSH_CACHE_PORT / DSH_URL / DSH_BRIDGE / DSH_SESSIONS /
//                      DSH_CACHE_FILE / DSH_SCAN_MS / DSH_FULL_MIN_MS
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { WebSocket } from 'ws';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.DSH_CACHE_PORT || 19402);
const CACHE_FILE = process.env.DSH_CACHE_FILE || path.join(HERE, 'cache.json.gz');
const DSH = process.env.DSH_URL || 'http://127.0.0.1:3080';
const BRIDGE = process.env.DSH_BRIDGE || 'http://127.0.0.1:19391/token';
const SESSIONS = process.env.DSH_SESSIONS || '/root/.dsh/sessions';
const SCAN_MS = Number(process.env.DSH_SCAN_MS || 15000);          // 指纹扫描间隔
// 兜底全量间隔：增量能保证 updatedAt/title/asOfSeq 准，全量只是兜底对账，
// 所以默认拉到 6 小时，避免每次重启都吃一次 100 秒全量。
const FULL_MIN_MS = Number(process.env.DSH_FULL_MIN_MS || 6 * 60 * 60 * 1000);
const FRESH_MS = 10 * 60 * 1000;    // 10 分钟内视为新鲜
const STALE_MS = 2 * 60 * 60 * 1000; // 2 小时内可先返回旧数据
const STALE_FOR_REFRESH_MS = 60 * 60 * 1000;

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

let cookie = null;
let cache = { body: null, at: 0, obj: null };
let inflight = null;
let fullAt = 0;                       // 上次成功全量刷新时间
let fp = new Map();                   // sessionId -> { file, size, mtimeMs }
let fpReady = false;
let fullTimer = null;
const stats = { hit: 0, stale: 0, miss: 0, refreshOk: 0, refreshFail: 0 };
const istats = {
  scan: 0,          // 扫描次数
  scanMs: 0,        // 最近一次扫描耗时
  skip: 0,          // 无变化跳过次数
  patched: 0,       // 增量补丁次数
  patchRows: 0,     // 累计补上的行数
  patchMs: 0,       // 最近一次补丁耗时
  changed: 0,       // 最近一次扫描变化会话数
  added: 0,         // 累计新增会话目录
  removed: 0,       // 累计消失会话目录
  addedRows: 0,     // 就地补进快照的新增行
  removedRows: 0,   // 就地删掉的行
  deferrals: 0,     // 全量对账被「有会话在跑」延后的次数
  fullQueued: 0,    // 触发全量对账次数
  lastFullAt: 0,
  lastScanAt: 0,
};

// 会话实时运行状态：sid -> bool（事件流比缓存新，返回缓存时用它覆盖）
const runningLive = new Map();
// 自检用：事件流是否连着 / 连过几次 / 失败几次
let eventWatchUp = false;
let eventWatchConnects = 0;
let eventWatchFails = 0;

function log(...a) { console.log(new Date().toISOString(), ...a); }

function json(res, code, obj, extraHeaders = {}) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, ...extraHeaders });
  res.end(buf);
}

// ---------------------------------------------------------------- 运行状态事件流

function startEventWatch() {
  let fails = 0;
  let lastLog = 0;
  const connect = async () => {
    // 没有 cookie 时 WS 会被 401 拒掉；以前是启动就全量刷新顺带登录，
    // 改成「有缓存就不再全量」后 cookie 可能一直为空 → 事件流永远连不上，
    // running 状态就再也不更新（跑着的显示没跑、跑完的显示还在跑）。这里补上。
    if (!cookie) { try { await dshLogin(); } catch {} }
    let ws;
    try { ws = new WebSocket(`${DSH.replace(/^http/, 'ws')}/api/remote.mux`, { headers: cookie ? { cookie } : {} }); }
    catch { setTimeout(connect, 5000); return; }
    ws.on('open', () => {
      fails = 0;
      eventWatchUp = true;
      eventWatchConnects += 1;
      ws.send(JSON.stringify({ type: 'open', streamId: 'cache-ev', endpoint: '$events', payload: { args: {} } }));
      log('事件监听已连接（用于实时 running 状态）');
    });
    ws.on('message', (raw) => {
      let f; try { f = JSON.parse(raw.toString()); } catch { return; }
      if (f.type !== 'item' || f.streamId !== 'cache-ev') return;
      const v = f.value || {};
      if (v.type === 'emit' && v.event === 'api-session/status') {
        const [sid, running] = v.args || [];
        if (sid) runningLive.set(sid, running === true);
      }
    });
    ws.on('close', () => { eventWatchUp = false; setTimeout(connect, 3000); });
    ws.on('error', (e) => {
      fails += 1;
      eventWatchFails += 1;
      eventWatchUp = false;
      const now = Date.now();
      if (now - lastLog > 60000) {
        lastLog = now;
        log(`事件监听连接失败（第 ${fails} 次）：${String(e && e.message).slice(0, 80)}；cookie=${cookie ? '有' : '无'}`);
      }
      cookie = null;   // 可能是 cookie 过期，下次重连前重新登录
    });
  };
  connect();
}

// ---------------------------------------------------------------- 与 DSH 通信

async function dshLogin() {
  const token = (await (await fetch(BRIDGE)).text()).trim();
  const r = await fetch(`${DSH}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const c = setCookie.map((x) => x.split(';')[0]).join('; ');
  if (!c) throw new Error('登录未拿到 cookie');
  cookie = c;
}

/** 真实拉一次 session/list（全量，约 100 秒），返回响应 JSON 字符串。 */
async function fetchLive(bodyText) {
  if (!cookie) await dshLogin();
  const r = await fetch(`${DSH}/api/session/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: bodyText,
  });
  const text = await r.text();
  if (!r.ok) throw new Error('DSH 返回 ' + r.status);
  return text;
}

function getObj() {
  if (cache.obj) return cache.obj;
  try { cache.obj = JSON.parse(cache.body); } catch { cache.obj = null; }
  return cache.obj;
}

function itemsOf(obj) {
  const items = obj?.result?.value?.items;
  return Array.isArray(items) ? items : null;
}

function anySessionRunning() {
  const items = itemsOf(getObj());
  return Boolean(items && items.some((it) => it.running === true));
}

/** 全量刷新（唯一会占用 DSH 单核 100 秒的路径）。 */
async function refresh(reason, { force = false } = {}) {
  if (inflight) return inflight;
  if (!force && (reason === 'timer' || reason === 'stale') && anySessionRunning()) {
    log('有会话运行中，跳过本次全量(' + reason + ')');
    return null;
  }
  inflight = (async () => {
    const started = Date.now();
    try {
      const body = JSON.stringify({ type: 'client-request', rpcId: 'warm', method: 'session/list', payload: { args: { _request: {} } } });
      const text = await fetchLive(body);
      cache = { body: text, at: Date.now(), obj: null };
      fullAt = Date.now();
      istats.lastFullAt = fullAt;
      try {
        const gz = zlib.gzipSync(Buffer.from(text), { level: 3 });
        fs.writeFileSync(CACHE_FILE + '.tmp', gz);
        fs.renameSync(CACHE_FILE + '.tmp', CACHE_FILE);
      } catch (e) { log('缓存落盘失败', String(e.message).slice(0, 80)); }
      stats.refreshOk += 1;
      log(`全量刷新完成 ${((Date.now() - started) / 1000).toFixed(1)}s 大小=${(text.length / 1048576).toFixed(2)}MB (${reason || ''})`);
      // 刷新后重建指纹基线
      try {
        const next = scanDisk();
        const d = fingerprintDelta(fp, next);
        fp = next;
        fpReady = true;
        if (d.changed.length) log(`全量后仍有 ${d.changed.length} 个会话在变，下一轮继续用增量`);
      } catch (e) { log('重建指纹失败', String(e.message).slice(0, 80)); }
      return text;
    } catch (e) {
      stats.refreshFail += 1;
      log('全量刷新失败', String(e && e.message).slice(0, 120));
      if (String(e.message).includes('401') || String(e.message).includes('403')) cookie = null;
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 延后一次全量对账（去抖；有会话在跑就再等）。 */
function scheduleFull(reason, delay = 8000) {
  if (fullTimer) return;
  fullTimer = setTimeout(async () => {
    fullTimer = null;
    if (anySessionRunning()) {
      istats.deferrals += 1;
      if (istats.deferrals % 10 === 1) log(`有会话运行中，全量对账延后（已延后 ${istats.deferrals} 次；结构变化已就地增量处理）`);
      scheduleFull(reason, 60000);
      return;
    }
    istats.fullQueued += 1;
    istats.deferrals = 0;
    await refresh(reason, { force: true });
  }, delay);
  try { fullTimer.unref?.(); } catch {}
}

// ---------------------------------------------------------------- 磁盘指纹

/** 扫会话目录：sessionId -> { file, size, mtimeMs }（133 个日志约 18ms）。 */
function scanDisk() {
  const out = new Map();
  let projs;
  try { projs = fs.readdirSync(SESSIONS, { withFileTypes: true }); } catch { return out; }
  for (const p of projs) {
    if (!p.isDirectory() || p.name.startsWith('.')) continue;
    const pdir = path.join(SESSIONS, p.name);
    let ses;
    try { ses = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const s of ses) {
      if (!s.isDirectory()) continue;
      const sdir = path.join(pdir, s.name);
      let files;
      try { files = fs.readdirSync(sdir); } catch { continue; }
      let file = null;
      const v4 = files.find((f) => f.startsWith('session.v4') && f.endsWith('.jsonl.zstd'));
      if (v4) file = path.join(sdir, v4);
      else {
        const any = files.find((f) => f.endsWith('.jsonl.zstd'));
        if (any) file = path.join(sdir, any);
      }
      if (!file) continue;
      try {
        const st = fs.statSync(file);
        out.set(s.name, { file, size: st.size, mtimeMs: st.mtimeMs });
      } catch {}
    }
  }
  return out;
}

function fingerprintDelta(prev, next) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, v] of next) {
    const o = prev.get(id);
    if (!o) added.push(id);
    else if (o.size !== v.size || o.mtimeMs !== v.mtimeMs) changed.push(id);
  }
  for (const id of prev.keys()) if (!next.has(id)) removed.push(id);
  return { added, removed, changed };
}

// ---------------------------------------------------------------- 尾部增量读

/** 只解尾部最后 maxFrames 个 zstd 帧（帧可独立解压），拿到最近事件文本。 */
function tailText(file, size, { tailBytes = 512 * 1024, maxFrames = 60 } = {}) {
  const start = Math.max(0, size - tailBytes);
  const len = size - start;
  if (len <= 0) return '';
  const buf = Buffer.alloc(len);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
  } catch { return ''; }
  finally { try { if (fd !== undefined) fs.closeSync(fd); } catch {} }
  const offs = [];
  let i = buf.indexOf(MAGIC);
  while (i >= 0) { offs.push(i); i = buf.indexOf(MAGIC, i + 1); }
  if (offs.length === 0) return '';
  let k = Math.max(0, offs.length - maxFrames);
  const parts = [];
  while (k < offs.length) {
    const o = offs[k];
    let ok = false;
    for (let j = k + 1; j <= offs.length; j++) {
      const end = j < offs.length ? offs[j] : buf.length;
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(o, end)).toString('utf8'));
        k = j;
        ok = true;
        break;
      } catch {}
    }
    if (!ok) break; // 尾部第一个不完整帧，放弃剩下
  }
  return parts.join('');
}

/** 从尾部事件里取：最新 seq / 时间 / 标题 / 是否出现过用户消息。 */
function tailDigest(file, size) {
  const text = tailText(file, size);
  if (!text) return null;
  let lastSeq = -1;
  let lastTime = 0;
  let title = null;
  let hasUser = false;
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (typeof e.seq === 'number' && e.seq > lastSeq) lastSeq = e.seq;
    if (typeof e.time === 'number' && e.time > lastTime) lastTime = e.time;
    if (e.type === 'session/title' && e.data && typeof e.data.title === 'string') title = e.data.title;
    if (e.type === 'user/message') hasUser = true;
  }
  if (lastSeq < 0 && lastTime === 0) return null;
  return { lastSeq, lastTime, title, hasUser };
}

// ---------------------------------------------------------------- 增量补丁

/**
 * 把变化会话的最新信息补进上一份快照：
 *   updatedAt / projections.asOfSeq / projections.values.title / blank
 * 只在「新值更靠后」时才覆盖，避免把快照往回改。
 */
function patchCache(changedIds, digs) {
  const t0 = Date.now();
  const obj = getObj();
  const items = itemsOf(obj);
  if (!items) return 0;
  let rows = 0;
  for (const id of changedIds) {
    const d = digs.get(id);
    if (!d) continue;
    const it = items.find((x) => x?.sessionId === id);
    if (!it) continue; // 快照里没有的会话（新建）交给全量对账
    let touched = false;
    if (d.lastTime > 0 && d.lastTime > (it.updatedAt || 0)) { it.updatedAt = d.lastTime; touched = true; }
    const proj = it.projections;
    if (proj && typeof proj === 'object') {
      // 只补 title；asOfSeq 是「这份 projections 覆盖到哪个 seq」，抬高它会让前端
      // 以为中间的消息已经有了，从而跳过内容 → 表现为两端内容不同步。这里绝不改。
      if (d.title && proj.values && proj.values.title !== d.title) { proj.values.title = d.title; touched = true; }
    }
    if (d.hasUser && it.blank === true) { it.blank = false; touched = true; }
    if (touched) rows += 1;
  }
  if (rows === 0) return 0;
  cache.obj = obj;
  cache.body = JSON.stringify(obj);
  cache.at = Date.now();
  istats.patched += 1;
  istats.patchRows += rows;
  istats.patchMs = Date.now() - t0;
  try {
    const gz = zlib.gzipSync(Buffer.from(cache.body), { level: 3 });
    fs.writeFileSync(CACHE_FILE + '.tmp', gz);
    fs.renameSync(CACHE_FILE + '.tmp', CACHE_FILE);
  } catch {}
  return rows;
}

/** 解头部前若干帧（会话头事件在最前面），用于拿 cwd 等建行必需信息。 */
function headText(file, { headBytes = 128 * 1024, maxFrames = 8 } = {}) {
  const len = Math.min(headBytes, fs.statSync(file).size);
  if (len <= 0) return '';
  const buf = Buffer.alloc(len);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, 0);
  } catch { return ''; }
  finally { try { if (fd !== undefined) fs.closeSync(fd); } catch {} }
  const offs = [];
  let i = buf.indexOf(MAGIC);
  while (i >= 0 && offs.length <= maxFrames) { offs.push(i); i = buf.indexOf(MAGIC, i + 1); }
  const parts = [];
  for (let k = 0; k < offs.length; k++) {
    const o = offs[k];
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(o, end)).toString('utf8')); } catch { break; }
  }
  return parts.join('');
}

/** 会话头：cwd / parentSession。新会话建行必须靠它（cwd 缺失的行 DSH 自己也会丢）。 */
function headDigest(file) {
  const text = headText(file);
  if (!text) return null;
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'session') return { cwd: e.cwd, parentSession: e.parentSession, id: e.id };
  }
  return null;
}

/** 用日志自己造一行（新增会话用，不需要全量刷新）。 */
function buildRow(id, entry) {
  const head = headDigest(entry.file);
  if (!head || typeof head.cwd !== 'string' || !head.cwd) return null;
  const tail = tailDigest(entry.file, entry.size);
  const title = tail?.title || '';
  const updatedAt = tail?.lastTime || Math.round(entry.mtimeMs || Date.now());
  return {
    sessionId: id,
    updatedAt,
    agentAvailable: false,
    formatStatus: 'current',
    running: runningLive.get(id) === true,
    blank: !(tail?.hasUser),
    cwd: head.cwd,
    projections: {
      kind: 'sequenced',
      asOfSeq: 0,   // 保守值：不假装已覆盖到某个 seq，前端会自行拉取内容
      values: { title },
    },
  };
}

/** 落盘 + 更新内存快照。 */
function commitCache(obj) {
  cache.obj = obj;
  cache.body = JSON.stringify(obj);
  cache.at = Date.now();
  try {
    const gz = zlib.gzipSync(Buffer.from(cache.body), { level: 3 });
    fs.writeFileSync(CACHE_FILE + '.tmp', gz);
    fs.renameSync(CACHE_FILE + '.tmp', CACHE_FILE);
  } catch {}
}

/** 结构变化（新增/消失会话目录）就地增删行，不等全量刷新。 */
function applyStructural(delta, next) {
  const obj = getObj();
  const items = itemsOf(obj);
  if (!items) return { added: 0, removed: 0 };
  let addedRows = 0;
  let removedRows = 0;
  if (delta.removed.length) {
    const gone = new Set(delta.removed);
    for (let i = items.length - 1; i >= 0; i--) {
      if (gone.has(items[i]?.sessionId)) { items.splice(i, 1); removedRows += 1; }
    }
  }
  for (const id of delta.added) {
    if (items.some((x) => x?.sessionId === id)) continue;
    const entry = next.get(id);
    if (!entry) continue;
    let row = null;
    try { row = buildRow(id, entry); } catch (e) { log(`新增会话 ${id} 建行异常: ${String(e && e.message).slice(0, 100)}`); }
    if (!row) { log(`新增会话 ${id} 暂不建行（头事件/日志未就绪），下一轮再试`); continue; }
    items.push(row);
    addedRows += 1;
  }
  if (addedRows === 0 && removedRows === 0) return { added: 0, removed: 0 };
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  commitCache(obj);
  return { added: addedRows, removed: removedRows };
}

/** 一轮扫描：指纹 → 增量补丁，或触发全量对账。 */
function scanOnce({ quiet = false } = {}) {
  const t0 = Date.now();
  const next = scanDisk();
  istats.scan += 1;
  istats.lastScanAt = Date.now();
  if (!fpReady) { fp = next; fpReady = true; istats.scanMs = Date.now() - t0; return; }
  const delta = fingerprintDelta(fp, next);
  fp = next;
  istats.changed = delta.changed.length;
  istats.scanMs = Date.now() - t0;

  if (delta.added.length === 0 && delta.removed.length === 0 && delta.changed.length === 0) {
    istats.skip += 1;
    cache.at = Date.now();   // 指纹核过一遍=数据已确认为最新，避免请求走陈旧分支
    if (!quiet) log(`扫描：无变化（${istats.scanMs}ms）`);
    return;
  }
  if (delta.added.length || delta.removed.length) {
    istats.added += delta.added.length;
    istats.removed += delta.removed.length;
    const r = applyStructural(delta, next);
    istats.addedRows += r.added;
    istats.removedRows += r.removed;
    log(`结构变化：新增 ${delta.added.length} / 消失 ${delta.removed.length} → 就地增删 ${r.added}/${r.removed} 行（不等全量）`);
    scheduleFull('fingerprint', 20000);
  }
  // running 状态兜底：事件流断开/漏事件时，用日志写入时间纠正（15 秒一次，零成本）
  try {
    const now = Date.now();
    let fixed = 0;
    const items = itemsOf(getObj()) || [];
    for (const it of items) {
      if (!it || !it.sessionId) continue;
      const e = next.get(it.sessionId);
      if (!e) continue;
      const age = now - e.mtimeMs;
      const live = runningLive.get(it.sessionId);
      if (age < 90 * 1000) {
        if (it.running !== true) { it.running = true; runningLive.set(it.sessionId, true); fixed += 1; }
      } else if (age > 20 * 60 * 1000 && (it.running === true || live === true)) {
        if (it.running === true) { it.running = false; fixed += 1; }
        runningLive.delete(it.sessionId);
      }
    }
    if (fixed) { commitCache(getObj()); istats.runningFixed = (istats.runningFixed || 0) + fixed; log(`running 状态纠正 ${fixed} 行（按日志写入时间）`); }
  } catch {}

  if (delta.changed.length) {
    const digs = new Map();
    for (const id of delta.changed) {
      const v = next.get(id);
      if (!v) continue;
      try {
        const d = tailDigest(v.file, v.size);
        if (d) digs.set(id, d);
      } catch {}
    }
    const rows = patchCache(delta.changed, digs);
    log(`增量补丁：变化 ${delta.changed.length} 个会话，补上 ${rows} 行（${istats.patchMs}ms${rows ? '' : '，无实质变化'}）`);
  }
}

// ---------------------------------------------------------------- 健康自检
/**
 * 每 5 分钟跑一次，检查三类最容易悄悄坏掉的东西：
 *   a) 事件流（running 实时性来源）是否连着
 *   b) 列表条数 vs 磁盘会话数是否一致（新增/删除漏处理）
 *   c) running 标记与日志写入时间是否矛盾（假阳性/假阴性）
 * 结果写进 /cache/stats 的 health 字段，并在异常时写一条日志；恢复时也写一条。
 */
let health = { at: 0, ok: null, issues: [], eventWatch: true, items: 0, disk: 0, falsePositive: 0, falseNegative: 0 };
let healthPrevOk = null;

function healthCheck({ quiet = false } = {}) {
  const issues = [];
  const items = itemsOf(getObj()) || [];
  const disk = fp.size;
  const now = Date.now();
  let fpCount = 0;
  let fnCount = 0;
  for (const it of items) {
    if (!it || !it.sessionId) continue;
    const e = fp.get(it.sessionId);
    if (!e) continue;                       // 列表有、磁盘没有 → 结构问题，算进 items/disk 差
    const age = now - e.mtimeMs;
    // 假阳性：标在跑但 30 分钟没写日志（长 LLM 调用很少超过 30 分钟）
    if (it.running === true && age > 30 * 60 * 1000) fpCount += 1;
    // 假阴性只在事件流断开时才统计：事件流正常时「刚写完日志但已结束」是正常状态
    if (!eventWatchUp && it.running !== true && age < 30 * 1000) fnCount += 1;
  }
  if (!eventWatchUp) issues.push('事件流未连接');
  if (cache.body && items.length !== disk) issues.push(`列表 ${items.length} ≠ 磁盘 ${disk}`);
  if (fpCount > 0) issues.push(`假阳性 running ${fpCount} 行`);
  if (fnCount > 0) issues.push(`假阴性 running ${fnCount} 行`);
  health = {
    at: now,
    ok: issues.length === 0,
    issues,
    eventWatch: eventWatchUp,
    eventWatchConnects,
    eventWatchFails,
    items: items.length,
    disk,
    falsePositive: fpCount,
    falseNegative: fnCount,
    ageMs: cache.at ? now - cache.at : null,
    fullAgeMs: fullAt ? now - fullAt : null,
  };
  const ok = health.ok;
  if (healthPrevOk !== ok) {
    if (ok) log('自检：恢复正常（事件流/条数/running 全部一致）');
    else log('自检异常：' + issues.join('；'));
    healthPrevOk = ok;
  } else if (!ok && !quiet) {
    // 持续异常时每 30 分钟提醒一次，避免刷屏
    if (!health.lastLogAt || now - health.lastLogAt > 30 * 60 * 1000) {
      health.lastLogAt = now;
      log('自检仍异常：' + issues.join('；'));
    }
  }
  return health;
}

function healthLine() {
  const h = health;
  const head = h.ok === null ? 'UNKNOWN' : h.ok ? 'OK' : 'BAD';
  return `${head} event=${h.eventWatch ? 'up' : 'down'}(${h.eventWatchConnects}/${h.eventWatchFails}) items=${h.items} disk=${h.disk} fp=${h.falsePositive} fn=${h.falseNegative} ageMs=${h.ageMs === null ? '-' : h.ageMs} fullAgeMs=${h.fullAgeMs === null ? '-' : h.fullAgeMs}${h.issues && h.issues.length ? ' issues=' + h.issues.join('|') : ''}`;
}

// ---------------------------------------------------------------- rc.2 实例（手机 /m2/ 用）
const RC2_DSH = process.env.DSH_RC2_URL || 'http://127.0.0.1:3081';
const RC2_BRIDGE = process.env.DSH_RC2_BRIDGE || 'http://127.0.0.1:19393';
let rc2Cache = { at: 0, items: [] };
let rc2Cookie = { at: 0, value: '' };

function slimInbox(inbox) {
  if (!inbox || typeof inbox !== 'object') return null;
  const pick = (arr) => (Array.isArray(arr) ? arr : []).map((x) => ({
    id: x && x.id,
    rpcId: (x && x.source && x.source.rpcId) || null,
    text: ((x && x.content) || []).filter((p) => p && p.type === 'text').map((p) => p.text).join(''),
  })).filter((x) => x.text);
  const nextTurn = pick(inbox['next-turn']);
  const nextStep = pick(inbox['next-step']);
  if (!nextTurn.length && !nextStep.length) return null;
  return { nextTurn, nextStep };
}

function slimItems(items) {
  return (Array.isArray(items) ? items : []).map((it) => {
    const v = it.projections?.values || {};
    const ss = v.sessionStats || {};
    return {
      sessionId: it.sessionId,
      running: it.running === true && Date.now() - (it.updatedAt || 0) < 20 * 60 * 1000,
      updatedAt: it.updatedAt || 0,
      cwd: it.cwd || '',
      blank: it.blank === true,
      project: {
        title: v.title || '',
        turns: ss.turns || 0,
        decodeMs: ss.decodeMs || 0,
        decodeTokens: ss.decodeTokens || 0,
        llmMs: ss.llmMs || 0,
        toolMs: ss.toolMs || 0,
        outputTokens: v.tokenUsage?.outputTokens || 0,
        pressureTokens: v.contextPressure?.pressureTokens || 0,
        contextWindow: v.contextPressure?.contextWindow || 0,
        model: v.modelSelection?.next || v.modelSelection?.lastUsed || null,
        todos: v.todos || null,
        goal: v.goal?.goal || v.goal || null,
        agentId: it.agentId || null,
        inbox: slimInbox(v.inbox),
      },
    };
  });
}

async function rc2CookieValue() {
  if (rc2Cookie.value && Date.now() - rc2Cookie.at < 4 * 60 * 1000) return rc2Cookie.value;
  try {
    const r = await fetch(`${RC2_BRIDGE}/cookie`);
    if (!r.ok) return rc2Cookie.value || null;
    const v = r.headers.get('x-rc2-cookie') || '';
    if (v) { rc2Cookie = { at: Date.now(), value: v }; return v; }
  } catch {}
  return rc2Cookie.value || null;
}

/** rc.2 的会话列表（8 个会话，直接问 3081，~80ms；5 秒内存缓存） */
async function rc2List() {
  if (rc2Cache.at && Date.now() - rc2Cache.at < 5000) return rc2Cache.items;
  const cookie = await rc2CookieValue();
  if (!cookie) throw new Error('rc2 cookie 不可用');
  const r = await fetch(`${RC2_DSH}/api/session/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'm2', method: 'session/list', payload: { args: { _request: {} } } }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('rc2 返回 ' + r.status);
  const j = JSON.parse(text);
  const items = slimItems(j?.result?.value?.items);
  rc2Cache = { at: Date.now(), items };
  return items;
}

// ---------------------------------------------------------------- HTTP

function applyRunningItems(items) {
  if (!Array.isArray(items)) return items;
  for (const it of items) {
    if (!it) continue;
    if (runningLive.has(it.sessionId)) it.running = runningLive.get(it.sessionId) === true;
    else if (it.running === true) runningLive.set(it.sessionId, true);
  }
  return items;
}

function bodyFor(rpcId) {
  const obj = getObj();
  if (!obj) return null;
  applyRunningItems(itemsOf(obj));
  if (rpcId) obj.rpcId = rpcId;
  return JSON.stringify(obj);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/m/list' && url.searchParams.get('inst') === 'rc2') {
    try {
      const items = await rc2List();
      return json(res, 200, { ok: true, at: rc2Cache.at, items });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message).slice(0, 120), items: [] });
    }
  }
  if (url.pathname === '/m/list') {
    if (!cache.body) return json(res, 200, { ok: true, items: [] });
    try {
      const items = applyRunningItems(itemsOf(getObj()) || []).map((it) => {
        const v = it.projections?.values || {};
        const ss = v.sessionStats || {};
        return {
          sessionId: it.sessionId,
          running: it.running === true && Date.now() - (it.updatedAt || 0) < 20 * 60 * 1000,
          updatedAt: it.updatedAt || 0,
          cwd: it.cwd || '',
          blank: it.blank === true,
          project: {
            title: v.title || '',
            turns: ss.turns || 0,
            decodeMs: ss.decodeMs || 0,
            decodeTokens: ss.decodeTokens || 0,
            llmMs: ss.llmMs || 0,
            toolMs: ss.toolMs || 0,
            outputTokens: v.tokenUsage?.outputTokens || 0,
            pressureTokens: v.contextPressure?.pressureTokens || 0,
            contextWindow: v.contextPressure?.contextWindow || 0,
            model: v.modelSelection?.next || v.modelSelection?.lastUsed || null,
            todos: v.todos || null,
            goal: v.goal?.goal || v.goal || null,
            agentId: it.agentId || null,
            inbox: slimInbox(v.inbox),
          },
        };
      });
      return json(res, 200, { ok: true, at: cache.at, items });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e.message) });
    }
  }
  if (url.pathname === '/cache/health') {
    try { healthCheck({ quiet: true }); } catch {}
    return json(res, health.ok === false ? 503 : 200, { ok: health.ok !== false, line: healthLine(), ...health });
  }
  if (url.pathname === '/cache/stats') {
    return json(res, 200, {
      ...stats,
      ...istats,
      ageMs: cache.at ? Date.now() - cache.at : null,
      hasCache: !!cache.body,
      sessionsOnDisk: fp.size,
      fullAgeMs: fullAt ? Date.now() - fullAt : null,
      health,
      healthLine: healthLine(),
    });
  }
  if (url.pathname === '/cache/refresh') { refresh('manual', { force: true }).catch(() => {}); return json(res, 200, { ok: true }); }
  if (url.pathname === '/cache/scan') { scanOnce({ quiet: true }); return json(res, 200, { ok: true, ...istats }); }
  if (url.pathname !== '/api/session/list' || req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' });

  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let rpcId = 'cache';
    try { rpcId = JSON.parse(raw).rpcId || 'cache'; } catch {}
    const age = cache.at ? Date.now() - cache.at : Infinity;

    if (cache.body && age < FRESH_MS) {
      stats.hit += 1;
      return json(res, 200, JSON.parse(bodyFor(rpcId)));
    }
    if (cache.body && age < STALE_MS) {
      stats.stale += 1;
      // 先扫一遍指纹：有变化就增量补丁（毫秒级），没变化就什么都不做
      try { scanOnce({ quiet: true }); } catch {}
      if (!cache.at || Date.now() - cache.at >= FRESH_MS) {
        if (Date.now() - fullAt > FULL_MIN_MS) scheduleFull('stale');
      }
      return json(res, 200, JSON.parse(bodyFor(rpcId)));
    }
    stats.miss += 1;
    const text = await refresh('miss', { force: true });
    if (text) return json(res, 200, JSON.parse(bodyFor(rpcId) || text));
    return json(res, 503, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'cache/unavailable', message: '会话列表暂时不可用' } } });
  });
});

// ---------------------------------------------------------------- 启动

try {
  if (fs.existsSync(CACHE_FILE)) {
    const raw = zlib.gunzipSync(fs.readFileSync(CACHE_FILE)).toString('utf8');
    cache = { body: raw, at: fs.statSync(CACHE_FILE).mtimeMs, obj: null };
    log('已从磁盘载入缓存 ' + (raw.length / 1048576).toFixed(2) + 'MB，时间 ' + new Date(cache.at).toISOString());
  }
} catch (e) { log('载入磁盘缓存失败', String(e.message).slice(0, 80)); }

server.listen(PORT, '127.0.0.1', () => {
  log(`session/list 缓存层（mtime 增量）已启动 127.0.0.1:${PORT}  扫描间隔 ${SCAN_MS}ms  全量兜底 ${(FULL_MIN_MS / 60000).toFixed(0)}min`);
  // 启动策略：有缓存就只做一次增量扫描（毫秒级），不再每次重启都吃一次 100 秒全量
  try { fp = scanDisk(); fpReady = true; log(`指纹基线：${fp.size} 个会话日志`); } catch {}
  if (!cache.body) {
    refresh('startup', { force: true }).catch(() => {});
  } else {
    fullAt = Date.now();   // 从启动时刻重新计时兜底全量
    // 启动对账：磁盘有、快照没有的新会话就地补行；快照有、磁盘已消失的删掉。
    // 指纹基线是启动时重建的，不做这一步，重启前漏掉的会话永远补不回来。
    try {
      const items = itemsOf(getObj()) || [];
      const known = new Set(items.map((it) => it?.sessionId).filter(Boolean));
      const missing = [...fp.keys()].filter((id) => !known.has(id));
      const gone = [...known].filter((id) => !fp.has(id));
      if (missing.length) {
        const r = applyStructural({ added: missing, removed: [], changed: [] }, fp);
        log(`启动对账：磁盘 ${fp.size} / 快照 ${known.size}，补进 ${r.added} 行`);
      }
      if (gone.length) {
        const r = applyStructural({ added: [], removed: gone, changed: [] }, fp);
        if (r.removed) log(`启动对账：移除 ${r.removed} 个已消失的会话行`);
      }
    } catch (e) { log('启动对账异常', String(e && e.message).slice(0, 120)); }
    try { scanOnce({ quiet: false }); } catch (e) { log('启动扫描异常', String(e && e.message).slice(0, 120)); }
    // 修历史脏数据：早前版本会抬高 asOfSeq / 造行缺 projections 明细，
    // 这里把「没有 sessionStats 的薄行」asOfSeq 归零，避免前端以为内容已覆盖。
    try {
      const items = itemsOf(getObj()) || [];
      let fixed = 0;
      for (const it of items) {
        const proj = it && it.projections;
        if (!proj || typeof proj !== 'object') continue;
        const thin = !(proj.values && proj.values.sessionStats);
        if (thin && proj.asOfSeq !== 0) { proj.asOfSeq = 0; fixed += 1; }
      }
      if (fixed) { commitCache(getObj()); log(`启动修复：${fixed} 行的 asOfSeq 归零（薄行）`); }
    } catch (e) { log('启动修复异常', String(e && e.message).slice(0, 120)); }
    // 起一次空闲兜底对账：不阻塞对话，等没有会话在跑时才真正执行
    scheduleFull('startup-reconcile', 90000);
  }
  startEventWatch();
  setInterval(() => { try { scanOnce({ quiet: true }); } catch (e) { log('扫描异常', String(e && e.message).slice(0, 120)); } }, SCAN_MS).unref?.();
  // 自检：每 5 分钟一次，异常写日志（恢复也写）
  setTimeout(() => { try { healthCheck({ quiet: true }); } catch {} }, 5000);
  setInterval(() => { try { healthCheck(); } catch (e) { log('自检异常', String(e && e.message).slice(0, 120)); } }, 5 * 60 * 1000).unref?.();
  // 兜底：定期全量对账（只在距上次全量超过 FULL_MIN_MS 时）
  setInterval(() => {
    if (Date.now() - fullAt >= FULL_MIN_MS) scheduleFull('timer', 1000);
  }, 5 * 60 * 1000).unref?.();
});
