@echo off
chcp 65001 >nul
setlocal
title Academy Debate Coach
cd /d "%~dp0"

set "ELECTRON=%~dp0runtime\electron\dist\electron.exe"
set "MAIN=%~dp0app\electron-main.js"

if not exist "%ELECTRON%" (
  echo [ERROR] Electron runtime not found. Please reinstall the app.
  pause >nul
  exit /b 1
)

echo ============================================
echo   Academy 辩论教练 - 正在启动桌面窗口...
echo   请在弹出的「逻敏 · Academy 辩论教练」窗口中使用
echo   关闭窗口 = 退出程序
echo ============================================

start "" "%ELECTRON%" "%MAIN%"

echo.
echo 程序已启动。关闭桌面窗口即可退出。
timeout /t 2 >nul
exit /b 0
