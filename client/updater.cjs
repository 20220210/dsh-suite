// DSH 桌面版 —— 自动更新模块（绿色版专用）
//
// 流程：
//   1. 版本清单 version.json 放在服务器（可选再放 GitHub），列出小包 / 整包地址与 sha256；
//   2. 启动 20 秒后检查一次，之后每 N 小时一次；菜单里也能手动检查；
//   3. 发现新版本 → 弹窗「一键升级」→ 下载 → 校验 sha256；
//   4. 小包（只含程序代码）：写入 pending.json，重启后由 apply-update.cjs 在启动阶段
//      覆盖 resources/app，再自动重启进入新版本（不需要外部助手、不需要管理员权限）；
//   5. 整包（含 Electron 运行时）：提示用户手动解压覆盖（这种情况很少）。
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');

const MAX_REDIRECTS = 5;

function logLine(file, message) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `[${new Date().toISOString()}] [update] ${message}\n`);
  } catch {}
}

function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(text || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), text: `${m[1]}.${m[2]}.${m[3]}` };
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch > b.patch;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function updaterWorkDir() {
  const base = process.env.LOCALAPPDATA || process.env.TEMP || '/tmp';
  return path.join(base, 'dsh-client', 'updater');
}

/** 只对自己服务器带 Basic 认证，避免把密码发给 GitHub。 */
function authHeaderFor(url, config) {
  try {
    const target = new URL(url);
    const upstream = new URL(config.upstream);
    if (target.host === upstream.host && config.basicUser) {
      return 'Basic ' + Buffer.from(`${config.basicUser}:${config.basicPass || ''}`).toString('base64');
    }
  } catch {}
  return null;
}

function requestStream(url, config) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const go = (target) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch (error) {
        reject(error);
        return;
      }
      const mod = parsed.protocol === 'http:' ? http : https;
      const headers = { 'user-agent': 'dsh-desktop-updater', accept: '*/*' };
      const auth = authHeaderFor(target, config);
      if (auth) headers.authorization = auth;
      const req = mod.get(target, { headers, timeout: 30000 }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (++redirects > MAX_REDIRECTS) {
            reject(new Error('重定向次数过多'));
            return;
          }
          go(new URL(res.headers.location, target).toString());
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        resolve({ res, finalUrl: target });
      });
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
    };
    go(url);
  });
}

async function fetchJson(url, config) {
  const { res } = await requestStream(url, config);
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 下载到文件，边下边算 sha256。 */
async function downloadFile(url, destPath, config, onProgress) {
  const { res } = await requestStream(url, config);
  const total = Number(res.headers['content-length'] || 0);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const out = fs.createWriteStream(destPath);
  const hash = crypto.createHash('sha256');
  let received = 0;
  try {
    for await (const chunk of res) {
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      hash.update(chunk);
      received += chunk.length;
      if (total > 0) onProgress?.(received / total, received, total);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  return { sha256: hash.digest('hex'), bytes: received };
}

function createUpdater(options) {
  const { app, dialog, getWindow, getConfig, saveConfig, installDir, updateLog, openPath, openExternal } = options;
  let checking = false;

  function log(message) {
    logLine(updateLog(), message);
  }

  function manifestUrls() {
    const cfg = getConfig();
    const update = cfg.update || {};
    const list = [];
    for (const url of [...(update.manifests || []), ...(update.extraManifests || [])]) {
      if (url && !list.includes(url)) list.push(url);
    }
    return list;
  }

  function currentElectron() {
    return String(process.versions.electron || '');
  }

  /** 拉清单并判断是否需要更新；返回 { manifest, kind, target } 或 null。 */
  async function findUpdate() {
    const cfg = getConfig();
    const urls = manifestUrls();
    if (urls.length === 0) return null;
    let manifest = null;
    const failures = [];
    for (const url of urls) {
      try {
        manifest = await fetchJson(url, cfg);
        manifest.__source = url;
        break;
      } catch (error) {
        failures.push(`${hostOf(url)}: ${error.message}`);
      }
    }
    if (!manifest) {
      log('所有清单都拉取失败 ' + failures.join(' | '));
      return null;
    }
    const current = app.getVersion();
    if (!isNewer(manifest.version, current)) {
      log(`已是最新版本 ${current}（远端 ${manifest.version}）`);
      return null;
    }
    if ((cfg.update?.skipVersion || '') === String(manifest.version)) {
      log(`用户跳过了 ${manifest.version}`);
      return { manifest, kind: 'skipped' };
    }
    const contiguous = !manifest.electron || String(manifest.electron) === currentElectron();
    const useFull = manifest.forceFull === true || !manifest.app || !contiguous;
    const target = useFull ? manifest.full : manifest.app;
    if (!target || !target.url) return null;
    return { manifest, kind: useFull ? 'full' : 'app', target };
  }

  async function runDownload(job, win) {
    const cfg = getConfig();
    const dir = path.join(updaterWorkDir(), `stage-${job.manifest.version}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'update.zip');
    log(`开始下载 ${job.kind} ${job.manifest.version} <- ${job.target.url}`);
    const result = await downloadFile(job.target.url, file, cfg, (ratio) => {
      try {
        win?.setProgressBar(Math.min(1, ratio));
        if (ratio > 0) win?.setTitle(`正在下载更新 ${Math.floor(ratio * 100)}% — DSH 桌面版`);
      } catch {}
    });
    try {
      win?.setProgressBar(-1);
      win?.setTitle('DSH 桌面版');
    } catch {}
    log(`下载完成 ${result.bytes}B sha256=${result.sha256}`);
    const expected = String(job.target.sha256 || '').toLowerCase();
    if (expected && result.sha256 !== expected) {
      throw new Error(`校验失败：期望 ${expected}，实际 ${result.sha256}`);
    }
    if (!expected) log('清单没有提供 sha256，跳过校验');
    return { dir, file };
  }

  /** 小包：登记 pending.json，重启后由启动阶段应用。 */
  function stagePending({ dir, job }) {
    const work = updaterWorkDir();
    fs.mkdirSync(work, { recursive: true });
    const pending = {
      mode: 'app',
      version: job.manifest.version,
      zipPath: path.join(dir, 'update.zip'),
      stageDir: path.join(work, `apply-${job.manifest.version}`),
      logFile: updateLog(),
      installDir: installDir(),
      exeName: path.basename(process.execPath),
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(work, 'pending.json'), JSON.stringify(pending, null, 2), 'utf8');
    log(`已登记待应用更新 v${job.manifest.version}，重启后自动生效`);
    try {
      app.relaunch();
    } catch {}
    app.quit();
  }

  async function promptAndApply(job, win) {
    const { manifest } = job;
    const sizeMb = job.target.size ? `（约 ${(job.target.size / 1024 / 1024).toFixed(1)} MB）` : '';
    const kindText = job.kind === 'app' ? '小更新包' : '完整更新包';
    const answer = await dialog.showMessageBox(win, {
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 v${manifest.version}，当前 v${app.getVersion()}`,
      detail: [
        manifest.notes ? `更新内容：\n${manifest.notes}` : '更新内容：见发布说明。',
        '',
        `将下载 ${kindText}${sizeMb}，下载完成后自动重启安装。`,
      ].join('\n'),
      buttons: ['立即升级', '稍后', '跳过此版本'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (answer.response === 2) {
      const cfg = getConfig();
      cfg.update = { ...(cfg.update || {}), skipVersion: String(manifest.version) };
      saveConfig(cfg);
      log(`用户跳过 v${manifest.version}`);
      return;
    }
    if (answer.response !== 0) return;

    try {
      const files = await runDownload(job, win);
      if (job.kind === 'app') {
        const confirm = await dialog.showMessageBox(win, {
          type: 'question',
          title: '准备就绪',
          message: '更新已下载并校验通过，现在重启并完成升级？',
          detail: '应用会自动重启两次：第一次应用更新，第二次进入新版本。',
          buttons: ['立即重启升级', '取消'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (confirm.response === 0) stagePending({ ...files, job });
      } else {
        const detail = [
          '这次是完整包更新（底层运行时也变了），需要手动替换：',
          '',
          `1. 打开文件夹：${files.dir}`,
          `2. 退出本程序，把 update.zip 解压覆盖到安装目录：${installDir()}`,
          '',
          '以后的小版本更新都可以一键完成，不用手动。',
        ].join('\n');
        const choice = await dialog.showMessageBox(win, {
          type: 'info',
          title: '需要手动完成完整更新',
          message: `完整包 v${manifest.version} 已下载`,
          detail,
          buttons: ['打开下载文件夹', '稍后'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (choice.response === 0) {
          try {
            if (openPath) openPath(files.dir);
            else if (openExternal) openExternal(files.dir);
          } catch {}
        }
      }
    } catch (error) {
      log('下载或校验失败: ' + error.message);
      await dialog.showMessageBox(win, {
        type: 'error',
        title: '升级失败',
        message: '下载更新失败：' + error.message,
        detail: '可以稍后重试，或到发布页手动下载完整包。',
        buttons: ['知道了'],
        noLink: true,
      });
    }
  }

  async function check({ manual = false } = {}) {
    if (checking) return;
    checking = true;
    const win = getWindow();
    try {
      const found = await findUpdate();
      if (!found) {
        if (manual) {
          await dialog.showMessageBox(win, {
            type: 'info',
            title: '检查更新',
            message: `当前已是最新版本 v${app.getVersion()}`,
            buttons: ['好的'],
            noLink: true,
          });
        }
        return;
      }
      if (found.kind === 'skipped') {
        if (manual) {
          await dialog.showMessageBox(win, {
            type: 'info',
            title: '检查更新',
            message: `v${found.manifest.version} 已被你跳过`,
            detail: '想升级的话，可以在「帮助 → 检查更新」里再点一次；或修改配置里的 update.skipVersion。',
            buttons: ['好的'],
            noLink: true,
          });
        }
        return;
      }
      await promptAndApply(found, win);
    } catch (error) {
      log('检查更新失败: ' + error.message);
    } finally {
      checking = false;
    }
  }

  return { check };
}

module.exports = { createUpdater, parseVersion, isNewer, updaterWorkDir };
