#!/usr/bin/env node
/**
 * DSH 本地缓存客户端（阶段1+2 的代理核心）
 *
 * 浏览器/窗口 -> 127.0.0.1:19390 (本进程) -> https://tnty.9017i.cc:19306 -> DSH
 *
 * 做的三件事：
 *  1) 认证代劳：Basic Auth + DSH 登录 token/cookie，浏览器无需输入
 *  2) 只读接口缓存：session/page、session/list 等按请求体缓存到本地磁盘，
 *     切会话时直接本地返回（首次仍走一次网络）
 *  3) 静态资源落盘：前端 JS/CSS/插件包本地缓存，打开界面不再走公网
 *  另外：/api 的 WebSocket(/api/remote.mux) 与 /plugins/events 走原始 TCP 隧道，
 *  浏览器的 permessage-deflate 协商端到端生效。
 *
 * 只读，不写服务器数据。
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, exec } from 'node:child_process';
import { WebSocket } from 'ws';
import { attachMux, prefetchFollowSnapshots } from './ws-mux.mjs';

const VERSION = '1.5.1';
// 首屏只取最近 N 条消息（约 10 轮），更早的历史由前端 session/page 滚动加载
const FOLLOW_MAX_MESSAGES = Number(process.env.DSH_FOLLOW_MAX_MESSAGES || 24);

// 客户端机器标识：远端据此区分不同电脑（同名可改 config.json 的 "clientName"）
function clientName() {
  const envName = String(process.env.DSH_CLIENT_NAME || '').trim();
  if (envName) return envName;
  try {
    const cfgPath = path.join(process.env.APPDATA || '', 'DSH Desktop', 'config.json');
    if (fs.existsSync(cfgPath)) {
      const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
      if (c && typeof c.clientName === 'string' && c.clientName.trim()) return c.clientName.trim();
    }
  } catch {}
  try { return os.hostname() || 'unknown'; } catch { return 'unknown'; }
}
// HTTP 头只能是 ASCII：安装目录/实例名里的中文会把请求头写崩（Invalid character in header content）
const CLIENT_ID = (() => {
  const raw = String(clientName() || '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, '-').trim();
  return raw.slice(0, 64) || 'dsh-client';
})();

// ---------------------------------------------------------------- 配置

function baseDir() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    if (fs.existsSync(path.join(here, 'config.json'))) return here;
  } catch {}
  const exeDir = path.dirname(process.execPath);
  if (fs.existsSync(path.join(exeDir, 'config.json'))) return exeDir;
  if (fs.existsSync(path.join(process.cwd(), 'config.json'))) return process.cwd();
  return process.cwd();
}

function loadConfig() {
  const dir = baseDir();
  // 桌面壳会把用户可编辑的 config.json 路径通过环境变量传进来
  const file = process.env.DSH_CLIENT_CONFIG || path.join(dir, 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    console.error('[dsh-client] 读取配置失败:', file, String(error?.message ?? error));
    console.error('[dsh-client] 请把 config.json 放在 exe 同目录，内容见 README。');
    process.exit(1);
  }
  const port = Number(process.env.DSH_CLIENT_PORT || cfg.port || 19390);
  const baseCache = cfg.cacheDir
    ? path.resolve(dir, cfg.cacheDir)
    : process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'dsh-client', 'cache')
      : path.join(os.homedir(), '.dsh-client', 'cache');
  const out = {
    // 多实例：桌面壳给每个实例传不同的 upstream/port（主实例 19390，rc.2 实例 19392）
    upstream: process.env.DSH_CLIENT_UPSTREAM || cfg.upstream || 'https://tnty.9017i.cc:19306',
    basicUser: cfg.basicUser ?? '',
    basicPass: cfg.basicPass ?? '',
    token: cfg.token ?? '',
    port,
    // 每个实例独立缓存目录，避免两个代理抢同一个 session-list.json
    cacheDir: process.env.DSH_CLIENT_CACHE_DIR || (port === 19390 ? baseCache : `${baseCache}-${port}`),
    openBrowser: cfg.openBrowser !== false,
    prefetch: cfg.prefetch !== false,
    prefetchConcurrency: Number(cfg.prefetchConcurrency ?? 4),
    maxCacheMb: Number(cfg.maxCacheMb ?? 2048),
  };
  return out;
}

const cfg = loadConfig();
const UP = new URL(cfg.upstream);
const UP_HOST = UP.host; // 含端口，如 tnty.9017i.cc:19306
const UP_ORIGIN = UP.origin; // https://tnty.9017i.cc:19306
// upstream 可以带路径前缀（如 https://host:19306/rc2）：本代理会把所有请求加上该前缀，
// 这样 rc.2 实例能复用已开放的 19306 端口，不用在路由器上再放一个端口。
const UP_PATH_PREFIX = (UP.pathname || '/').replace(/\/+$/, '');
function withUpPrefix(p) {
  if (!UP_PATH_PREFIX) return p;
  const path = p.startsWith('/') ? p : '/' + p;
  if (path === UP_PATH_PREFIX || path.startsWith(UP_PATH_PREFIX + '/')) return path;
  return UP_PATH_PREFIX + path;
}
const UP_HOSTNAME = UP.hostname;
const UP_PORT = UP.port ? Number(UP.port) : 443;
// 桌面壳用 Windows DPAPI 加密保存凭据，启动时解密后通过环境变量注入；直接运行代理时退回 config 明文
const SECRETS = (() => {
  try {
    const raw = process.env.DSH_CLIENT_SECRETS;
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
})();
const BASIC_USER = SECRETS?.basicUser ?? cfg.basicUser ?? '';
const BASIC_PASS = SECRETS?.basicPass ?? cfg.basicPass ?? '';
let LOGIN_TOKEN = SECRETS?.token ?? cfg.token ?? '';
const AUTH = 'Basic ' + Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString('base64');

// cookie 加密密钥（32 字节 hex）：桌面壳生成并用 DPAPI 保存
const COOKIE_KEY = (() => {
  const k = String(process.env.DSH_CLIENT_KEY || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(k)) return Buffer.from(k, 'hex');
  return null;
})();

const CACHE_DIR = cfg.cacheDir;
const API_DIR = path.join(CACHE_DIR, 'api');
const STATIC_DIR = path.join(CACHE_DIR, 'static');
const COOKIE_FILE = path.join(CACHE_DIR, 'cookie.txt');
const LOG_FILE = path.join(CACHE_DIR, 'proxy.log');
const LIST_DISK_FILE = path.join(CACHE_DIR, 'session-list.json');
const LIST_DISK_META = path.join(CACHE_DIR, 'session-list.meta');
/** 本地快照超过这个时间就顺手触发一次后台增量刷新（不影响本次响应速度） */
const LIST_REFRESH_MS = 60 * 1000;
for (const d of [CACHE_DIR, API_DIR, STATIC_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------- 日志 / 统计

let logStream = null;
try {
  // 简单轮转：超过 10MB 就转成 .1（只保留一份），避免长期运行后日志无限涨
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size > 10 * 1024 * 1024) {
      try { fs.rmSync(LOG_FILE + '.1', { force: true }); } catch {}
      try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch {}
    }
  } catch {}
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
} catch {}
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try {
    logStream?.write(line + '\n');
  } catch {}
}

const stats = {
  version: VERSION,
  pid: process.pid,
  startedAt: Date.now(),
  apiHit: 0,
  apiMiss: 0,
  apiStored: 0,
  staticHit: 0,
  staticMiss: 0,
  prefetched: 0,
  prefetchPages: 0,
  prefetchErrors: 0,
  wsTunnels: 0,
  bytesSaved: 0,
  listDiskHit: 0,
  listHitMem: 0,
  listNet: 0,
  listBlockMs: 0,
  listBlockCount: 0,
  listDirty: false,
  listIndexSize: 0,
  listIndexAt: 0,
  listNetAt: 0,
  listNetMs: 0,
  listBackoffMs: 0,
  listMerge: null,
  authError: false,
  relogin: 0,
  tokenRefreshed: 0,
  lastPrefetch: null,
};

// ---------------------------------------------------------------- 上游请求

// 连接池要够宽：官方界面有 1Hz 的 /dsh-purge/rewind 轮询 + 若干长连接，
// 原来 8 个 socket 一占满，GET / 会一直排队 → 桌面版窗口一片黑。
const agent = new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 8, keepAliveMsecs: 15000 });
let sessionCookie = '';
function readCookieFile() {
  try {
    const raw = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
    if (!raw) return '';
    if (raw.startsWith('v1:')) {
      if (!COOKIE_KEY) return '';
      const parts = raw.split(':');
      if (parts.length !== 4) return '';
      const iv = Buffer.from(parts[1], 'base64');
      const tag = Buffer.from(parts[2], 'base64');
      const data = Buffer.from(parts[3], 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', COOKIE_KEY, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(data), d.final()]).toString('utf8');
    }
    return raw;
  } catch {
    return '';
  }
}
sessionCookie = readCookieFile();

function saveCookie(cookie) {
  sessionCookie = cookie;
  try {
    if (COOKIE_KEY) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', COOKIE_KEY, iv);
      const enc = Buffer.concat([c.update(cookie, 'utf8'), c.final()]);
      fs.writeFileSync(COOKIE_FILE, `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`, { mode: 0o600 });
    } else {
      fs.writeFileSync(COOKIE_FILE, cookie, { mode: 0o600 });
    }
  } catch {}
}

const TOKEN_HINT_FILE = path.join(CACHE_DIR, 'token.hint');
function saveTokenHint(token) {
  if (!token) return;
  try {
    if (COOKIE_KEY) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', COOKIE_KEY, iv);
      const enc = Buffer.concat([c.update(token, 'utf8'), c.final()]);
      fs.writeFileSync(TOKEN_HINT_FILE, `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`, { mode: 0o600 });
    } else {
      fs.writeFileSync(TOKEN_HINT_FILE, token, { mode: 0o600 });
    }
  } catch {}
}
function readTokenHint() {
  try {
    const raw = fs.readFileSync(TOKEN_HINT_FILE, 'utf8').trim();
    if (!raw) return '';
    if (!raw.startsWith('v1:')) return raw;
    if (!COOKIE_KEY) return '';
    const parts = raw.split(':');
    if (parts.length !== 4) return '';
    const d = crypto.createDecipheriv('aes-256-gcm', COOKIE_KEY, Buffer.from(parts[1], 'base64'));
    d.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([d.update(Buffer.from(parts[3], 'base64')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** DSH 每次重启都会换 token：从服务器（BasicAuth 保护的 /_dsh/token）取当前 token。 */
async function fetchTokenFromBridge() {
  try {
    const { res } = await rawRequest({
      method: 'GET',
      path: '/_dsh/token',
      headers: upstreamHeaders({ 'accept-encoding': 'identity' }),
      timeoutMs: 10000,
    });
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (res.statusCode === 200 && /^[A-Za-z0-9_-]{16,}$/.test(text)) return text;
  } catch {}
  return null;
}

function upstreamHeaders(extra = {}) {
  const headers = {
    host: UP_HOST,
    origin: UP_ORIGIN,
    authorization: AUTH,
    'x-dsh-client': CLIENT_ID,
    ...extra,
  };
  if (sessionCookie) headers.cookie = sessionCookie;
  return headers;
}

function rawRequest({ method = 'GET', path: reqPath, headers = {}, body = null, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: UP_HOSTNAME,
        port: UP_PORT,
        servername: UP_HOSTNAME,
        method,
        path: withUpPrefix(reqPath),
        headers,
        agent,
        timeout: timeoutMs,
      },
      (res) => resolve({ req, res }),
    );
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

let loginInFlight = null;
function ensureLogin() {
  if (!loginInFlight) {
    loginInFlight = login().finally(() => {
      loginInFlight = null;
    });
  }
  return loginInFlight;
}

/** 带自动重登的上游请求：cookie 过期（30 天）时用 token 重新登录并重试一次。 */
async function requestUpstream(options) {
  if (options._noAuth) return rawRequest(options);
  const first = await rawRequest(options);
  const status = first.res.statusCode;
  if ((status === 401 || status === 403) && !options._retried) {
    try {
      for await (const _ of first.res) {
        /* 丢弃旧响应体，释放连接 */
      }
    } catch {}
    stats.relogin += 1;
    log(`上游返回 ${status}，尝试用 token 重新登录…`);
    let ok = false;
    try {
      ok = await ensureLogin();
    } catch {}
    const retry = await rawRequest({ ...options, _retried: true });
    if (!ok || retry.res.statusCode === 401 || retry.res.statusCode === 403) {
      stats.authError = true;
      log('登录凭据可能已失效（401/403）：请更新 config.json 里的 token（帮助 → 更新访问令牌）');
    } else {
      stats.authError = false;
      log('重新登录成功，请求已重试');
    }
    return retry;
  }
  if (status !== 401 && status !== 403) stats.authError = false;
  return first;
}

/** 登录：GET /?token=... 拿 dsh-auth cookie。 */
async function login(attempt = 0) {
  try {
    const { res } = await requestUpstream({
      method: 'GET',
      path: '/?token=' + encodeURIComponent(LOGIN_TOKEN),
      headers: upstreamHeaders({ 'accept-encoding': 'identity' }),
      timeoutMs: 20000,
      _noAuth: true,
    });
    const setCookie = res.headers['set-cookie'];
    const status = res.statusCode;
    res.resume();
    if (Array.isArray(setCookie) && setCookie.length > 0) {
      const pairs = setCookie.map((c) => String(c).split(';')[0]).filter((p) => p.includes('='));
      const jar = pairs.join('; ');
      if (jar && /(^|;\s*)dsh[-\w]*=/i.test(jar)) {
        saveCookie(jar);
        log(`登录成功，已保存 cookie（status=${status}）`);
        return true;
      }
    }
    // 已有 cookie 也可能有效：试一次 session/list
    const ok = await probeSessionList();
    if (ok) {
      log('已有 cookie 有效，跳过重新登录');
      return true;
    }
    log(`登录失败（status=${status}，set-cookie=${setCookie ? '有' : '无'}）`);
    if (attempt === 0) {
      const fresh = (await fetchTokenFromBridge()) || readTokenHint();
      if (fresh && fresh !== LOGIN_TOKEN) {
        LOGIN_TOKEN = fresh;
        saveTokenHint(fresh);
        stats.tokenRefreshed += 1;
        log('检测到 DSH 已重启（token 变化），已自动获取新 token 并重试登录');
        return login(1);
      }
    }
    return false;
  } catch (error) {
    log('登录异常:', String(error?.message ?? error));
    return false;
  }
}

function readBody(stream, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        tooLarge = true;
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    stream.on('error', (error) => reject(error));
  });
}

// ---------------------------------------------------------------- 缓存

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function apiCacheKey(method, argsJson) {
  return sha1(`${method}\n${argsJson}`);
}

function readApiCache(method, cacheKey, ttlMs) {
  const file = path.join(API_DIR, cacheKey + '.json');
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(file + '.meta', 'utf8'));
  } catch {
    return null;
  }
  if (ttlMs > 0 && Date.now() - meta.at > ttlMs) return null;
  try {
    const body = fs.readFileSync(file);
    return { meta, body };
  } catch {
    return null;
  }
}

function writeApiCache(cacheKey, method, status, headers, body) {
  const keep = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (['content-type', 'content-encoding', 'vary', 'cache-control'].includes(k)) keep[k] = v;
  }
  const meta = { at: Date.now(), status, headers: keep, method };
  atomicWrite(path.join(API_DIR, cacheKey + '.meta'), JSON.stringify(meta));
  atomicWrite(path.join(API_DIR, cacheKey + '.json'), body);
}

/** 只读、可缓存的方法；值 = TTL 毫秒（0 = 只要历史不变就一直有效） */
const CACHE_RULES = {
  'session/list': 15000, // 单独走 slot 缓存
  'session/page': 30 * 24 * 60 * 60 * 1000, // 30 天：原来 0=永久，磁盘会一直涨
  'session/modelCatalog': 60000,
  'settings/describe': 600000,
  'credentials/describe': 600000,
  'agentPresets/list': 600000,
  'commands/list': 600000,
  'permissionPresets/catalog': 600000,
  'schedule/list': 60000,
  'schedule/catalog': 600000,
  'dynamicCordisRunner/inventory': 600000,
  'dynamicCordisRunner/syncInspectManifest': 600000,
  'workspace/list': 60000,
  'workspace/read': 600000,
  'session/projections': 30000,
};

/** 这些方法会改数据：命中后清空 api 缓存，避免读旧。 */
const MUTATING_RE =
  /^(session\/(prompt|archive|unarchive|delete|rename|update|fork|resume|cancel|stop|interrupt|steer)|settings\/update|settings\/write|schedule\/|workspace\/write|plugin-manager\/|dynamicCordisRunner\/)/;

/** session/list 用"单槽"缓存：客户端请求体形状不确定也能命中。 */
let listSlot = { at: 0, meta: null, body: null };

const LIST_SHAPE_RE = /^(session\/(archive|unarchive|delete|rename|fork|resume|create)|workspace\/write)/;

/* ───────────── 会话列表「增量」层 ─────────────
 * DSH 的 session/list 是每次全量重算、单线程 100~140 秒的重接口。客户端省不了它的算力，
 * 能做的是「不让界面等它，也不重复算同一份结果」：
 *   1. 内存/磁盘快照永远可直接响应（不再因为过期就掉回网络）；
 *   2. 网络结果回来后按 sessionId 增量合并，统计 新增/变化/消失/未变；
 *   3. 合并后没有变化就不写盘、不换 slot，界面不抖动；
 *   4. 后台刷新单飞 + 失败退避（30s→300s），避免反复压垮 DSH；
 *   5. 只有「本地一条快照都没有」的冷启动才同步等网络。
 */
let listIndex = new Map();   // sessionId -> 行（最近一次合并后的权威副本）
let listIndexAt = 0;
let listNetAt = 0;           // 最近一次成功拉网络的时间
let listNetMs = 0;           // 最近一次网络耗时
let listBackoffMs = 0;       // 失败退避窗口
let listBackoffUntil = 0;
let listBlockMs = 0;         // 同步等网络累计耗时（应趋于 0）
let listBlockCount = 0;
let listDirty = false;       // 有写操作动过列表，等后台对齐
let listRefreshInflight = null;
let listMerge = { at: 0, added: 0, updated: 0, removed: 0, unchanged: 0, total: 0 };

/** 从任意形状的 session/list 响应体取 items（自动解压；失败返回 null）。 */
function listItemsOf(body, headers) {
  if (!body?.length) return null;
  try {
    const plain = decodeCachedBody(body, headers ?? {});
    const obj = JSON.parse(plain.toString('utf8'));
    const items = obj?.result?.value?.items;
    return Array.isArray(items) ? { obj, items } : null;
  } catch {
    return null;
  }
}

/** 用上一次响应的信封重建 body，只替换 items（rpcId 由回放时重写）。 */
function buildListBody(items, template) {
  let out;
  try {
    out = JSON.parse(JSON.stringify(template ?? {}));
  } catch {
    out = {};
  }
  if (!out.result || typeof out.result !== 'object') out.result = {};
  if (!out.result.value || typeof out.result.value !== 'object') out.result.value = {};
  out.result.value.items = items;
  delete out.rpcId;
  return Buffer.from(JSON.stringify(out), 'utf8');
}

/** 增量合并：以服务端为准，统计新增/变化/消失；无变化则复用旧 body。 */
function mergeListItems(items, template) {
  const next = new Map();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const it of items) {
    const id = it?.sessionId;
    if (!id) continue;
    next.set(id, it);
    const prev = listIndex.get(id);
    if (prev === undefined) added += 1;
    else if (JSON.stringify(prev) === JSON.stringify(it)) unchanged += 1;
    else updated += 1;
  }
  let removed = 0;
  for (const id of listIndex.keys()) if (!next.has(id)) removed += 1;
  const changed = added > 0 || updated > 0 || removed > 0;
  listIndex = next;
  listIndexAt = Date.now();
  listMerge = { at: listIndexAt, added, updated, removed, unchanged, total: next.size };
  return {
    changed,
    merged: listMerge,
    body: changed || !listSlot.body ? buildListBody(items, template) : listSlot.body,
  };
}

/** 会话列表 items：快照够新就直接用，否则等一次网络（预取/探测复用，避免各拉一遍全量）。 */
async function ensureListItems(maxAgeMs = 30000) {
  if (listSlot.meta && Date.now() - listSlot.at < maxAgeMs) {
    const parsed = listItemsOf(listSlot.body, listSlot.meta);
    if (parsed) return parsed.items;
  }
  const body = await refreshListInBackground({ force: true });
  const parsed = listItemsOf(body ?? listSlot.body, { 'content-type': 'application/json' });
  return parsed?.items ?? [];
}

function clearApiCache(method) {
  try {
    for (const f of fs.readdirSync(API_DIR)) fs.unlinkSync(path.join(API_DIR, f));
  } catch {}
  const m = String(method ?? '');
  // 列表形状变了：不再删掉本地快照（删了下次就得同步等 100 秒），
  // 改成「保留快照 + 立即后台增量对齐」，界面任何时刻都有东西可渲染。
  if (LIST_SHAPE_RE.test(m)) {
    listDirty = true;
    log(`会话列表变化（${m}），保留本地快照，后台增量对齐`);
    const t = setTimeout(() => refreshListInBackground({ force: true }), 300);
    try { t.unref?.(); } catch {}
  } else if (m) {
    log(`接口缓存已清（${m}），保留磁盘首屏缓存`);
  }
}

/** 读磁盘上的 session/list 快照（重启后首屏直接用本地数据），并顺手恢复增量索引。 */
function readListDisk() {
  try {
    const meta = JSON.parse(fs.readFileSync(LIST_DISK_META, 'utf8'));
    const body = fs.readFileSync(LIST_DISK_FILE);
    if (!body?.length) return null;
    const headers = meta.headers ?? { 'content-type': 'application/json' };
    if (listIndex.size === 0) {
      const parsed = listItemsOf(body, headers);
      if (parsed) {
        listIndex = new Map(parsed.items.filter((it) => it?.sessionId).map((it) => [it.sessionId, it]));
        listIndexAt = Number(meta.at) || 0;
        listMerge = {
          at: listIndexAt,
          added: listIndex.size,
          updated: 0,
          removed: 0,
          unchanged: 0,
          total: listIndex.size,
        };
      }
    }
    return { at: Number(meta.at) || 0, headers, body };
  } catch {
    return null;
  }
}

function writeListDisk(body, headers) {
  if (!body?.length) return;
  try {
    atomicWrite(LIST_DISK_META, JSON.stringify({ at: Date.now(), headers: pickHeaders(headers) }));
    atomicWrite(LIST_DISK_FILE, body);
  } catch (error) {
    log('写入 session/list 磁盘缓存失败:', String(error?.message ?? error));
  }
}

/** 供桌面壳轮询：返回会话运行状态（任务完成通知用）。 */
function handleWatch(res) {
  try {
    if (!listSlot.meta) {
      const d = readListDisk();
      if (d) listSlot = { at: d.at, meta: d.headers, body: d.body };
    }
    if (!listSlot.meta || Date.now() - listSlot.at > 20000) refreshListInBackground();
    let items = [];
    try {
      const parsed = JSON.parse(listSlot.body?.toString('utf8') ?? '{}');
      items = parsed?.result?.value?.items ?? [];
    } catch {}
    const out = items
      .map((it) => ({
        sessionId: it?.sessionId,
        running: Boolean(it?.running),
        title: it?.projections?.values?.title ?? '',
        updatedAt: it?.updatedAt ?? 0,
      }))
      .filter((x) => x.sessionId);
    return sendBuffer(res, 200, { 'content-type': 'application/json; charset=utf-8' }, Buffer.from(JSON.stringify({ at: listSlot.at || 0, items: out })));
  } catch (error) {
    return sendBuffer(res, 500, { 'content-type': 'application/json; charset=utf-8' }, Buffer.from(JSON.stringify({ error: String(error?.message ?? error) })));
  }
}

/** 后台拉一次 session/list 并与本地索引增量合并（单飞 + 退避，失败不影响界面）。 */
function refreshListInBackground({ force = false } = {}) {
  if (listRefreshInflight) return listRefreshInflight;
  if (!force && Date.now() < listBackoffUntil) return Promise.resolve(null);
  const started = Date.now();
  listRefreshInflight = (async () => {
    try {
      const r = await rawApiCall('session/list', { _request: {} }, { gzip: false });
      if (r.status !== 200 || !r.body?.length) throw new Error('status=' + r.status);
      const parsed = listItemsOf(r.body, { 'content-type': 'application/json' });
      if (!parsed) throw new Error('响应解析失败');
      listNetMs = Date.now() - started;
      const out = mergeListItems(parsed.items, parsed.obj);
      const headers = { 'content-type': 'application/json; charset=utf-8' };
      if (out.changed || !fs.existsSync(LIST_DISK_FILE)) writeListDisk(out.body, headers);
      listSlot = { at: listIndexAt, meta: headers, body: out.body };
      listNetAt = Date.now();
      listBackoffMs = 0;
      listBackoffUntil = 0;
      listDirty = false;
      stats.apiStored += 1;
      stats.listNet += 1;
      log(
        `session/list 增量合并 ${out.merged.total} 条（新增${out.merged.added} 变化${out.merged.updated} 消失${out.merged.removed} 未变${out.merged.unchanged}）耗时 ${(listNetMs / 1000).toFixed(1)}s${out.changed ? '' : '；无变化，不写盘'}`,
      );
      return out.body;
    } catch (error) {
      listBackoffMs = listBackoffMs ? Math.min(listBackoffMs * 2, 300000) : 30000;
      listBackoffUntil = Date.now() + listBackoffMs;
      log(`后台刷新 session/list 失败: ${String(error?.message ?? error)}；退避 ${Math.round(listBackoffMs / 1000)}s`);
      return null;
    } finally {
      listRefreshInflight = null;
    }
  })();
  return listRefreshInflight;
}

// ---------------------------------------------------------------- 缓存容量治理
const MAX_CACHE_BYTES = Math.max(64, Number(cfg.maxCacheMb || 2048)) * 1024 * 1024;
const WS_FOLLOW_DIR = path.join(CACHE_DIR, 'ws-follow');
const WS_FOLLOW_MAX_AGE = 6 * 60 * 60 * 1000;   // 与 ws-mux 回放策略一致：6 小时后没用就删

function walkFiles(dir) {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) out.push(...walkFiles(full));
      else { const st = fs.statSync(full); out.push({ file: full, size: st.size, mtimeMs: st.mtimeMs }); }
    } catch {}
  }
  return out;
}

function cacheUsage() {
  let total = 0;
  let files = 0;
  for (const dir of [API_DIR, STATIC_DIR, WS_FOLLOW_DIR]) {
    for (const x of walkFiles(dir)) { total += x.size; files += 1; }
  }
  let freeMb = null;
  try {
    const sf = fs.statfsSync(CACHE_DIR);
    freeMb = Math.round((sf.bfree * sf.bsize) / 1048576);
  } catch {}
  return { total, files, mb: Math.round((total / 1048576) * 10) / 10, freeMb };
}

/** 定期清缓存：过期只读缓存、6 小时前的会话快照、超限时按最旧删到 80% 以内 */
function enforceCacheLimits() {
  const t0 = Date.now();
  let removed = 0;
  let freed = 0;
  const drop = (x) => {
    try { fs.rmSync(x.file, { force: true }); removed += 1; freed += x.size; } catch {}
  };
  const now = Date.now();
  // a) API 缓存按各自 TTL 过期删除（session/page 等）
  for (const x of walkFiles(API_DIR)) {
    if (!x.file.endsWith('.meta')) continue;
    let method = null;
    let at = 0;
    try {
      const meta = JSON.parse(fs.readFileSync(x.file, 'utf8'));
      method = meta.method;
      at = Number(meta.at) || 0;
    } catch {}
    const ttl = method && CACHE_RULES[method] !== undefined ? CACHE_RULES[method] : 30 * 24 * 60 * 60 * 1000;
    if (ttl <= 0) continue;
    if (now - at > ttl) {
      const base = x.file.slice(0, -5);
      drop(x);
      try { const st = fs.statSync(base); freed += st.size; } catch {}
      try { fs.rmSync(base, { force: true }); } catch {}
    }
  }
  // b) ws-follow 快照：超过 6 小时没用就删
  for (const x of walkFiles(WS_FOLLOW_DIR)) {
    if (now - x.mtimeMs > WS_FOLLOW_MAX_AGE) drop(x);
  }
  // c) 超限：把 api/static/ws-follow 里最旧的文件删到 80%
  let usage = cacheUsage();
  if (usage.total > MAX_CACHE_BYTES) {
    const all = [];
    for (const dir of [API_DIR, STATIC_DIR, WS_FOLLOW_DIR]) all.push(...walkFiles(dir));
    all.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const target = MAX_CACHE_BYTES * 0.8;
    for (const x of all) {
      if (usage.total <= target) break;
      drop(x);
      usage.total -= x.size;
    }
  }
  stats.cacheMb = Math.round((cacheUsage().total / 1048576) * 10) / 10;
  stats.cacheFiles = cacheUsage().files;
  stats.lastCleanup = { at: Date.now(), ms: Date.now() - t0, removed, freedMb: Math.round((freed / 1048576) * 10) / 10, limitMb: Math.round(MAX_CACHE_BYTES / 1048576) };
  if (removed > 0) log(`缓存清理：删 ${removed} 个文件 / ${stats.lastCleanup.freedMb}MB（上限 ${stats.lastCleanup.limitMb}MB）`);
  return stats.lastCleanup;
}

/** 只接受本机主进程发来的写操作：自定义头（跨域会触发预检，浏览器发不出来）+ Origin/Referer 校验 */
function isLocalCaller(req) {
  if (String(req.headers['x-dsh-local'] || '') !== '1') return false;
  const origin = String(req.headers.origin || '');
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return false;
  const referer = String(req.headers.referer || '');
  if (referer && !/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(referer)) return false;
  return true;
}

function staticCachePath(key) {
  return path.join(STATIC_DIR, key);
}

function readStatic(key) {
  const metaFile = staticCachePath(key) + '.meta';
  const bodyFile = staticCachePath(key) + '.body';
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const body = fs.readFileSync(bodyFile);
    return { meta, body };
  } catch {
    return null;
  }
}

function writeStatic(key, headers, body) {
  const keep = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (['content-type', 'content-encoding', 'cache-control', 'vary', 'etag', 'last-modified'].includes(k)) {
      keep[k] = v;
    }
  }
  atomicWrite(staticCachePath(key) + '.meta', JSON.stringify({ headers: keep, at: Date.now() }));
  atomicWrite(staticCachePath(key) + '.body', body);
}

function decodeCachedBody(body, headers) {
  const enc = String(headers?.['content-encoding'] ?? '').toLowerCase();
  if (!body || !enc) return body;
  try {
    if (enc === 'gzip') return zlib.gunzipSync(body);
    if (enc === 'deflate') return zlib.inflateSync(body);
    if (enc === 'br') return zlib.brotliDecompressSync(body);
  } catch {
    return body;
  }
  return body;
}

/**
 * 缓存回放时把响应里的 rpcId 换成当前请求的 rpcId。
 * DSH 前端会校验 rpcId（不一致就判定该请求失败），不换会导致 session/list 等接口
 * 在界面里表现为“一个会话都没有”。
 */
function applyRpcId(body, headers, rpcId) {
  const outHeaders = { ...(headers ?? {}) };
  if (!rpcId || !body) return { body, headers: outHeaders };
  const plain = decodeCachedBody(body, headers);
  try {
    const obj = JSON.parse(plain.toString('utf8'));
    obj.rpcId = rpcId;
    delete outHeaders['content-encoding'];
    delete outHeaders['Content-Encoding'];
    outHeaders['content-type'] = 'application/json';
    return { body: Buffer.from(JSON.stringify(obj)), headers: outHeaders };
  } catch {
    return { body, headers: outHeaders };
  }
}

function sendBuffer(res, status, headers, body) {
  const out = { ...headers, 'content-length': body.length };
  res.writeHead(status, out);
  res.end(body);
}

function isStaticCacheable(reqPath) {
  if (reqPath.startsWith('/assets/')) return true;
  if (reqPath.startsWith('/plugins/')) return !reqPath.startsWith('/plugins/events');
  if (reqPath === '/favicon.svg' || reqPath === '/favicon.ico') return true;
  return false;
}

// ---------------------------------------------------------------- 后台预取

async function rawApiCall(method, args, { accept = 'application/json', gzip = true } = {}) {
  const payload = {
    type: 'client-request',
    rpcId: 'prefetch-' + Math.random().toString(36).slice(2),
    method,
    payload: { args },
  };
  const body = Buffer.from(JSON.stringify(payload));
  const headers = upstreamHeaders({
    'content-type': 'application/json',
    accept,
    'content-length': body.length,
    'accept-encoding': gzip ? 'gzip' : 'identity',
  });
  const { res } = await rawRequest({ method: 'POST', path: '/api/' + method, headers, body });
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  return { status: res.statusCode, headers: res.headers, body: buf };
}

let prefetchRunning = false;
let snapPrefetchRunning = false;
async function prefetchAll() {
  if (prefetchRunning || !cfg.prefetch) return;
  prefetchRunning = true;
  const t0 = Date.now();
  try {
    // 复用同一份列表（增量层已保证不重复拉全量），不再单独打一次 session/list
    let items = [];
    try {
      items = await ensureListItems(60000);
    } catch (error) {
      log('预取：取会话列表失败', String(error?.message ?? error));
    }
    if (items.length === 0) {
      const listRes = await rawApiCall('session/list', { _request: {} }, { gzip: false });
      try {
        const parsed = listItemsOf(listRes.body, { 'content-type': 'application/json' });
        items = parsed?.items ?? [];
      } catch (error) {
        log('预取：session/list 解析失败', String(error?.message ?? error));
      }
    }
    log(`预取：发现 ${items.length} 个会话`);
    const queue = items
      .filter((it) => it && it.sessionId)
      .map((it) => ({
        sessionId: it.sessionId,
        asOfSeq: Number(it?.projections?.asOfSeq ?? 0),
      }));

    const worker = async () => {
      while (queue.length > 0) {
        const job = queue.shift();
        if (!job) break;
        const seq = Number.isFinite(job.asOfSeq) && job.asOfSeq >= 0 ? job.asOfSeq : 0;
        const variants = [
          { address: { kind: 'session', sessionId: job.sessionId }, throughSeq: seq },
          { address: { kind: 'session', sessionId: job.sessionId }, throughSeq: seq, maxMessages: 50 },
        ];
        for (const args of variants) {
          const key = apiCacheKey('session/page', JSON.stringify(args));
          if (readApiCache('session/page', key, 0)) continue;
          try {
            const r = await rawApiCall('session/page', { request: args });
            if (r.status === 200) {
              writeApiCache(key, 'session/page', 200, r.headers, r.body);
              stats.prefetchPages += 1;
            }
          } catch (error) {
            stats.prefetchErrors += 1;
          }
        }
        stats.prefetched += 1;
      }
    };
    const n = Math.max(1, Math.min(8, cfg.prefetchConcurrency));
    await Promise.all(Array.from({ length: n }, () => worker()));
    stats.lastPrefetch = { at: Date.now(), ms: Date.now() - t0, sessions: items.length };
    log(`预取完成：${stats.prefetched} 个会话 / ${stats.prefetchPages} 页，用时 ${Date.now() - t0}ms`);
  } catch (error) {
    log('预取失败:', String(error?.message ?? error));
  } finally {
    prefetchRunning = false;
  }
}

/** 预取最近 N 个会话的 follow snapshot：切会话时直接本地回放。 */
async function prefetchRecentSnapshots() {
  const count = Math.max(0, Number(cfg.prefetchFollow ?? 10));
  if (count === 0 || snapPrefetchRunning) return;
  snapPrefetchRunning = true;
  try {
    const items = await ensureListItems(60000);
    const targets = items.filter((it) => it && it.sessionId).slice(0, count).map((it) => it.sessionId);
    if (targets.length === 0) return;
    const t0 = Date.now();
    const outcome = await prefetchFollowSnapshots({
      upstreamUrl: `wss://${UP_HOST}${UP_PATH_PREFIX}/api/remote.mux`,
      headers: muxHeaders,
  getAsOfSeq: fetchAsOfSeq,
      cacheDir: CACHE_DIR,
      sessionIds: targets,
      log,
    });
    log(`切换快照预取：${outcome.ok} 成功 / ${outcome.failed} 失败，用时 ${Date.now() - t0}ms`);
  } catch (error) {
    log('切换快照预取失败', String(error?.message ?? error));
  } finally {
    snapPrefetchRunning = false;
  }
}

async function probeSessionList() {
  try {
    const r = await rawApiCall('session/list', { _request: {} }, { gzip: false });
    return r.status === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- HTTP 服务

function proxyStatic(req, res, reqPath) {
  const key = sha1(reqPath);
  const hit = readStatic(key);
  if (hit) {
    stats.staticHit += 1;
    stats.bytesSaved += hit.body.length;
    return sendBuffer(res, 200, { ...hit.meta.headers, 'cache-control': 'public, max-age=31536000, immutable' }, hit.body);
  }
  stats.staticMiss += 1;
  const headers = upstreamHeaders({
    accept: req.headers.accept ?? '*/*',
    'accept-encoding': req.headers['accept-encoding'] ?? 'gzip',
    'user-agent': req.headers['user-agent'] ?? 'dsh-client',
  });
  requestUpstream({ method: req.method, path: reqPath, headers })
    .then(({ res: upRes }) => {
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        const body = Buffer.concat(chunks);
        if (upRes.statusCode === 200 && body.length > 0) writeStatic(key, upRes.headers, body);
        sendBuffer(res, upRes.statusCode, upRes.headers, body);
      });
      upRes.on('error', () => {
        try {
          res.writeHead(502);
          res.end('upstream error');
        } catch {}
      });
    })
    .catch((error) => {
      log('静态代理失败', reqPath, String(error?.message ?? error));
      try {
        res.writeHead(502);
        res.end('upstream error');
      } catch {}
    });
}

/** 这些路径是长连接（SSE/事件流），不能设超时；其余普通 GET 统一超时，防止 socket 被永久占用。 */
const LONG_LIVED_PATH = /^\/(plugins\/events|agent|push\/|mobile-link\/events|api\/remote\.mux)/;

function streamThrough(req, res, reqPath) {
  const headers = upstreamHeaders({
    accept: req.headers.accept ?? '*/*',
    'accept-encoding': req.headers['accept-encoding'] ?? 'gzip',
    'user-agent': req.headers['user-agent'] ?? 'dsh-client',
  });
  const pathname = String(reqPath).split('?')[0];
  const timeoutMs = LONG_LIVED_PATH.test(pathname) ? 0 : 30000;
  requestUpstream({ method: req.method, path: reqPath, headers, timeoutMs })
    .then(({ res: upRes }) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
      upRes.on('error', () => res.destroy());
    })
    .catch((error) => {
      log('透传失败', reqPath, String(error?.message ?? error));
      try {
        res.writeHead(502);
        res.end('upstream error');
      } catch {}
    });
}

async function handleApiPost(req, res, reqPath, body) {
  let parsed = null;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {}
  const method = parsed?.method ?? reqPath.replace(/^\/api\//, '');
  const args = parsed?.payload?.args ?? null;

  // 历史分页/跟随：DSH 要求 turnWindow.minMessages ≤ maxMessages，否则直接 400。
  // 官方界面有时只传 turnWindow 不传 maxMessages，这里补齐。
  try {
    const r = args && args.request;
    if (r && r.turnWindow && typeof r.turnWindow.minMessages === 'number') {
      let minMsgs = Math.floor(r.turnWindow.minMessages);
      if (!Number.isFinite(minMsgs) || minMsgs < 1) minMsgs = 1;
      if (minMsgs > 80) minMsgs = 80;              // 最多一次取 80 条，避免拉太多导致卡顿
      r.turnWindow.minMessages = minMsgs;
      if (!Number.isSafeInteger(r.maxMessages) || r.maxMessages < minMsgs) {
        r.maxMessages = minMsgs;
        parsed.payload.args = args;
        body = Buffer.from(JSON.stringify(parsed), 'utf8');
      }
    }
  } catch {}

  // 写操作：透传并清缓存
  const mutating = MUTATING_RE.test(String(method));
  if (!parsed || !CACHE_RULES[method] || mutating) {
    if (mutating || /prompt|interrupt|steer|cancel|stop/i.test(String(method))) clearApiCache(method);
    return streamBufferUpstream(req, res, reqPath, body);
  }

  // session/list：内存 15 秒 → 本地快照（任意年龄，直接回）→ 网络（仅冷启动）
  if (method === 'session/list') {
    const ttl = CACHE_RULES['session/list'];
    if (listSlot.meta && Date.now() - listSlot.at < ttl) {
      stats.apiHit += 1;
      stats.listHitMem += 1;
      const replay = applyRpcId(listSlot.body, listSlot.meta, parsed?.rpcId);
      stats.bytesSaved += replay.body.length;
      return sendBuffer(res, 200, replay.headers, replay.body);
    }
    const snap = listSlot.meta ? listSlot : readListDisk();
    if (snap) {
      listSlot = { at: snap.at, meta: snap.headers, body: snap.body };
      stats.listDiskHit += 1;
      stats.apiHit += 1;
      stats.bytesSaved += snap.body.length;
      log(
        `首屏：session/list 用本地快照直出（${Math.round((Date.now() - snap.at) / 1000)} 秒前，${Math.round(snap.body.length / 1024)}KB，不等网络）`,
      );
      if (listDirty || Date.now() - snap.at > LIST_REFRESH_MS) refreshListInBackground();
      const replay = applyRpcId(snap.body, snap.headers, parsed?.rpcId);
      return sendBuffer(res, 200, replay.headers, replay.body);
    }
    // 冷启动：本地一条快照都没有，只能同步等一次（计入 listBlockMs，越小越好）
    const waitFrom = Date.now();
    const headers = upstreamHeaders({
      'content-type': req.headers['content-type'] ?? 'application/json',
      accept: req.headers.accept ?? 'application/json',
      'accept-encoding': req.headers['accept-encoding'] ?? 'gzip',
      'content-length': body.length,
      'user-agent': req.headers['user-agent'] ?? 'dsh-client',
    });
    const { res: upRes } = await requestUpstream({ method: 'POST', path: reqPath, headers, body });
    const chunks = [];
    for await (const c of upRes) chunks.push(c);
    const upBody = Buffer.concat(chunks);
    if (upRes.statusCode === 200) {
      const parsedUp = listItemsOf(upBody, upRes.headers ?? {});
      let outBody = upBody;
      let outHeaders = upRes.headers ?? {};
      if (parsedUp) {
        const out = mergeListItems(parsedUp.items, parsedUp.obj);
        outHeaders = { 'content-type': 'application/json; charset=utf-8' };
        outBody = out.body;
        listSlot = { at: listIndexAt, meta: outHeaders, body: outBody };
        writeListDisk(outBody, outHeaders);
        listNetAt = Date.now();
        listBlockMs += Date.now() - waitFrom;
        listBlockCount += 1;
        log(
          `冷启动：session/list 首次全量 ${out.merged.total} 条，已建索引（阻塞 ${((Date.now() - waitFrom) / 1000).toFixed(1)}s）`,
        );
      } else {
        listSlot = { at: Date.now(), meta: pickHeaders(upRes.headers), body: upBody };
        writeListDisk(upBody, upRes.headers ?? {});
      }
      stats.apiStored += 1;
      stats.listNet += 1;
      const replay = applyRpcId(outBody, outHeaders, parsed?.rpcId);
      return sendBuffer(res, 200, replay.headers, replay.body);
    }
    return sendBuffer(res, upRes.statusCode ?? 502, upRes.headers ?? {}, upBody);
  }

  const argsJson = JSON.stringify(args ?? {});
  const key = apiCacheKey(method, argsJson);
  const ttl = CACHE_RULES[method];
  const hit = readApiCache(method, key, ttl);
  if (hit) {
    stats.apiHit += 1;
    const replay = applyRpcId(hit.body, hit.meta.headers ?? {}, parsed?.rpcId);
    stats.bytesSaved += replay.body.length;
    return sendBuffer(res, hit.meta.status ?? 200, replay.headers, replay.body);
  }
  stats.apiMiss += 1;
  const headers = upstreamHeaders({
    'content-type': 'application/json',
    accept: req.headers.accept ?? 'application/json',
    'accept-encoding': req.headers['accept-encoding'] ?? 'gzip',
    'content-length': body.length,
    'user-agent': req.headers['user-agent'] ?? 'dsh-client',
  });
  const { res: upRes } = await requestUpstream({ method: 'POST', path: reqPath, headers, body });
  const chunks = [];
  for await (const c of upRes) chunks.push(c);
  const upBody = Buffer.concat(chunks);
  if (upRes.statusCode === 200) {
    writeApiCache(key, method, 200, pickHeaders(upRes.headers), upBody);
    stats.apiStored += 1;
  }
  sendBuffer(res, upRes.statusCode ?? 502, upRes.headers ?? {}, upBody);
}

function pickHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (['content-type', 'content-encoding', 'vary', 'cache-control'].includes(k)) out[k] = v;
  }
  return out;
}

function streamBufferUpstream(req, res, reqPath, body) {
  const headers = upstreamHeaders({
    'content-type': req.headers['content-type'] ?? 'application/json',
    accept: req.headers.accept ?? 'application/json',
    'accept-encoding': req.headers['accept-encoding'] ?? 'gzip',
    'content-length': body.length,
    'user-agent': req.headers['user-agent'] ?? 'dsh-client',
  });
  requestUpstream({ method: 'POST', path: reqPath, headers, body })
    .then(({ res: upRes }) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
      upRes.on('error', () => res.destroy());
    })
    .catch(() => {
      try {
        res.writeHead(502);
        res.end('upstream error');
      } catch {}
    });
}

function handleApiGet(req, res, reqPath) {
  // /api 下也有 GET（例如远程流），直接透传
  streamThrough(req, res, reqPath);
}

// ---------------------------------------------------------------- 远程协助
// 默认关闭。用户在「帮助 → 远程协助」里手动开启，到点自动断开。
let remote = { enabled: false, until: 0, ws: null, connected: false, reopenTimer: null, expireTimer: null };

function remoteState() {
  return { enabled: remote.enabled, until: remote.until, connected: remote.connected, remaining: Math.max(0, remote.until - Date.now()) };
}

function runShellCommand(cmd, timeoutMs) {
  return new Promise((resolve) => {
    const t = Math.max(1000, Math.min(30 * 60 * 1000, Number(timeoutMs) || 60000));
    try {
      exec(cmd, { timeout: t, windowsHide: true, maxBuffer: 16 * 1024 * 1024, shell: process.env.ComSpec || 'cmd.exe' },
        (err, stdout, stderr) => {
          resolve({
            type: 'result',
            code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
            stdout: String(stdout || ''),
            stderr: String(stderr || '') + (err && err.killed ? '\n[命令超时被终止]' : ''),
            error: err ? String(err.message).slice(0, 300) : undefined,
          });
        });
    } catch (e) {
      resolve({ type: 'result', code: 1, stdout: '', stderr: '', error: String(e && e.message) });
    }
  });
}

function remoteConnect() {
  if (!remote.enabled || Date.now() >= remote.until) return;
  clearTimeout(remote.reopenTimer);
  remote.reopenTimer = null;
  if (remote.ws) { try { remote.ws.close(); } catch {} remote.ws = null; }
  const url = `wss://${UP_HOST}/agent`;
  let ws;
  try {
    ws = new WebSocket(url, { headers: { authorization: AUTH, 'x-dsh-client': CLIENT_ID } });
  } catch (e) { log('远程协助连接失败', String(e.message)); return; }
  remote.ws = ws;
  ws.on('open', () => {
    log('远程协助通道已连接');
    ws.send(JSON.stringify({
      type: 'hello',
      host: CLIENT_ID,
      info: { version: VERSION, os: process.platform, arch: process.arch, user: os.userInfo().username, hostname: os.hostname() },
    }));
  });
  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'welcome') { remote.connected = true; log('远程协助已就绪'); return; }
    if (m.type === 'exec' && m.id) {
      log('远程协助执行命令:', String(m.cmd).slice(0, 200));
      const r = await runShellCommand(m.cmd, m.timeoutMs);
      try { ws.send(JSON.stringify({ ...r, id: m.id })); } catch {}
      return;
    }
  });
  ws.on('close', () => {
    // 只有当前这条连接断开才需要重连；被新连接替换掉的旧连接直接忽略
    if (remote.ws !== ws) return;
    remote.ws = null;
    remote.connected = false;
    log('远程协助通道断开');
    if (!remote.enabled || Date.now() >= remote.until) return;
    clearTimeout(remote.reopenTimer);
    remote.reopenTimer = setTimeout(() => {
      remote.reopenTimer = null;
      if (remote.enabled && Date.now() < remote.until && !remote.ws) remoteConnect();
    }, 3000);
  });
  ws.on('error', (e) => log('远程协助通道错误', String(e && e.message).slice(0, 120)));
}

function startRemoteAssist(minutes) {
  const mins = Math.max(1, Math.min(180, Number(minutes) || 30));
  remote.enabled = true;
  remote.until = Date.now() + mins * 60000;
  clearTimeout(remote.expireTimer);
  remote.expireTimer = setTimeout(() => {
    log('远程协助已到点，自动关闭');
    stopRemoteAssist('expired');
  }, mins * 60000);
  log(`远程协助已开启 ${mins} 分钟`);
  remoteConnect();
  return remoteState();
}

function stopRemoteAssist(reason) {
  remote.enabled = false;
  remote.until = 0;
  remote.connected = false;
  clearTimeout(remote.expireTimer);
  clearTimeout(remote.reopenTimer);
  if (remote.ws) { try { remote.ws.close(); } catch {} remote.ws = null; }
  log('远程协助已关闭', reason || '');
  return remoteState();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${cfg.port}`);
    const reqPath = url.pathname + url.search;

    if (req.headers.expect?.includes('100-continue')) res.writeContinue?.();

    if (url.pathname === '/__proxy/selfcheck') {
      const u = cacheUsage();
      const payload = {
        ok: Boolean(listSlot.body) && !stats.authError,
        version: VERSION,
        port: cfg.port,
        upstream: cfg.upstream,
        uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
        authError: Boolean(stats.authError),
        listIndexSize: listIndex.size,
        listDirty: Boolean(listDirty),
        listBlockCount: stats.listBlockCount,
        listBackoffMs: listBackoffMs,
        cacheDir: CACHE_DIR,
        cacheMb: u.mb,
        cacheFiles: u.files,
        cacheLimitMb: Math.round(MAX_CACHE_BYTES / 1048576),
        diskFreeMb: u.freeMb,
        lastCleanup: stats.lastCleanup || null,
      };
      return sendBuffer(res, 200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(payload)));
    }
    if (url.pathname === '/__proxy/stats') {
      stats.listIndexSize = listIndex.size;
      stats.listIndexAt = listIndexAt;
      stats.listNetAt = listNetAt;
      stats.listNetMs = listNetMs;
      stats.listBackoffMs = listBackoffMs;
      stats.listBlockMs = listBlockMs;
      stats.listBlockCount = listBlockCount;
      stats.listDirty = listDirty;
      stats.listMerge = listMerge;
      stats.listDiskAgeMs = listSlot.at ? Date.now() - listSlot.at : null;
      stats.listRefreshing = Boolean(listRefreshInflight);
      return sendBuffer(res, 200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(stats)));
    }
    if (url.pathname === '/__proxy/prefetch') {
      prefetchAll();
      return sendBuffer(res, 200, { 'content-type': 'application/json' }, Buffer.from('{"ok":true}'));
    }
    if (url.pathname === '/__proxy/watch') {
      return handleWatch(res);
    }
    if (url.pathname === '/__proxy/remote') {
      if (req.method === 'POST' && !isLocalCaller(req)) {
        // 防 CSRF/跨站：浏览器页面发不出带自定义头的请求，本机主进程才行
        return sendBuffer(res, 403, { 'content-type': 'application/json' }, Buffer.from('{"ok":false,"error":"local-only"}'));
      }
      if (req.method === 'POST') {
        const raw = await readBody(req, 4096);
        let body = {};
        try { body = JSON.parse(String(raw || '{}')); } catch {}
        const state = body.enabled ? startRemoteAssist(body.minutes) : stopRemoteAssist('manual');
        return sendBuffer(res, 200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(state)));
      }
      return sendBuffer(res, 200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(remoteState())));
    }

    if (isStaticCacheable(url.pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
      return proxyStatic(req, res, reqPath);
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const body = await readBody(req, 64 * 1024 * 1024);
      if (body === null) {
        // 超大请求体：退回流式透传（不缓存）
        req.resume();
        return streamThrough(req, res, reqPath);
      }
      return handleApiPost(req, res, reqPath, body);
    }
    if (url.pathname.startsWith('/api/')) return handleApiGet(req, res, reqPath);
    return streamThrough(req, res, reqPath);
  } catch (error) {
    log('请求处理异常', req.url, String(error?.stack ?? error));
    try {
      res.writeHead(500);
      res.end('proxy error');
    } catch {}
  }
});

// ---------------------------------------------------------------- WebSocket / 升级隧道
//
// /api/remote.mux 交给 ws-mux.mjs：它做 session/follow 首帧 snapshot 的本地缓存，
// 命中时先本地回放（毫秒级），再连上游只取增量事件。
const asOfSeqCache = new Map();
/** 查询会话最新序号（极小响应），用于校验本地快照是否过期。 */
async function fetchAsOfSeq(sessionId) {
  const hit = asOfSeqCache.get(sessionId);
  if (hit && Date.now() - hit.at < 1500) return hit.seq;
  const res = await rawApiCall('session/projections', { request: { sessionId } }, { gzip: false });
  let seq;
  try {
    const parsed = JSON.parse(res.body.toString('utf8'));
    const value = parsed?.result?.value;
    seq = Number(value?.asOfSeq ?? value?.projections?.asOfSeq);
  } catch {}
  if (Number.isFinite(seq)) asOfSeqCache.set(sessionId, { at: Date.now(), seq });
  return Number.isFinite(seq) ? seq : undefined;
}

function muxHeaders() {
  const h = { origin: UP_ORIGIN, authorization: AUTH, 'x-dsh-client': CLIENT_ID };
  if (sessionCookie) h.cookie = sessionCookie;
  return h;
}

attachMux({
  server,
  upstreamUrl: `wss://${UP_HOST}${UP_PATH_PREFIX}/api/remote.mux`,
  headers: muxHeaders,
  cacheDir: CACHE_DIR,
  getAsOfSeq: fetchAsOfSeq,   // 回放缓存前先核对序号，避免"回放后无法衔接"导致断线
  log,
  stats,
});

// ---------------------------------------------------------------- 启动

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

async function main() {
  // 先监听端口，再后台登录：DSH 忙时登录可能要几十秒，
  // 若等登录完再监听，客户端会误判“代理启动失败”。
  server.listen(cfg.port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${cfg.port}/`;
    log(`dsh-client ${VERSION} 已启动: ${url}  -> ${cfg.upstream}`);
    login().then((ok) => { if (!ok) log('警告：首次登录未成功，后续请求会重试'); }).catch(() => {});
    log(`缓存目录: ${CACHE_DIR}`);
    log(`配置文件: ${process.env.DSH_CLIENT_CONFIG || path.join(baseDir(), 'config.json')}`);
    if (cfg.openBrowser && !process.argv.includes('--no-open')) openBrowser(url);
    // 缓存容量治理：启动 5 秒后清一次，之后每 30 分钟一次
    setTimeout(() => { try { enforceCacheLimits(); } catch (e) { log('缓存清理异常', String(e && e.message).slice(0, 120)); } }, 5000);
    setInterval(() => { try { enforceCacheLimits(); } catch {} }, 30 * 60 * 1000).unref?.();
    if (cfg.prefetch) setTimeout(() => prefetchAll(), 1500);
    if (Number(cfg.prefetchFollow ?? 10) > 0) setTimeout(() => prefetchRecentSnapshots(), 4000);
    // 每 5 分钟后台增量刷新一次会话列表（不再清空内存快照，界面永远有数据可渲染）
    setInterval(() => {
      refreshListInBackground();
    }, 5 * 60 * 1000).unref?.();
  });
  server.on('error', (error) => {
    log('监听失败:', String(error?.message ?? error));
    process.exit(1);
  });
}

process.on('uncaughtException', (error) => log('未捕获异常:', String(error?.stack ?? error)));
process.on('unhandledRejection', (error) => log('未处理 Promise:', String(error?.stack ?? error)));

main();
