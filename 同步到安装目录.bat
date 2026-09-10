@echo off
chcp 65001 >nul
setlocal
title 同步前端代码到安装目录

set "DEV=%~dp0app"
set "INST=%LOCALAPPDATA%\AcademyDebateCoach\app"

if not exist "%INST%\server.js" (
  echo [错误] 未找到安装目录: %INST%
  echo 请确认是用 setup.bat 安装的。
  pause
  exit /b 1
)

echo 正在把开发目录的最新代码同步到安装目录（整目录覆盖）...
echo   源: %DEV%
echo   目标: %INST%
echo.

rem /PURGE 保证删除目标里已不存在于源的旧文件（如已改名的模块）
robocopy "%DEV%" "%INST%" /E /PURGE /NFL /NDL /NJH /NJS /NP
if errorlevel 8 (
  echo [错误] 同步失败，robocopy 返回 %errorlevel%
  pause
  exit /b 1
)

echo.
echo 同步完成！请先关闭正在运行的 App，再重新打开。
echo （data 目录未动：你的 API Key、记忆、会话、资料库都保留）
pause