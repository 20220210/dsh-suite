// DSH 桌面版 —— 启动时应用「已下载好的小更新包」
//
// 为什么不在运行时替换文件：
//   Electron 进程退出时，Windows 上它拉起的子进程会一起被结束（job object），
//   所以「退出后由外部助手替换文件」在部分环境下不可靠。
//   这里改成：下载阶段只把 zip 放到本地并写 pending.json；
//   下次启动时（此时旧进程还在跑，但 JS 文件没有被独占锁定）由应用自己覆盖
//   resources/app，然后 app.relaunch() 用新代码重启。无需外部程序、无需管理员权限。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

function logTo(file, message) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `[${new Date().toISOString()}] [apply] ${message}\n`);
  } catch {}
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // macOS/Linux：系统自带 unzip / bsdtar
  if (process.platform !== 'win32') {
    const un = spawnSync('unzip', ['-oq', zipPath, '-d', destDir], { timeout: 180000 });
    if (un.status === 0) return { ok: true, via: 'unzip' };
    const tar = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { timeout: 180000 });
    return { ok: tar.status === 0, via: 'tar', error: String(tar.stderr || un.stderr || '') };
  }
  // Windows 10/11 自带 tar.exe（bsdtar，可直接解 zip）；失败再退回 PowerShell Expand-Archive
  const tar = spawnSync('tar.exe', ['-xf', zipPath, '-C', destDir], { windowsHide: true, timeout: 120000 });
  if (tar.status === 0) return { ok: true, via: 'tar' };
  const ps = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ],
    { windowsHide: true, timeout: 180000 },
  );
  return { ok: ps.status === 0, via: 'powershell', error: String(ps.stderr || '') };
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else {
      fs.copyFileSync(from, to);
      try {
        const st = fs.statSync(from);
        fs.utimesSync(to, st.atime, st.mtime);
      } catch {}
    }
  }
}

/**
 * 检查并应用 pending.json（如果有）。
 * @returns {{applied:boolean, version?:string, reason?:string}}
 */
function applyPendingUpdate(options) {
  const workDir = options.workDir;
  const appPath = options.appPath; // .../resources/app
  const pendingFile = path.join(workDir, 'pending.json');
  if (!fs.existsSync(pendingFile)) return { applied: false, reason: 'no-pending' };

  let pending = null;
  try {
    pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  } catch (error) {
    logTo(options.log, 'pending.json 解析失败，忽略：' + error.message);
    try {
      fs.unlinkSync(pendingFile);
    } catch {}
    return { applied: false, reason: 'bad-pending' };
  }

  const log = (m) => logTo(options.log || pending.logFile, m);
  if (pending.mode !== 'app') {
    log(`pending 模式 ${pending.mode} 不在启动阶段处理`);
    return { applied: false, reason: 'mode-not-app' };
  }
  if (!pending.zipPath || !fs.existsSync(pending.zipPath)) {
    log('更新包不存在，放弃：' + pending.zipPath);
    try {
      fs.unlinkSync(pendingFile);
    } catch {}
    return { applied: false, reason: 'zip-missing' };
  }

  const stageDir = pending.stageDir || path.join(workDir, 'stage');
  try {
    fs.rmSync(stageDir, { recursive: true, force: true });
  } catch {}
  const unpacked = path.join(stageDir, 'unpacked');

  log(`开始应用更新 ${pending.version} <- ${pending.zipPath}`);
  const extracted = extractZip(pending.zipPath, unpacked);
  if (!extracted.ok) {
    log('解压失败：' + (extracted.error || 'unknown'));
    return { applied: false, reason: 'extract-failed' };
  }
  if (!fs.existsSync(path.join(unpacked, 'main.cjs'))) {
    log('更新包里没有 main.cjs，放弃');
    return { applied: false, reason: 'bad-package' };
  }

  // 备份当前 app 目录，失败可回滚
  const backup = path.join(stageDir, 'backup-app');
  try {
    copyDir(appPath, backup);
    log('已备份当前 resources/app -> ' + backup);
  } catch (error) {
    log('备份失败（继续，风险自负）：' + error.message);
  }

  try {
    copyDir(unpacked, appPath);
    log(`已覆盖 ${appPath}（新版本 ${pending.version}）`);
  } catch (error) {
    log('覆盖失败，回滚：' + error.message);
    try {
      fs.rmSync(appPath, { recursive: true, force: true });
      copyDir(backup, appPath);
      log('回滚完成');
    } catch (rollbackError) {
      log('回滚也失败：' + rollbackError.message);
    }
    return { applied: false, reason: 'copy-failed' };
  }

  try {
    fs.unlinkSync(pendingFile);
  } catch {}
  try {
    fs.rmSync(stageDir, { recursive: true, force: true });
  } catch {}
  try {
    fs.rmSync(pending.zipPath, { force: true });
  } catch {}
  log('更新应用完成，准备重启');
  return { applied: true, version: pending.version };
}

module.exports = { applyPendingUpdate, extractZip, copyDir };
