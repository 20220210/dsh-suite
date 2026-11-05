# DSH 多端套件（手机页 + Windows 客户端 + 反代配置）

一套围绕 [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) 的多端访问方案：

- **手机端 PWA**：为 iPhone/Android 优化的移动界面（会话列表、流式对话、模型切换、图片/文件发送、排队/插话、审批卡片）
- **Windows 客户端**：绿色免安装的桌面壳（本地代理 + 自动更新 + 任务完成通知）
- **服务端**：Nginx 反向代理 + 自签证书 + BasicAuth + DSH token 桥接

> 本仓库只包含代码与配置模板。域名、密码、API Key、token、IP 等一律用 `__XXX__` 占位符替代，部署时自行替换。

## 架构

```
手机 PWA  ─┐
电脑浏览器 ├──► Nginx (HTTPS, BasicAuth) ──► DSH (127.0.0.1:3080)
Windows   ┘        ├─ /    → 官方 DSH 界面
                   └─ /m/  → 本仓库手机页
```

同一个 DSH 实例、同一份会话数据。手机和电脑只是两个显示界面。

## 目录

| 目录 | 内容 |
|---|---|
| `mobile/` | 手机端 PWA 源码（纯静态，无构建步骤） |
| `client/` | Windows 客户端源码（Electron 主进程 + 本地代理） |
| `server/nginx/` | Nginx 站点配置模板 |
| `server/token-bridge.py` | 把 DSH 一次性 token 转成长期 cookie 的小服务 |
| `server/scripts/` | 部署脚本 |
| `docs/` | 使用说明 |

## 快速开始（服务端）

1. 安装并启动 DSH：`dsh web --host 127.0.0.1 --port 3080 --no-open`
2. 生成本地 secret 与密码：
   ```bash
   openssl rand -hex 32 > /root/.dsh/bridge-secret && chmod 600 /root/.dsh/bridge-secret
   htpasswd -c /etc/nginx/dsh-gui.htpasswd __USER__
   ```
3. 复制 `server/nginx/dsh-gui.conf.example`，把 `dsh.example.com`、证书路径、密码文件路径改成自己的
4. 启动 bridge：`python3 server/token-bridge.py`（建议 systemd 托管）
5. 把 `mobile/` 下的文件放到 `/var/www/dsh-mobile/`
6. `nginx -t && systemctl reload nginx`

## 快速开始（手机端）

打开 `https://<你的域名>/m/`：

- 首次需要输入 HTTP BasicAuth 密码（之后长期 cookie 免登录）
- Safari 分享 → 添加到主屏幕，可当 App 用
- 右上角显示版本号；下拉列表可刷新并自动检测更新

## 快速开始（Windows 客户端）

见 `client/default-config.example.json`，改三处：

- `upstream`：你的域名（如 `https://dsh.example.com`）
- `basicUser` / `basicPass`：BasicAuth 账号密码
- `update.manifests`：版本清单地址（可留空关闭自动更新）

## 安全注意事项

- **不要**把真实配置提交进仓库；`client/default-config.json` 已在 `.gitignore` 中
- BasicAuth 密码、relay 密钥、DSH token 都不要写进代码或文档
- 建议只在内网或自己的服务器上开放，端口不要暴露到公网无鉴权

## 已知限制

- iOS 键盘上方的表单辅助栏（上一项/下一项/完成）由系统绘制，**网页无法隐藏**，只有原生 WKWebView 壳能去掉
- 自签证书需要在每台设备上手动信任一次
