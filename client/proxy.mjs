#!/usr/bin/env node
/**
 * DSH 本地缓存客户端（阶段1+2 的代理核心）
 *
 * 浏览器/窗口 -> 127.0.0.1:19390 (本进程) -> https://dsh.example.com:19306 -> DSH
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
import { spawn } from 'node:child_process';
import { attachMux, prefetchFollowSnapshots } from './ws-mux.mjs';

const VERSION = '1.3.2';

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
  const out = {
    upstream: cfg.upstream ?? 'https://dsh.example.com:19306',
    basicUser: cfg.basicUser ?? '',
    basicPass: cfg.basicPass ?? '',
    token: cfg.token ?? '',
    port: Number(cfg.port ?? 19390),
    cacheDir: cfg.cacheDir
      ? path.resolve(dir, cfg.cacheDir)
      : process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'dsh-client', 'cache')
        : path.join(os.homedir(), '.dsh-client', 'cache'),
    openBrowser: cfg.openBrowser !== false,
    prefetch: cfg.prefetch !== false,
    prefetchConcurrency: Number(cfg.prefetchConcurrency ?? 4),
    maxCacheMb: Number(cfg.maxCacheMb ?? 2048),
  };
  return out;
}

const cfg = loadConfig();
const UP = new URL(cfg.upstream);
const UP_HOST = UP.host; // 含端口，如 dsh.example.com:19306
const UP_ORIGIN = UP.origin; // https://dsh.example.com:19306
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
/** 磁盘上的 session/list 缓存：多久内可以直接当首屏数据用（之后仍回网络） */
const LIST_DISK_TTL = 10 * 60 * 1000;
for (const d of [CACHE_DIR, API_DIR, STATIC_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------- 日志 / 统计

let logStream = null;
try {
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
  authError: false,
  relogin: 0,
  tokenRefreshed: 0,
  lastPrefetch: null,
};

// ---------------------------------------------------------------- 上游请求

const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
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
        path: reqPath,
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
  'session/page': 0,
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

function clearApiCache(method) {
  try {
    for (const f of fs.readdirSync(API_DIR)) fs.unlinkSync(path.join(API_DIR, f));
  } catch {}
  listSlot = { at: 0, meta: null, body: null };
  const m = String(method ?? '');
  // 只有“会话列表本身会变”的操作才清磁盘首屏缓存；普通对话/取消不影响首屏加速
  if (LIST_SHAPE_RE.test(m)) {
    try {
      fs.unlinkSync(LIST_DISK_FILE);
      fs.unlinkSync(LIST_DISK_META);
    } catch {}
    log(`会话列表变化（${m}），已清空磁盘列表缓存`);
  } else if (m) {
    log(`接口缓存已清（${m}），保留磁盘首屏缓存`);
  }
}

/** 读磁盘上的 session/list 缓存（用于重启后首屏直接用本地数据）。 */
function readListDisk() {
  try {
    const meta = JSON.parse(fs.readFileSync(LIST_DISK_META, 'utf8'));
    const body = fs.readFileSync(LIST_DISK_FILE);
    if (!body?.length) return null;
    return { at: Number(meta.at) || 0, headers: meta.headers ?? { 'content-type': 'application/json' }, body };
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

let listRefreshing = false;
/** 命中磁盘缓存后，后台再拉一次最新列表，供下次启动使用（stale-while-revalidate）。 */
async function refreshListInBackground() {
  if (listRefreshing) return;
  listRefreshing = true;
  try {
    const r = await rawApiCall('session/list', { _request: {} }, { gzip: false });
    if (r.status === 200 && r.body?.length) {
      listSlot = { at: Date.now(), meta: { 'content-type': 'application/json' }, body: r.body };
      writeListDisk(r.body, { 'content-type': 'application/json' });
      stats.apiStored += 1;
    }
  } catch (error) {
    log('后台刷新 session/list 失败:', String(error?.message ?? error));
  } finally {
    listRefreshing = false;
  }
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
    const listRes = await rawApiCall('session/list', { _request: {} }, { gzip: false });
    let items = [];
    try {
      const parsed = JSON.parse(listRes.body.toString('utf8'));
      items = parsed?.result?.value?.items ?? [];
    } catch (error) {
      log('预取：session/list 解析失败', String(error?.message ?? error));
    }
    if (listRes.status === 200 && listRes.body?.length) {
      listSlot = { at: Date.now(), meta: { 'content-type': 'application/json' }, body: listRes.body };
      writeListDisk(listRes.body, { 'content-type': 'application/json' });
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
    const listRes = await rawApiCall('session/list', { _request: {} }, { gzip: false });
    let items = [];
    try {
      items = JSON.parse(listRes.body.toString('utf8'))?.result?.value?.items ?? [];
    } catch {}
    const targets = items.filter((it) => it && it.sessionId).slice(0, count).map((it) => it.sessionId);
    if (targets.length === 0) return;
    const t0 = Date.now();
    const outcome = await prefetchFollowSnapshots({
      upstreamUrl: `wss://${UP_HOST}/api/remote.mux`,
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

function streamThrough(req, res, reqPath) {
  const headers = upstreamHeaders({
    accept: req.headers.accept ?? '*/*',
    'accept-encoding': req.headers['accept-encoding'] ?? 'gzip',
    'user-agent': req.headers['user-agent'] ?? 'dsh-client',
  });
  requestUpstream({ method: req.method, path: reqPath, headers, timeoutMs: 0 })
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

  // 写操作：透传并清缓存
  const mutating = MUTATING_RE.test(String(method));
  if (!parsed || !CACHE_RULES[method] || mutating) {
    if (mutating || /prompt|interrupt|steer|cancel|stop/i.test(String(method))) clearApiCache(method);
    return streamBufferUpstream(req, res, reqPath, body);
  }

  // session/list 单槽缓存（内存 15 秒 → 磁盘 10 分钟 → 网络）
  if (method === 'session/list') {
    const ttl = CACHE_RULES['session/list'];
    if (listSlot.meta && Date.now() - listSlot.at < ttl) {
      stats.apiHit += 1;
      const replay = applyRpcId(listSlot.body, listSlot.meta, parsed?.rpcId);
      stats.bytesSaved += replay.body.length;
      return sendBuffer(res, 200, replay.headers, replay.body);
    }
    const disk = readListDisk();
    if (disk && Date.now() - disk.at < LIST_DISK_TTL) {
      listSlot = { at: disk.at, meta: disk.headers, body: disk.body };
      stats.listDiskHit += 1;
      stats.apiHit += 1;
      stats.bytesSaved += disk.body.length;
      log(
        `首屏：session/list 命中磁盘缓存（${Math.round((Date.now() - disk.at) / 1000)} 秒前，${Math.round(disk.body.length / 1024)}KB）`,
      );
      refreshListInBackground();
      const replay = applyRpcId(disk.body, disk.headers, parsed?.rpcId);
      return sendBuffer(res, 200, replay.headers, replay.body);
    }
    // 用客户端原始请求体转发（保留客户端的 rpcId），再缓存结果
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
      listSlot = { at: Date.now(), meta: pickHeaders(upRes.headers), body: upBody };
      stats.apiStored += 1;
      writeListDisk(upBody, upRes.headers ?? {});
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${cfg.port}`);
    const reqPath = url.pathname + url.search;

    if (req.headers.expect?.includes('100-continue')) res.writeContinue?.();

    if (url.pathname === '/__proxy/stats') {
      return sendBuffer(res, 200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(stats)));
    }
    if (url.pathname === '/__proxy/prefetch') {
      prefetchAll();
      return sendBuffer(res, 200, { 'content-type': 'application/json' }, Buffer.from('{"ok":true}'));
    }
    if (url.pathname === '/__proxy/watch') {
      return handleWatch(res);
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
  const h = { origin: UP_ORIGIN, authorization: AUTH };
  if (sessionCookie) h.cookie = sessionCookie;
  return h;
}

attachMux({
  server,
  upstreamUrl: `wss://${UP_HOST}/api/remote.mux`,
  headers: muxHeaders,
  cacheDir: CACHE_DIR,
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
  const loggedIn = await login();
  if (!loggedIn) log('警告：未登录成功，稍后请求会再次尝试');
  server.listen(cfg.port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${cfg.port}/`;
    log(`dsh-client ${VERSION} 已启动: ${url}  -> ${cfg.upstream}`);
    log(`缓存目录: ${CACHE_DIR}`);
    log(`配置文件: ${process.env.DSH_CLIENT_CONFIG || path.join(baseDir(), 'config.json')}`);
    if (cfg.openBrowser && !process.argv.includes('--no-open')) openBrowser(url);
    if (cfg.prefetch) setTimeout(() => prefetchAll(), 1500);
    if (Number(cfg.prefetchFollow ?? 10) > 0) setTimeout(() => prefetchRecentSnapshots(), 4000);
    // 每 5 分钟刷新一次 session/list 槽与最近会话首页（增量感知）
    setInterval(() => {
      listSlot = { at: 0, meta: null, body: null };
    }, 60000).unref?.();
  });
  server.on('error', (error) => {
    log('监听失败:', String(error?.message ?? error));
    process.exit(1);
  });
}

process.on('uncaughtException', (error) => log('未捕获异常:', String(error?.stack ?? error)));
process.on('unhandledRejection', (error) => log('未处理 Promise:', String(error?.stack ?? error)));

main();
