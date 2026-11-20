#!/usr/bin/env python3
"""把仓库里同步进来的“真实部署信息”替换成安全占位值（公开仓库用）。

用法（在仓库根目录）：python3 scripts/sanitize-repo.py
变更后请 git diff 检查再提交。真实部署文件不在本仓库，不受影响。
"""
import re
import subprocess
import sys

REPLACEMENTS = [
    # 域名 / IP
    (r'tnty\.9017i\.cc', 'dsh.example.com'),
    (r'\b10\.0\.1\.(\d{1,3})\b', r'192.168.1.\1'),
    (r'\b1\.199\.75\.\d{1,3}\b', '203.0.113.20'),
    # 机器名
    (r'dsh-pc-a|dsh-pc-a|dsh-pc-a', 'dsh-pc-a'),
    (r'dsh-pc-b', 'dsh-pc-b'),
    # 凭据
    (r'__OLD_PASSWORD__', '__OLD_PASSWORD__'),
    # 服务器路径（长的先换）
    ('/opt/dsh/client', '/opt/dsh/client'),
    ('/opt/dsh/mobile-web', '/opt/dsh/mobile-web'),
    ('/opt/dsh/suite', '/opt/dsh/suite'),
    ('/opt/dsh/handover', '/opt/dsh/handover'),
    ('/opt/dsh/api', '/opt/dsh/api'),
    ('/opt/dsh/rc2-host', '/opt/dsh/rc2-host'),
    ('/opt/dsh/session-cache', '/opt/dsh/session-cache'),
    ('/opt/dsh/push-service', '/opt/dsh/push-service'),
    ('/opt/dsh/token-bridge.py', '/opt/dsh/token-bridge.py'),
    ('/opt/dsh/rc2-token-bridge.py', '/opt/dsh/rc2-token-bridge.py'),
    ('/opt/dsh/deepseek', '/opt/dsh/deepseek'),
    ('/opt/dsh/mcp-src', '/opt/dsh/mcp-src'),
    (r'/opt/dsh/\.ssh/([\w.-]+)', r'/home/user/.ssh/\1'),
    (r'/opt/dsh/([\w.-]+)', r'/opt/dsh/\1'),
    # 用户名
    (r'\bchang\b', 'user'),
    (r'\bckx\b', 'user'),
]


def tracked_files():
    # -z：避免中文路径被 git 转义成 "\346\213..."，否则 open() 会静默失败漏掉文件
    out = subprocess.run(['git', 'ls-files', '-z'], capture_output=True, text=True, check=True).stdout
    return [p for p in out.split('\0') if p]


def main():
    changed = 0
    for path in tracked_files():
        if path == 'scripts/sanitize-repo.py':
            continue
        try:
            text = open(path, encoding='utf-8').read()
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
        original = text
        for pat, rep in REPLACEMENTS:
            text = re.sub(pat, rep, text)
        if text != original:
            open(path, 'w', encoding='utf-8').write(text)
            changed += 1
    print(f'脱敏完成：{changed} 个文件被修改')
    return 0


if __name__ == '__main__':
    sys.exit(main())
