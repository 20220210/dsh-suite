// DSH 桌面版 v1.2.0 —— Electron 主进程（绿色版）
// 职责：单实例 → 准备配置 → 拉起本地缓存代理 → 等代理就绪 → 打开窗口
//       → 首次运行创建桌面快捷方式 → 定期检查更新（一键升级）
const { app, BrowserWindow, Menu, dialog, shell, Tray, nativeImage, Notification, safeStorage, nativeTheme, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createUpdater } = require('./updater.cjs');
const { applyPendingUpdate } = require('./apply-update.cjs');

const PROXY_PORT = 19390;

// 多实例：默认两个（主实例 / rc.2 实例），可在 config.json 的 instances 里增删改
const DEFAULT_INSTANCES = [
  { name: '主实例', upstream: 'https://tnty.9017i.cc:19306', port: 19390 },
  { name: 'rc.2 实例', upstream: 'https://tnty.9017i.cc:19306/rc2', port: 19392 },
];
let instances = DEFAULT_INSTANCES.map((x) => ({ ...x }));
let currentInst = 0;
function inst(i = currentInst) { return instances[i] || instances[0] || { name: '主实例', upstream: '', port: PROXY_PORT }; }
function instUrl(i = currentInst) { return `http://127.0.0.1:${inst(i).port}/`; }

/** 从 config.json 读实例列表：第 1 个用顶层 upstream，其余用 instances[].upstream。 */
function loadInstances() {
  const cfg = readConfig() || {};
  const base = String(cfg.upstream || 'https://tnty.9017i.cc:19306');
  const raw = Array.isArray(cfg.instances) && cfg.instances.length ? cfg.instances : DEFAULT_INSTANCES;
  const list = raw.map((x, i) => ({
    name: String((x && x.name) || (i === 0 ? '主实例' : `实例 ${i + 1}`)),
    upstream: i === 0 ? base : String((x && x.upstream) || ''),
    port: Number((x && x.port) || (i === 0 ? PROXY_PORT : PROXY_PORT + i * 2)),
  })).filter((x) => x.upstream && Number.isFinite(x.port));
  instances = list.length ? list : [{ name: '主实例', upstream: base, port: PROXY_PORT }];
  if (currentInst >= instances.length) currentInst = 0;
}

// 调试用：设置 DSH_DEBUG_CDP=1 时开放 Chrome DevTools 协议端口（排查界面问题用，默认关闭）
if (process.env.DSH_DEBUG_CDP === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

let mainWindow = null;
const proxyChildren = new Map();   // port -> child

// 客户端机器标识（远端据此区分哪台电脑/哪个实例）
const CLIENT_NAME = (() => {
  try {
    const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || '', 'DSH Desktop', 'config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; } })();
    if (cfg && typeof cfg.clientName === 'string' && cfg.clientName.trim()) return cfg.clientName.trim();
  } catch {}
  try { return require('node:os').hostname() || 'dsh-client'; } catch { return 'dsh-client'; }
})();
let CONFIG_PATH = null;
let remoteUntil = 0;
let remoteTick = null;
let updater = null;
let checkTimer = null;
let tray = null;
let isQuitting = false;
let notifyTimer = null;
let authWarned = false;
let trayHintShown = false;

// ------------------------------------------------ 配置

function userDataDir() {
  return app.getPath('userData');
}

function installDir() {
  return path.dirname(process.execPath);
}

function logFile() {
  const dir = path.join(userDataDir(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'proxy.log');
}

function mainLog(...args) {
  try {
    fs.appendFileSync(logFile(), `[${new Date().toISOString()}] [main] ${args.join(' ')}\n`);
  } catch {}
}

function updateLogFile() {
  const dir = path.join(userDataDir(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'update.log');
}

function configPath() {
  return path.join(userDataDir(), 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

const SECRET_FIELDS = [
  ['basicPass', 'basicPassEnc'],
  ['token', 'tokenEnc'],
];

function writeConfigRaw(cfg) {
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (error) {
    console.error('保存配置失败', error);
  }
}

/** 保存配置：密码/token 一律加密后写盘（Windows DPAPI）。 */
function saveConfig(cfg) {
  const out = { ...cfg };
  if (safeStorage.isEncryptionAvailable()) {
    for (const [plain, enc] of SECRET_FIELDS) {
      if (typeof out[plain] === 'string' && out[plain]) {
        try {
          out[enc] = safeStorage.encryptString(out[plain]).toString('base64');
          delete out[plain];
        } catch {}
      }
    }
  }
  writeConfigRaw(out);
}

/** 运行时配置：把加密字段解密成明文（只用于进程内/传给代理，不落盘）。 */
function runtimeConfig() {
  const cfg = readConfig();
  if (!safeStorage.isEncryptionAvailable()) return cfg;
  for (const [plain, enc] of SECRET_FIELDS) {
    if (!cfg[plain] && cfg[enc]) {
      try {
        cfg[plain] = safeStorage.decryptString(Buffer.from(cfg[enc], 'base64'));
      } catch {}
    }
  }
  return cfg;
}

/** 老配置里的明文密码/token → 用 DPAPI 加密后重写（只做一次）。 */
function migrateSecrets() {
  if (!safeStorage.isEncryptionAvailable()) return;
  const cfg = readConfig();
  let changed = false;
  for (const [plain, enc] of SECRET_FIELDS) {
    if (typeof cfg[plain] === 'string' && cfg[plain]) {
      try {
        cfg[enc] = safeStorage.encryptString(cfg[plain]).toString('base64');
        delete cfg[plain];
        changed = true;
      } catch {}
    }
  }
  if (changed) {
    writeConfigRaw(cfg);
    mainLog('凭据已用 DPAPI 加密写入 config.json');
  }
}

/** cookie 加密密钥：DPAPI 保护，明文不落盘。 */
function cookieKey() {
  try {
    const dir = path.join(process.env.LOCALAPPDATA || userDataDir(), 'dsh-client');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'secret.key');
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (raw) return safeStorage.decryptString(Buffer.from(raw, 'base64'));
    }
    if (!safeStorage.isEncryptionAvailable()) return null;
    const key = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, safeStorage.encryptString(key).toString('base64'), { mode: 0o600 });
    return key;
  } catch (error) {
    console.error('初始化缓存加密密钥失败', error);
    return null;
  }
}

/** 收紧配置文件与缓存目录权限：只留当前用户 + SYSTEM + Administrators。 */
function hardenAcl() {
  if (process.platform !== 'win32') return;
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME || '';
  const targets = [userDataDir(), path.join(process.env.LOCALAPPDATA || userDataDir(), 'dsh-client')];
  const run = (args) => spawnSync('icacls.exe', args, { windowsHide: true, timeout: 60000 });
  for (const target of targets) {
    try {
      if (!target || !fs.existsSync(target)) continue;
      // 1) 目录本身去掉继承，设置可继承的权限
      run([target, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F', 'Administrators:(OI)(CI)F', '/C', '/Q']);
      // 2) 已存在的文件补“显式”权限（文件不能用 (OI)(CI)，否则会变成空 ACL 导致自己都读不了）
      run([target, '/T', '/C', '/Q', '/grant:r', `${user}:F`, 'SYSTEM:F', 'Administrators:F']);
      // 3) 再让所有子目录带上可继承权限，保证以后新建的文件也能继承
      run([target, '/T', '/C', '/Q', '/grant:r', `${user}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F', 'Administrators:(OI)(CI)F']);
      mainLog(`ACL 收紧完成 ${target}`);
    } catch (error) {
      mainLog(`ACL 收紧失败 ${target}: ${String(error?.message ?? error)}`);
    }
  }
}

function ensureConfig() {
  const target = configPath();
  if (fs.existsSync(target)) return target;
  const candidates = [
    path.join(__dirname, 'default-config.json'),
    path.join(process.resourcesPath || '', 'app', 'default-config.json'),
  ];
  let source = null;
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      source = c;
      break;
    }
  }
  fs.mkdirSync(userDataDir(), { recursive: true });
  if (source) fs.copyFileSync(source, target);
  else fs.writeFileSync(target, JSON.stringify({ upstream: '', token: '', basicUser: '', basicPass: '' }, null, 2));
  return target;
}

// ------------------------------------------------ 桌面快捷方式（绿色版用）

function shortcutPath() {
  try {
    return path.join(app.getPath('desktop'), 'DSH Desktop.lnk');
  } catch {
    return null;
  }
}

// ------------------------------------------------ 图标（统一用 DSH 官方鲸鱼 logo，深浅色自适应）

function isDarkTheme() {
  try {
    return nativeTheme.shouldUseDarkColors;
  } catch {
    return true;
  }
}

function windowIconPath() {
  return path.join(__dirname, 'assets', isDarkTheme() ? 'icon-white-256.png' : 'icon-black-256.png');
}

function trayIconPath() {
  return path.join(__dirname, 'assets', isDarkTheme() ? 'tray-white.ico' : 'tray-black.ico');
}

function shortcutIconPath() {
  const p = path.join(__dirname, 'assets', 'dsh.ico');
  return fs.existsSync(p) ? p : undefined;
}

function applyThemeIcons() {
  try {
    if (tray) tray.setImage(nativeImage.createFromPath(trayIconPath()));
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIcon(windowIconPath());
  } catch {}
}

function ensureDesktopShortcut({ quiet = false } = {}) {
  if (process.platform !== 'win32') return;
  const lnk = shortcutPath();
  if (!lnk) return;
  const target = process.execPath;
  const exists = fs.existsSync(lnk);
  let same = false;
  if (exists) {
    try {
      const info = shell.readShortcutLink(lnk);
      same = path.resolve(String(info.target || '')) === path.resolve(target);
      if (same && String(info.appUserModelId || '') !== 'com.dsh.desktop') same = false;
      const ico = shortcutIconPath();
      if (same && ico && path.resolve(String(info.icon || '')) !== path.resolve(ico)) same = false;
    } catch {}
  }
  if (same && quiet) return; // 已经指向当前位置，静默模式下不打扰
  const operation = exists ? 'replace' : 'create';
  try {
    const ok = shell.writeShortcutLink(lnk, operation, {
      target,
      cwd: path.dirname(target),
      icon: shortcutIconPath() ?? target,
      iconIndex: 0,
      description: 'DSH 桌面版（本地缓存加速）',
      appUserModelId: 'com.dsh.desktop',
    });
    if (!quiet) {
      dialog.showMessageBox({
        type: ok ? 'info' : 'warning',
        title: '桌面快捷方式',
        message: ok ? '已创建桌面快捷方式：DSH Desktop' : '创建桌面快捷方式失败',
        detail: ok ? '以后可以从桌面直接打开。' : '可以手动右键 “DSH Desktop.exe” → 发送到 → 桌面快捷方式。',
        buttons: ['好的'],
        noLink: true,
      });
    }
  } catch (error) {
    if (!quiet) {
      dialog.showMessageBox({
        type: 'warning',
        title: '桌面快捷方式',
        message: '创建桌面快捷方式失败：' + error.message,
        buttons: ['好的'],
        noLink: true,
      });
    }
  }
}

// Windows 通知需要“开始菜单里带 AppUserModelID 的快捷方式”
function ensureStartMenuShortcut() {
  if (process.platform !== 'win32') return;
  try {
    const dir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    if (!dir || !fs.existsSync(dir)) return;
    const lnk = path.join(dir, 'DSH Desktop.lnk');
    const target = process.execPath;
    if (fs.existsSync(lnk)) {
      try {
        const info = shell.readShortcutLink(lnk);
        const sameTarget = path.resolve(String(info.target || '')) === path.resolve(target);
        const sameAumid = String(info.appUserModelId || '') === 'com.dsh.desktop';
        const ico = shortcutIconPath();
        const sameIcon = !ico || path.resolve(String(info.icon || '')) === path.resolve(ico);
        if (sameTarget && sameAumid && sameIcon) return;
      } catch {}
    }
    shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', {
      target,
      cwd: path.dirname(target),
      icon: shortcutIconPath() ?? target,
      iconIndex: 0,
      description: 'DSH 桌面版',
      appUserModelId: 'com.dsh.desktop',
    });
    mainLog('已创建带 AUMID 的开始菜单快捷方式');
  } catch (error) {
    mainLog('创建开始菜单快捷方式失败: ' + String(error?.message ?? error));
  }
}

// ------------------------------------------------ 代理子进程

/** 首次运行 / 密码失效时，用一个小窗口让用户输入访问密码（不落明文，保存后 DPAPI 加密）。 */
function promptPassword(reason) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(typeof value === 'string' && value.trim() ? value.trim() : null);
    };
    const win = new BrowserWindow({
      width: 430, height: 230, resizable: false, minimizable: false, maximizable: false,
      title: 'DSH Desktop 登录',
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      modal: true, show: false, alwaysOnTop: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    try { win.setMenuBarVisibility(false); } catch {}
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{font-family:"Microsoft YaHei",system-ui,sans-serif;background:#fff;margin:0;padding:18px;color:#111}
      h3{margin:0 0 6px;font-size:15px}p{color:#666;font-size:12px;margin:0 0 12px;line-height:1.5}
      input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #ccc;border-radius:6px;font-size:14px}
      .row{margin-top:14px;text-align:right}
      button{padding:7px 16px;border-radius:6px;border:1px solid #ccc;background:#f5f5f5;cursor:pointer;font-size:13px}
      button.primary{background:#2d6cdf;border-color:#2d6cdf;color:#fff;margin-left:8px}
    </style>
    <h3>${reason || '请输入访问密码'}</h3>
    <p>用户名 <b>dsh</b>。密码只会加密保存在本机，不会以明文落盘。</p>
    <input id="pw" type="password" placeholder="访问密码">
    <div class="row"><button id="cancel">取消</button><button id="ok" class="primary">确定</button></div>
    <script>
      const { ipcRenderer } = require('electron');
      const pw = document.getElementById('pw');
      const send = (v) => ipcRenderer.send('dsh-pw-result', v);
      document.getElementById('ok').onclick = () => send(pw.value);
      document.getElementById('cancel').onclick = () => send(null);
      pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(pw.value); });
      setTimeout(() => pw.focus(), 60);
    </script>`;
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    ipcMain.once('dsh-pw-result', (ev, value) => { try { win.close(); } catch {} done(value); });
    win.on('closed', () => done(null));
    win.once('ready-to-show', () => { win.show(); win.focus(); });
  });
}

// 清扫占着本地代理端口的残留进程（应用被强杀后子进程可能变成孤儿）
function killPortOwner(port) {
  if (process.platform !== 'win32') return;
  try {
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`],
      { windowsHide: true, timeout: 8000, encoding: 'utf8' });
    const pids = String(ps.stdout || '').split(/\s+/).filter((x) => /^\d+$/.test(x));
    for (const pid of pids) {
      const info = spawnSync('powershell.exe', ['-NoProfile', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`],
        { windowsHide: true, timeout: 5000, encoding: 'utf8' });
      const name = String(info.stdout || '').trim();
      if (!name) continue;
      if (!/electron|dsh/i.test(name)) { mainLog(`端口 ${port} 被其它程序占用（${name} pid=${pid}），不处理`); continue; }
      spawnSync('taskkill.exe', ['/F', '/PID', pid], { windowsHide: true, timeout: 8000 });
      mainLog(`已清理占用端口 ${port} 的残留进程 ${name} pid=${pid}`);
    }
  } catch (e) {
    mainLog('清理端口占用失败: ' + String(e && e.message ? e.message : e));
  }
}

// 端口是否已被监听（比 /__proxy/stats 更宽松，避免误判启动失败）
function portOpen(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const sock = net.connect({ host: '127.0.0.1', port });
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

function startProxy(cfgPath, idx = 0) {
  const proxyScript = path.join(__dirname, 'proxy.mjs');
  const out = fs.createWriteStream(logFile(), { flags: 'a' });
  const runtime = runtimeConfig();
  const it = inst(idx);
  const secrets = { basicUser: runtime.basicUser ?? '', basicPass: runtime.basicPass ?? '', token: runtime.token ?? '' };
  const key = cookieKey();
  const extraEnv = {
    DSH_CLIENT_CONFIG: cfgPath,
    DSH_CLIENT_SECRETS: JSON.stringify(secrets),
    DSH_CLIENT_UPSTREAM: it.upstream,
    DSH_CLIENT_PORT: String(it.port),
    DSH_CLIENT_NAME: `${String(CLIENT_NAME || 'dsh-client').replace(/[^\x20-\x7E]/g, '')}-i${idx}`.replace(/\s+/g, '-'),
  };
  if (key) extraEnv.DSH_CLIENT_KEY = key;
  const child = spawn(process.execPath, [proxyScript, '--no-open'], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1', // 用 Electron 内置 Node 跑 ESM 脚本，用户无需装 Node
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proxyChildren.set(it.port, child);
  // end:false —— 不要把日志流结束掉，否则子进程退出后再写会抛 ERR_STREAM_WRITE_AFTER_END
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  const logLine = (text) => { try { if (!out.writableEnded) out.write(text); } catch {} };
  child.on('exit', (code) => {
    logLine(`\n[main] 代理退出 code=${code} (${it.name} :${it.port})\n`);
  });
  child.on('error', (error) => {
    logLine(`\n[main] 代理启动失败 (${it.name}): ${error}\n`);
  });
  child.on('close', () => { proxyChildren.delete(it.port); try { out.end(); } catch {} });
}

function stopProxy(idx = currentInst) {
  const child = proxyChildren.get(inst(idx).port);
  if (child && !child.killed) {
    try {
      child.kill();
    } catch {}
  }
}

function proxyInfo(idx = currentInst) {
  return new Promise((resolve) => {
    const req = http.get(`${instUrl(idx)}__proxy/stats`, { timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** 端口上如果跑着旧版本的代理，先杀掉，避免升级后仍用旧代理。 */
function killStaleProxy(pid) {
  if (!pid) return;
  try {
    require('node:child_process').spawnSync('taskkill.exe', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 10000 });
  } catch {}
}

function proxyAlive(idx = currentInst) {
  return new Promise((resolve) => {
    const req = http.get(instUrl(idx), { timeout: 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitProxy(timeoutMs = 60000, idx = currentInst) {
  const started = Date.now();
  for (;;) {
    if (await proxyAlive(idx)) return true;
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ------------------------------------------------ 托盘 / 开机自启

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function autostartEnabled() {
  try {
    return Boolean(app.getLoginItemSettings().openAtLogin);
  } catch {
    return false;
  }
}

function setAutostart(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: process.execPath, args: [] });
  } catch (error) {
    console.error('设置开机自启失败', error);
  }
}

function setupTray() {
  if (process.platform !== 'win32' || tray) return;
  try {
    const iconPath = trayIconPath();
    const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    tray = new Tray(image);
    tray.setToolTip('DSH 桌面版');
    mainLog(`托盘图标 ${image.isEmpty() ? '加载失败' : `已加载 ${image.getSize().width}x${image.getSize().height}`}（${isDarkTheme() ? '深色' : '浅色'}主题）`);
    const menu = Menu.buildFromTemplate([
      { label: '打开主界面', click: () => showWindow() },
      { label: '检查更新…', click: () => updater?.check({ manual: true }) },
      { label: '连接 / 缓存状态…', click: () => showProxyStats() },
      { label: '发送测试通知', click: () => notifyTaskDone('测试会话', 75000) },
      { type: 'separator' },
      {
        label: '开机自动启动',
        type: 'checkbox',
        checked: autostartEnabled(),
        click: (item) => {
          setAutostart(item.checked);
          const cfg = readConfig();
          cfg.autoStart = Boolean(item.checked);
          saveConfig(cfg);
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
    mainLog('托盘图标已创建');
    nativeTheme.on('updated', applyThemeIcons);
    tray.on('double-click', () => showWindow());
    tray.on('click', () => showWindow());
  } catch (error) {
    console.error('创建托盘失败', error);
  }
}

// ------------------------------------------------ 任务完成通知（Windows 右下角系统通知）

function notifyTaskDone(title, durationMs) {
  const name = String(title || '').trim() || '会话';
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  const cost = seconds >= 90 ? `${Math.round(seconds / 60)} 分钟` : `${seconds} 秒`;
  const body = `「${name}」已完成（用时 ${cost}）`;
  const payload = { title: 'DSH 任务完成', body };
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: payload.title, body: payload.body, silent: false });
      n.on('click', () => showWindow());
      n.show();
      mainLog(`系统通知已发送：${payload.body}`);
      return;
    }
  } catch {}
  try {
    tray?.displayBalloon({ title: payload.title, content: payload.body, iconType: 'info' });
    mainLog(`托盘气泡已发送：${payload.body}`);
  } catch {}
}

function fetchWatch() {
  return new Promise((resolve) => {
    const req = http.get(`${instUrl()}__proxy/watch`, { timeout: 4000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

let runningSince = new Map();
async function pollWatch() {
  const data = await fetchWatch();
  if (!data || !Array.isArray(data.items)) return;
  const cfg = readConfig();
  const ncfg = cfg.notify || {};
  if (ncfg.enabled === false) return;
  const minSeconds = Math.max(0, Number(ncfg.minSeconds ?? 20));
  const onlyUnfocused = ncfg.onlyWhenUnfocused !== false;
  const focused = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
  const now = Date.now();
  for (const item of data.items) {
    // 修 bug：以前这里存的是时间戳数字，下面却读 prev.since（undefined）
    // → duration = NaN → 永远不满足条件，通知一次都没发出去过。
    const since = runningSince.get(item.sessionId);
    if (item.running) {
      if (since === undefined) runningSince.set(item.sessionId, now);
    } else if (since !== undefined) {
      const duration = now - since;
      runningSince.delete(item.sessionId);
      if (duration >= minSeconds * 1000 && (!onlyUnfocused || !focused || !mainWindow?.isVisible())) {
        notifyTaskDone(item.title, duration);
      }
    }
  }
}

function startNotifyWatcher() {
  stopNotifyWatcher();
  notifyTimer = setInterval(() => {
    pollWatch().catch(() => {});
  }, 5000);
  notifyTimer.unref?.();
}

function stopNotifyWatcher() {
  if (notifyTimer) clearInterval(notifyTimer);
  notifyTimer = null;
}

// ------------------------------------------------ 令牌失效提示

function showTokenUpdateHelp() {
  const current = readConfig();
  const masked = current.tokenEnc ? '（已加密保存）' : '（未设置）';
  const opts = {
    type: 'info',
    title: '更新访问令牌',
    message: '访问令牌已加密保存',
    detail: [
      `配置文件：${configPath()}`,
      `当前令牌：${masked}`,
      '',
      '如果服务器端换了 token（或登录失败提示凭据失效）：',
      '1. 点下面「打开配置文件」；',
      '2. 在 JSON 里加一行  "token": "新的token"  （existing 的 tokenEnc 可以留着）；',
      '3. 保存后重启 DSH 桌面版（退出托盘图标再打开即可）。',
      '',
      '保存后客户端会自动加密明文 token，不会以明文留在磁盘上。',
      'BasicAuth 用户名/密码同理：加 "basicUser"/"basicPass" 后重启。',
    ].join('\n'),
    buttons: ['打开配置文件', '取消'],
    noLink: true,
  };
  const show = mainWindow && !mainWindow.isDestroyed() ? dialog.showMessageBox(mainWindow, opts) : dialog.showMessageBox(opts);
  show.then((r) => {
    if (r.response === 0) shell.openPath(configPath()).catch(() => {});
  });
}

function checkAuthState(stats) {
  if (!stats) return;
  if (stats.authError && !authWarned) {
    authWarned = true;
    const opts = {
      type: 'warning',
      title: '登录凭据失效',
      message: '服务器拒绝了当前凭据',
      detail: '可能是服务器更换了访问密码。点「重新输入密码」后输入新密码即可（会自动加密保存并重连）。',
      buttons: ['重新输入密码', '稍后'],
      noLink: true,
    };
    const show = mainWindow && !mainWindow.isDestroyed() ? dialog.showMessageBox(mainWindow, opts) : dialog.showMessageBox(opts);
    show.then(async (r) => {
      if (r.response !== 0) return;
      const pw = await promptPassword('请输入新的访问密码');
      if (!pw) return;
      const cfg = readConfig();
      saveConfig({ ...cfg, basicUser: cfg.basicUser || 'dsh', basicPass: pw });
      try {
        stopProxy();
        await new Promise((res) => setTimeout(res, 700));
        startProxy(CONFIG_PATH || ensureConfig());
        const ok = await waitProxy(30000);
        authWarned = false;
        if (ok && mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(instUrl());
        mainLog('已用新密码重启本地代理');
      } catch (error) {
        mainLog('用新密码重启代理失败: ' + String(error && error.message ? error.message : error));
      }
    });
  }
}

// ------------------------------------------------ 自动更新

function setupUpdater() {
  updater = createUpdater({
    app,
    dialog,
    getWindow: () => mainWindow,
    getConfig: runtimeConfig,
    saveConfig,
    installDir,
    updateLog: updateLogFile,
    openPath: (p) => shell.openPath(p).catch(() => {}),
    openExternal: (u) => shell.openExternal(u).catch(() => {}),
  });

  const cfg = readConfig();
  const update = cfg.update || {};
  if (update.enabled === false) return;

  const hours = Number(update.checkIntervalHours || 6);
  const everyMs = Math.max(1, hours) * 3600 * 1000;

  // 启动后先等页面正常显示，再静默检查一次
  setTimeout(() => {
    if (process.platform === 'win32') updater.check({ manual: false });
  }, 20000);

  clearInterval(checkTimer);
  checkTimer = setInterval(() => {
    if (process.platform === 'win32') updater.check({ manual: false });
  }, everyMs);
  checkTimer.unref?.();
}

// ------------------------------------------------ 窗口

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'DSH 桌面版',
    autoHideMenuBar: false,
    backgroundColor: '#0f1115',
    icon: windowIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.loadURL(instUrl());
  // 首页偶尔会因本地代理刚起步/上游忙而加载失败（窗口就一片黑），这里自动重试几次
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL) => {
    try { mainLog(`页面加载失败 ${errorCode} ${errorDesc} ${validatedURL}，1.5 秒后重试`); } catch {}
    if (errorCode === -3) return; // 主动 abort（例如重载）不算失败
    setTimeout(() => {
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(instUrl()); } catch {}
    }, 1500);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 关闭窗口默认最小化到托盘（可在 config.json 设 closeToTray:false 改成直接退出）
  mainWindow.on('close', (event) => {
    const cfg = readConfig();
    if (!isQuitting && cfg.closeToTray !== false && tray) {
      event.preventDefault();
      mainWindow.hide();
      if (!trayHintShown) {
        trayHintShown = true;
        try {
          if (Notification.isSupported()) {
            const n = new Notification({
              title: 'DSH 桌面版仍在后台运行',
              body: '任务完成时会在这里提醒；双击托盘图标可重新打开窗口。',
              silent: true,
            });
            n.on('click', () => showWindow());
            n.show();
          }
        } catch {}
      }
    }
  });

  // 站内链接正常打开，外部链接走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    dialog.showMessageBox({ type: 'error', message: `页面进程异常退出：${details.reason}\n可以点“视图→重新加载”。` });
  });
}

function fetchProxyStats() {
  return new Promise((resolve, reject) => {
    const req = http.get(`${instUrl()}__proxy/stats`, { timeout: 4000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('请求本地代理超时'));
    });
  });
}

async function showProxyStats() {
  try {
    const stats = await fetchProxyStats();
    const mb = (n) => `${(Number(n || 0) / 1048576).toFixed(1)} MB`;
    const uptime = Math.max(0, Math.round((Date.now() - Number(stats.startedAt || Date.now())) / 1000));
    const detail = [
      `客户端版本：${app.getVersion()}      本地代理版本：${stats.version ?? '?'}`,
      `已运行：${Math.floor(uptime / 60)} 分 ${uptime % 60} 秒      WebSocket 连接：${stats.wsConnections ?? 0}`,
      '',
      `接口缓存：命中 ${stats.apiHit ?? 0} 次 / 未命中 ${stats.apiMiss ?? 0} 次（新写入 ${stats.apiStored ?? 0}）`,
      `首屏会话列表：磁盘缓存命中 ${stats.listDiskHit ?? 0} 次`,
      `累计节省流量：${mb(stats.bytesSaved)}`,
      '',
      `切会话：本地快照命中 ${stats.wsSnapshotHit ?? 0} 次，自动重同步 ${stats.wsSnapshotResync ?? 0} 次，丢弃重复 ${stats.wsSnapshotDropped ?? 0} 次`,
      `预取：${stats.prefetched ?? 0} 个会话 / 共 ${stats.prefetchPages ?? 0} 页${
        stats.lastPrefetch ? `（上次 ${stats.lastPrefetch.sessions} 个会话，用时 ${stats.lastPrefetch.ms}ms）` : ''
      }`,
    ].join('\n');
    const opts = {
      type: 'info',
      title: '连接 / 缓存状态',
      message: '本地缓存代理运行状态',
      detail,
      buttons: ['确定'],
      noLink: true,
    };
    if (mainWindow && !mainWindow.isDestroyed()) {
      await dialog.showMessageBox(mainWindow, opts);
    } else {
      await dialog.showMessageBox(opts);
    }
  } catch (error) {
    dialog.showMessageBox({
      type: 'error',
      title: '连接 / 缓存状态',
      message: '读取本地代理状态失败',
      detail: String(error?.message ?? error),
    });
  }
}

// ---------------------------------------------------------------- 一键重连
/** 重启本地代理并刷新页面：用于解决切会话卡死、连接假死，无需退出程序 */
async function hardReconnect() {
  mainLog('手动重连：重启本地代理并刷新页面');
  try { stopProxy(); } catch {}
  await new Promise((r) => setTimeout(r, 800));
  try {
    const running = await proxyInfo();
    if (running && running.pid) {
      killStaleProxy(running.pid);
      await new Promise((r) => setTimeout(r, 700));
    }
  } catch {}
  killPortOwner(inst().port);
  await new Promise((r) => setTimeout(r, 300));
  startProxy(CONFIG_PATH || ensureConfig(), currentInst);
  const ok = await waitProxy(35000, currentInst);
  if (!ok) {
    dialog.showErrorBox('重连失败', '本地代理没有启动起来，请查看日志：\n' + logFile());
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.loadURL(instUrl()); } catch {}
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  remoteNotify('已重连', '本地代理已重启，页面已刷新');
  mainLog('手动重连完成');
}

// ---------------------------------------------------------------- 管理员重启
function isElevatedWindows() {
  if (process.platform !== 'win32') return false;
  try {
    const r = spawnSync('net', ['session'], { windowsHide: true, timeout: 6000 });
    return r && r.status === 0;
  } catch { return false; }
}

function restartAsAdmin() {
  if (process.platform !== 'win32') return;
  if (isElevatedWindows()) {
    dialog.showMessageBox({ type: 'info', title: '以管理员身份重启', message: '当前已经是管理员权限运行，无需重启。' });
    return;
  }
  const opts = {
    type: 'question',
    title: '以管理员身份重启',
    message: '将以管理员权限重新启动 DSH 桌面版？',
    detail: [
      '接下来会出现 Windows 的 UAC 提示，需要点「是」。',
      '',
      '· 客户端会先退出，约 3 秒后以管理员身份重新打开',
      '· 取消 UAC 的话不会启动，需要你手动再打开一次',
      '· 以管理员运行时，远程协助也能执行管理员级操作',
    ].join('\n'),
    buttons: ['以管理员重启', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const p = dialog.showMessageBox(opts);
  p.then((r) => {
    if (r.response !== 0) return;
    const exe = process.execPath;
    const ps = `Start-Sleep -Seconds 3; Start-Process -FilePath '${exe.replace(/'/g, "''")}' -Verb RunAs`;
    try {
      spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } catch (e) {
      dialog.showErrorBox('提权重启失败', String(e && e.message));
      return;
    }
    isQuitting = true;
    setTimeout(() => app.quit(), 600);
  });
}

// ---------------------------------------------------------------- 远程协助
function proxyRequest(method, path, payload) {
  return new Promise((resolve) => {
    try {
      const url = new URL(instUrl() + path.replace(/^\//, ''));
      const body = payload ? JSON.stringify(payload) : null;
      const req = http.request(
        { hostname: url.hostname, port: url.port, path: url.pathname, method, timeout: 3000,
          headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} },
        (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => resolve(null));
      if (body) req.write(body);
      req.end();
    } catch { resolve(null); }
  });
}

function remoteMenuLabel() {
  const left = remoteUntil - Date.now();
  if (left <= 0) return '远程协助（已关闭）';
  const m = Math.floor(left / 60000);
  const sec = Math.floor((left % 60000) / 1000);
  return `远程协助（剩余 ${m}:${String(sec).padStart(2, '0')} · 点击关闭）`;
}

function remoteNotify(title, body) {
  try { new Notification({ title, body }).show(); } catch {}
}

async function toggleRemoteAssist() {
  // 已开启 → 立即关闭
  if (remoteUntil > Date.now()) {
    remoteUntil = 0;
    await proxyRequest('POST', '__proxy/remote', { enabled: false });
    remoteNotify('远程协助已关闭', '服务器已无法连接本机');
    buildMenu();
    return;
  }
  const opts = {
    type: 'warning',
    title: '远程协助',
    message: '允许服务器临时连接本机？',
    detail: [
      '开启后，服务器可以在本机执行命令（安装更新、查看日志、排查问题等）。',
      '',
      '· 时长：30 分钟，到点自动断开',
      '· 期间可随时点菜单关闭',
      '· 关闭后服务器无法再连接',
    ].join('\n'),
    buttons: ['开启 30 分钟', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const r = mainWindow && !mainWindow.isDestroyed() ? await dialog.showMessageBox(mainWindow, opts) : await dialog.showMessageBox(opts);
  if (r.response !== 0) return;
  remoteUntil = Date.now() + 30 * 60 * 1000;
  const st = await proxyRequest('POST', '__proxy/remote', { enabled: true, minutes: 30 });
  if (!st) {
    remoteUntil = 0;
    dialog.showMessageBox({ type: 'error', message: '远程协助开启失败', detail: '本地代理无响应，请查看日志：' + logFile() });
    return;
  }
  remoteNotify('远程协助已开启', '30 分钟内服务器可连接本机，点「帮助 → 远程协助」可提前关闭');
  buildMenu();
}

function ensureRemoteTicker() {
  if (remoteTick) return;
  remoteTick = setInterval(async () => {
    if (remoteUntil && Date.now() >= remoteUntil) {
      remoteUntil = 0;
      await proxyRequest('POST', '__proxy/remote', { enabled: false });
      remoteNotify('远程协助已关闭', '30 分钟已到，服务器无法再连接本机');
      buildMenu();
    } else if (remoteUntil) {
      buildMenu(); // 刷新倒计时
    }
  }, 30000);
  remoteTick.unref?.();
}

/** 「实例」菜单项：每个实例一个单选项，点击切换窗口指向的本地代理 */
function buildInstanceMenuItems() {
  return instances.map((x, i) => ({
    label: `${x.name}（${x.upstream.replace(/^https?:\/\//, '')}）`,
    type: 'radio',
    checked: i === currentInst,
    accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
    click: () => { switchInstance(i).catch(() => {}); },
  }));
}

/** 切换实例：必要时先拉起该实例的本地代理，再让窗口加载它 */
async function switchInstance(i) {
  if (i < 0 || i >= instances.length) return;
  currentInst = i;
  const it = inst(i);
  mainLog(`切换实例：${it.name} ${it.upstream} (本机 :${it.port})`);
  let alive = false;
  try { alive = await proxyAlive(i); } catch {}
  if (!alive) {
    killPortOwner(it.port);
    await new Promise((r) => setTimeout(r, 300));
    startProxy(CONFIG_PATH || ensureConfig(), i);
    const ok = await waitProxy(40000, i);
    if (!ok) {
      dialog.showErrorBox('切换实例失败', `「${it.name}」的本地代理没起来，请查看日志：\n` + logFile());
      return;
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.loadURL(instUrl(i)); } catch {}
    mainWindow.show();
  }
  buildMenu();
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开配置目录',
          click: () => shell.openPath(userDataDir()).catch(() => {}),
        },
        {
          label: '打开日志',
          click: () => shell.openPath(logFile()).catch(() => {}),
        },
        {
          label: '打开安装目录',
          click: () => shell.openPath(installDir()).catch(() => {}),
        },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制刷新（清空页面缓存）', role: 'forceReload' },
        { type: 'separator' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '恢复默认缩放', role: 'resetZoom' },
        { type: 'separator' },
        { label: '开发者工具', role: 'toggleDevTools' },
      ],
    },
    {
      label: '实例',
      submenu: buildInstanceMenuItems(),
    },
    {
      label: '重连',
      click: () => { hardReconnect().catch(() => {}); },
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '检查更新…',
          click: () => {
            if (!updater) {
              dialog.showMessageBox({ type: 'info', message: '更新功能不可用（配置里 update.enabled=false）' });
              return;
            }
            updater.check({ manual: true });
          },
        },
        {
          label: '连接 / 缓存状态…',
          click: () => showProxyStats(),
        },
        {
          label: '更新访问令牌…',
          click: () => showTokenUpdateHelp(),
        },
        {
          label: remoteMenuLabel(),
          click: () => { toggleRemoteAssist().catch(() => {}); },
        },
        {
          label: isElevatedWindows() ? '已以管理员身份运行' : '以管理员身份重启…',
          click: () => restartAsAdmin(),
        },
        {
          label: '创建桌面快捷方式',
          click: () => ensureDesktopShortcut(),
        },
        { type: 'separator' },
        {
          label: '关于 DSH 桌面版',
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              title: '关于',
              message: 'DSH 桌面版（绿色版 · 本地缓存加速）',
              detail: [
                `版本：${app.getVersion()}`,
                `安装目录：${installDir()}`,
                '实例：\n' + instances.map((x, i) => `  ${i === currentInst ? '▶' : ' '} ${x.name}  ${x.upstream}  (本机代理 :${x.port})`).join('\n'),
                '缓存目录：' + path.join(process.env.LOCALAPPDATA || userDataDir(), 'dsh-client', 'cache'),
                '日志：' + logFile(),
                '',
                '绿色版：整个文件夹可以随意挪动；移动后请重新创建桌面快捷方式。',
                '升级：「帮助 → 检查更新」，或启动后自动检测。',
              ].join('\n'),
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------ 生命周期

process.on('uncaughtException', (error) => {
  try { mainLog('未捕获异常（已记录，继续运行）: ' + (error && error.stack ? error.stack : String(error))); } catch {}
});
process.on('unhandledRejection', (reason) => {
  try { mainLog('未处理 Promise 拒绝: ' + String(reason && reason.message ? reason.message : reason)); } catch {}
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.dsh.desktop');

    // 启动阶段先应用「已下载待生效」的小更新包（覆盖 resources/app），然后重启进入新版本
    try {
      const applied = applyPendingUpdate({
        workDir: path.join(process.env.LOCALAPPDATA || userDataDir(), 'dsh-client', 'updater'),
        appPath: app.getAppPath(),
        log: updateLogFile(),
      });
      if (applied.applied) {
        // 先停掉旧代理并释放单实例锁，避免重启后的新实例抢不到锁/端口而直接退出
        stopProxy();
        try {
          app.releaseSingleInstanceLock();
        } catch {}
        await new Promise((r) => setTimeout(r, 600));
        app.relaunch();
        app.exit(0);
        return;
      }
    } catch (error) {
      console.error('应用待生效更新失败', error);
    }

    buildMenu();
    ensureRemoteTicker();
    try {
      migrateSecrets();
      hardenAcl();
    } catch (error) {
      console.error('凭据加密/权限收紧失败', error);
    }
    const cfgPath = ensureConfig();
    CONFIG_PATH = cfgPath;
    loadInstances();   // 多实例：主实例 + rc.2（可在 config.json 的 instances 改）
    // 1.3.4 起安装包不再内置密码：首次运行或密码缺失时弹窗输入
    {
      const rc = runtimeConfig();
      if (!rc.basicPass) {
        const pw = await promptPassword('首次运行，请输入服务器访问密码');
        if (!pw) { app.quit(); return; }
        const cfg = readConfig();
        saveConfig({ ...cfg, basicUser: cfg.basicUser || 'dsh', basicPass: pw });
        mainLog('已保存访问密码（DPAPI 加密）');
      }
    }
    setupTray();
    // 开机自启：默认开启（用户可在托盘菜单关掉；关掉后下次不会自动恢复）
    const bootCfg = readConfig();
    if (bootCfg.autoStart !== false) setAutostart(true);
    const running = await proxyInfo();
    if (running && running.version === app.getVersion()) {
      // 端口上是同版本代理，直接复用
    } else {
      if (running) {
        console.log(`端口上是旧代理 ${running.version}（当前 ${app.getVersion()}），先结束它`);
        killStaleProxy(running.pid);
        await new Promise((r) => setTimeout(r, 800));
      }
      killPortOwner(19390);      // 清掉可能残留的孤儿代理
      await new Promise((r) => setTimeout(r, 300));
      startProxy(cfgPath);
    }
    let ok = await waitProxy(60000);
    if (!ok) {
      // 重试一次：清掉可能占着端口的旧代理再启动
      mainLog('代理首次启动失败，清理端口后重试');
      try {
        const stale = await proxyInfo().catch(() => null);
        if (stale && stale.pid) killStaleProxy(stale.pid);
      } catch {}
      killPortOwner(19390);
      await new Promise((r) => setTimeout(r, 1200));
      stopProxy();
      startProxy(cfgPath);
      ok = await waitProxy(45000);
    }
    if (!ok && await portOpen(19390)) {
      // 端口已经在监听：只是状态接口还没就绪，不算失败
      mainLog('代理端口已监听（状态接口未就绪），按已启动处理');
      ok = true;
    }
    if (!ok) {
      dialog.showErrorBox(
        '本地缓存代理启动失败',
        '请查看日志：\n' + logFile() + '\n\n常见原因：config.json 里的服务器地址/密码不对，或网络不通。\n可点菜单「重连」重试。',
      );
      return;   // 不再直接退出：保留窗口，让用户能点「重连」
    }
    createWindow();
    startNotifyWatcher();
    // 其余实例的本地代理：后台启动，失败不影响主实例
    for (let i = 1; i < instances.length; i++) {
      (async () => {
        const it = inst(i);
        try {
          if (await proxyAlive(i)) { mainLog(`实例「${it.name}」代理已在监听 :${it.port}`); return; }
          killPortOwner(it.port);
          startProxy(CONFIG_PATH || ensureConfig(), i);
          const okExtra = await waitProxy(45000, i);
          mainLog(`实例「${it.name}」代理${okExtra ? '已就绪' : '启动失败'} :${it.port}`);
        } catch (e) {
          mainLog(`实例「${it.name}」启动异常 ${String(e && e.message)}`);
        }
      })();
    }
    // 凭据失效时提示一次
    setInterval(() => {
      proxyInfo().then((stats) => checkAuthState(stats)).catch(() => {});
    }, 15000).unref?.();
    if (process.env.DSH_NOTIFY_TEST === '1') {
      setTimeout(() => notifyTaskDone('测试会话', 75000), 3000);
    }
    // 绿色版首次运行自动建桌面快捷方式（不打扰：只看是否已存在）
    if (process.platform === 'win32') {
      ensureDesktopShortcut({ quiet: true });
      ensureStartMenuShortcut();
    }
    setupUpdater();
  });

  app.on('window-all-closed', () => {
    if (tray) return; // 有托盘时保持后台运行
    app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (checkTimer) clearInterval(checkTimer);
    stopNotifyWatcher();
    stopProxy();
  });
}
