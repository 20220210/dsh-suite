@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist agent.pid (
  for /f %%p in (agent.pid) do taskkill /F /PID %%p /T >nul 2>&1
  del agent.pid >nul 2>&1
  echo 已停止 DSH 远程协助。
) else (
  echo 没有找到 agent.pid，尝试按命令行结束…
  taskkill /F /FI "WINDOWTITLE eq DSH 远程协助*" >nul 2>&1
  echo 完成。
)
timeout /t 2 >nul
