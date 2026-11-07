/**
 * WS mux 缓存层（v2）：把 /api/remote.mux 变成可缓存的中继。
 *
 * 协议（DSH gateway mux）：
 *   客户端 -> 服务端： {type:'open', streamId, endpoint, payload}
 *                      {type:'item'|'end'|'cancel', streamId, ...}
 *   服务端 -> 客户端： {type:'item', streamId, value} / {type:'end'} / {type:'error'}
 *
 * 目前只对 `session/follow` 的**首帧 snapshot**做缓存：
 *   - 会话页打开会话时，服务端会先推一个 snapshot（W6 约 1.26MB），这是切会话慢的主因；
 *   - 命中缓存时先本地回放 snapshot；同时仍连上游，等上游 snapshot 到达：
 *       · cursor 与缓存一致（期间没有新消息）→ 丢弃上游 snapshot，后续事件照常转发（连续无缝）
 *       · cursor 不一致（期间有新消息）→ 转发上游 snapshot（客户端会再收到一次 opened，用新数据刷新）
 *   - 未命中时正常转发，并在收到 snapshot 后写入缓存，供下次使用。
 *
 * 浏览器 <-> 本地代理不压缩（本机很快）；代理 <-> 服务器开启 permessage-deflate，
 * 省公网流量。
 */
import { WebSocketServer, WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const FOLLOW_ENDPOINT = 'session/follow';
const MAX_CACHE_ITEM_BYTES = 32 * 1024 * 1024;
const FOLLOW_MAX_MESSAGES = Number(process.env.DSH_FOLLOW_MAX_MESSAGES || 24);

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/** 稳定序列化：对象 key 排序，保证同样内容得到同样缓存 key。 */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
}

function cursorOf(frame) {
  const c = frame?.cursor;
  if (typeof c === 'number') return c;
  if (c && typeof c === 'object') {
    if (typeof c.seq === 'number') return c.seq;
    if (typeof c.throughSeq === 'number') return c.throughSeq;
  }
  const last = Array.isArray(frame?.records) ? frame.records[frame.records.length - 1] : undefined;
  const seq = last?.event?.seq;
  return typeof seq === 'number' ? seq : undefined;
}

export function attachMux(options) {
  const { server, upstreamUrl, headers, cacheDir, log, stats } = options;
  const dir = path.join(cacheDir, 'ws-follow');
  // 缓存写入时间（重启后未知 → 当作过期，直接走上游，避免一上来就强制重连）
  const cacheMeta = new Map();
  // 某个会话刚发生过“快照无法衔接”后，10 分钟内不再回放缓存（避免反复重连）
  const resyncBlock = new Map();
  const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;  // 缓存可回放 6 小时（回放前会用 asOfSeq 核对，安全）
  const RESYNC_BLOCK_MS = 10 * 60 * 1000;
  const MAX_FOLLOW_MESSAGES = FOLLOW_MAX_MESSAGES;
  fs.mkdirSync(dir, { recursive: true });

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false, // 本机链路，不压缩
    maxPayload: 128 * 1024 * 1024,
  });

  function cachePath(key) {
    return path.join(dir, key + '.json.gz');
  }

  function readCache(key) {
    try {
      const raw = zlib.gunzipSync(fs.readFileSync(cachePath(key)));
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return null;
    }
  }

  function writeCache(key, frame) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const raw = Buffer.from(JSON.stringify(frame), 'utf8');
      if (raw.length > MAX_CACHE_ITEM_BYTES) return;
      const gz = zlib.gzipSync(raw, { level: 3 });
      const tmp = cachePath(key) + '.' + process.pid + '.' + Date.now() + '.tmp';
      fs.writeFileSync(tmp, gz);
      fs.renameSync(tmp, cachePath(key));
      cacheMeta.set(key, Date.now());
    } catch (error) {
      log?.('follow 缓存写入失败', String(error?.message ?? error));
    }
  }

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      relay(ws);
    });
  });

  function relay(ws) {
    let upstream;
    try {
      upstream = new WebSocket(upstreamUrl, {
        headers: headers(),
        perMessageDeflate: { threshold: 1024 },
        handshakeTimeout: 20000,
        maxPayload: 128 * 1024 * 1024,
      });
    } catch (error) {
      log?.('mux 上游连接失败', String(error?.message ?? error));
      try {
        ws.close(1011, 'upstream unavailable');
      } catch {}
      return;
    }

    /** streamId -> { key, mode: 'miss'|'hit', servedHitSnapshot: boolean, cachedCursor?: number } */
    const tracks = new Map();
    const queue = [];
    let upstreamOpen = false;

    const sendUpstream = (text) => {
      if (upstreamOpen) {
        try {
          upstream.send(text);
        } catch {}
      } else {
        queue.push(text);
      }
    };

    upstream.on('open', () => {
      upstreamOpen = true;
      stats && (stats.wsConnections = (stats.wsConnections ?? 0) + 1);
      for (const text of queue.splice(0)) {
        try {
          upstream.send(text);
        } catch {}
      }
    });

    upstream.on('message', (data, isBinary) => {
      if (isBinary) {
        try {
          ws.send(data);
        } catch {}
        return;
      }
      let text = data.toString();
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        try {
          ws.send(text);
        } catch {}
        return;
      }
      const track = frame.streamId === undefined ? undefined : tracks.get(frame.streamId);
      if (track && frame.type === 'item') {
        const value = frame.value;
        const isSnapshot = value && value.type === 'snapshot';
        if (track.mode === 'miss') {
          if (isSnapshot) {
            writeCache(track.key, value);
            track.mode = 'forward';
            stats && (stats.wsSnapshotStored = (stats.wsSnapshotStored ?? 0) + 1);
          }
        } else if (track.mode === 'hit-snapshot') {
          // 命中缓存后，等上游的 snapshot：连续（cursor 相同）就丢弃，否则转发新快照
          if (isSnapshot) {
            const cursor = cursorOf(value);
            track.mode = 'forward';
            if (cursor !== undefined && cursor === track.cachedCursor) {
              stats && (stats.wsSnapshotDropped = (stats.wsSnapshotDropped ?? 0) + 1);
              log?.('mux 丢弃上游重复 snapshot', 'cursor=' + String(cursor));
              return;
            }
            // 期间有新事件：若 assistantStream 版本一致、且增量事件首尾连续，
            // 就把增量事件当作普通 entry 逐条补发（客户端状态无缺口，界面不闪）。
            const revision = value?.assistantStream?.revision;
            const records = Array.isArray(value?.records) ? value.records : [];
            const base = track.cachedCursor;
            const delta =
              cursor !== undefined && cursor > base
                ? records.filter((r) => Number(r?.event?.seq) > base)
                : [];
            const contiguous =
              delta.length > 0 &&
              Number(delta[0]?.event?.seq) === base + 1 &&
              Number(delta[delta.length - 1]?.event?.seq) === cursor;
            const revisionOk = revision === undefined || track.cachedRevision === undefined || revision === track.cachedRevision;
            if (contiguous && revisionOk) {
              writeCache(track.key, value);
              for (const record of delta) {
                try {
                  ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: record }));
                } catch {}
              }
              stats && (stats.wsSnapshotFastForwarded = (stats.wsSnapshotFastForwarded ?? 0) + 1);
              log?.('mux 快进增量事件', 'from=' + String(base) + ' to=' + String(cursor) + ' 共 ' + String(delta.length) + ' 条');
              return;
            }
            // 无法无缝衔接：转第二个 snapshot 会触发客户端“重复 opening”协议错误，
            // 因此断开这条 mux 连接，让客户端按自己的重连逻辑重新打开（此时允许替换快照）。
            writeCache(track.key, value);
            stats && (stats.wsSnapshotResync = (stats.wsSnapshotResync ?? 0) + 1);
            resyncBlock.set(key, Date.now() + RESYNC_BLOCK_MS);
            log?.('mux 快照无法衔接，触发客户端重连（10 分钟内该会话不再回放缓存）', 'cursor=' + String(cursor) + ' delta=' + String(delta.length));
            try {
              ws.close(1012, 'snapshot resync');
            } catch {}
          }
        }
      } else if (track && (frame.type === 'end' || frame.type === 'error')) {
        tracks.delete(frame.streamId);
      }
      try {
        ws.send(text);
      } catch {}
    });

    upstream.on('close', () => {
      try {
        ws.close(1011, 'upstream closed');
      } catch {}
    });
    upstream.on('error', (error) => {
      log?.('mux 上游错误', String(error?.message ?? error));
      try {
        ws.close(1011, 'upstream error');
      } catch {}
    });

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        sendUpstream(data.toString());
        return;
      }
      let text = data.toString();
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        sendUpstream(text);
        return;
      }

      if (frame.type === 'open' && frame.endpoint === FOLLOW_ENDPOINT && frame.payload) {
        // 首屏只取最近 N 条（约 10 轮）：DSH 要解析整份日志，少取能显著加快切会话
        try {
          const req0 = frame.payload?.args?.request;
          if (req0) {
            const cap = MAX_FOLLOW_MESSAGES;
            if (req0.maxMessages === undefined || req0.maxMessages > cap) req0.maxMessages = cap;
            // DSH 要求 turnWindow.minMessages ≤ maxMessages，否则直接 400
            if (req0.turnWindow && typeof req0.turnWindow.minMessages === 'number') {
              const m = Math.floor(req0.turnWindow.minMessages);
              req0.turnWindow.minMessages = Math.max(1, Math.min(m > 0 ? m : 1, req0.maxMessages));
            }
            text = JSON.stringify(frame);
          }
        } catch {}
        const key = sha1(stable({ endpoint: frame.endpoint, payload: frame.payload }));
        const cachedAt = cacheMeta.get(key) || 0;
        const tooOld = !cachedAt || Date.now() - cachedAt > CACHE_MAX_AGE_MS;
        const blocked = (resyncBlock.get(key) || 0) > Date.now();
        if (tooOld || blocked) {
          tracks.set(frame.streamId, { key, mode: 'miss' });
          stats && (stats.wsSnapshotSkipped = (stats.wsSnapshotSkipped ?? 0) + 1);
          if (blocked) log?.('mux 该会话刚重连过，跳过缓存回放', 'key=' + key.slice(0, 8));
          sendUpstream(text);
          return;
        }
        const cached = readCache(key);
        if (cached && options.getAsOfSeq) {
          // 先花一次极小请求（~300B）确认会话没有新事件，再回放本地快照；
          // 有变化就走正常拉取，避免客户端收到第二个快照（协议不允许）。
          const address = frame.payload?.args?.request?.address;
          const sessionId = address?.sessionId;
          if (sessionId) {
            const current = await options.getAsOfSeq(sessionId).catch(() => undefined);
            if (current !== undefined && current !== cursorOf(cached)) {
              tracks.set(frame.streamId, { key, mode: 'miss' });
              stats && (stats.wsSnapshotStale = (stats.wsSnapshotStale ?? 0) + 1);
              log?.('mux 快照过期，改走服务器', 'cached=' + String(cursorOf(cached)) + ' now=' + String(current));
              sendUpstream(text);
              return;
            }
          }
        }
        if (cached) {
          const cursor = cursorOf(cached);
          // 先本地回放缓存的 snapshot（毫秒级），再连上游拿增量
          try {
            ws.send(
              JSON.stringify({ type: 'item', streamId: frame.streamId, value: cached }),
            );
          } catch {}
          const revision = cached?.assistantStream?.revision;
          tracks.set(frame.streamId, {
            key,
            mode: cursor === undefined ? 'forward' : 'hit-snapshot',
            cachedCursor: cursor,
            cachedRevision: revision,
          });
          stats && (stats.wsSnapshotHit = (stats.wsSnapshotHit ?? 0) + 1);
          log?.('mux 命中缓存，立即回放 snapshot', 'cursor=' + String(cursor));
          const bytes = Buffer.byteLength(JSON.stringify(cached), 'utf8');
          stats && (stats.bytesSaved = (stats.bytesSaved ?? 0) + bytes);
          // 仍然向上游 open（拿后续事件），但上游 snapshot 会被按 cursor 丢弃
          sendUpstream(JSON.stringify({ ...frame, streamId: frame.streamId }));
          return;
        }
        tracks.set(frame.streamId, { key, mode: 'miss' });
        log?.('mux 未命中缓存，转发 open', 'key=' + key.slice(0, 8));
        stats && (stats.wsSnapshotMiss = (stats.wsSnapshotMiss ?? 0) + 1);
        sendUpstream(text);
        return;
      }

      if (frame.type === 'cancel') tracks.delete(frame.streamId);
      if (frame.type === 'end') tracks.delete(frame.streamId);
      sendUpstream(text);
    });

    ws.on('close', () => {
      try {
        upstream.close();
      } catch {}
    });
    ws.on('error', () => {
      try {
        upstream.close();
      } catch {}
    });
  }
}

/**
 * 预热：用一条独立的 mux 连接，按顺序为最近若干个会话拉取 follow snapshot 并写入缓存。
 * 串行执行，避免占满用户的上行带宽。
 */
export function prefetchFollowSnapshots(options) {
  const { upstreamUrl, headers, cacheDir, sessionIds, log, timeoutMs = 90000 } = options;
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return Promise.resolve({ ok: 0, failed: 0 });
  const dir = path.join(cacheDir, 'ws-follow');
  fs.mkdirSync(dir, { recursive: true });

  return new Promise((resolve) => {
    let ok = 0;
    let failed = 0;
    const ws = new WebSocket(upstreamUrl, {
      headers: headers(),
      perMessageDeflate: { threshold: 1024 },
      handshakeTimeout: 20000,
      maxPayload: 128 * 1024 * 1024,
    });
    let index = 0;
    let currentId;
    let timer;

    const next = () => {
      if (index >= sessionIds.length) {
        try { ws.close(); } catch {}
        resolve({ ok, failed });
        return;
      }
      currentId = sessionIds[index++];
      const payload = {
        args: {
          request: { address: { kind: 'session', sessionId: currentId }, assistantStream: true, maxMessages: FOLLOW_MAX_MESSAGES },
        },
      };
      const key = sha1(stable({ endpoint: FOLLOW_ENDPOINT, payload }));
      const cached = fs.existsSync(path.join(dir, key + '.json.gz'));
      if (cached) { ok++; next(); return; }
      ws.send(JSON.stringify({ type: 'open', streamId: 'prefetch-' + index, endpoint: FOLLOW_ENDPOINT, payload }));
      clearTimeout(timer);
      timer = setTimeout(() => {
        failed++;
        log?.('预取 snapshot 超时', currentId);
        next();
      }, timeoutMs);
    };

    ws.on('open', next);
    ws.on('message', (data) => {
      let frame;
      try { frame = JSON.parse(data.toString()); } catch { return; }
      if (frame.type !== 'item' || !frame.value || frame.value.type !== 'snapshot') return;
      const cacheFile = path.join(dir, sha1(stable({ endpoint: FOLLOW_ENDPOINT, payload: {
        args: { request: { address: { kind: 'session', sessionId: currentId }, assistantStream: true, maxMessages: FOLLOW_MAX_MESSAGES } },
      } })) + '.json.gz');
      try {
        const gz = zlib.gzipSync(Buffer.from(JSON.stringify(frame.value), 'utf8'), { level: 3 });
        fs.writeFileSync(cacheFile + '.tmp', gz);
        fs.renameSync(cacheFile + '.tmp', cacheFile);
        ok++;
        log?.('已预取 snapshot', currentId, String(gz.length) + 'B(压缩)');
      } catch (error) {
        failed++;
        log?.('预取 snapshot 写入失败', String(error?.message ?? error));
      }
      clearTimeout(timer);
      ws.send(JSON.stringify({ type: 'cancel', streamId: 'prefetch-' + index }));
      next();
    });
    ws.on('error', (error) => {
      log?.('预取 mux 连接错误', String(error?.message ?? error));
      clearTimeout(timer);
      resolve({ ok, failed });
    });
    ws.on('close', () => {
      clearTimeout(timer);
      resolve({ ok, failed });
    });
    setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ ok, failed });
    }, timeoutMs * (sessionIds.length + 1));
  });
}
