@echo off
chcp 65001 >nul
cd /d "%~dp0"
title DSH 远程协助（关闭窗口=断开连接）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0agent.ps1"
pause
