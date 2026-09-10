@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title Academy 辩论教练 - 一键安装

set "SRC=%~dp0"
set "DEST=%LOCALAPPDATA%\AcademyDebateCoach"

if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"
if "%DEST:~-1%"=="\" set "DEST=%DEST:~0,-1%"

echo ============================================================
echo    Academy 辩论教练  -  一键安装
echo.
echo    安装位置: %DEST%
echo ============================================================
echo.

echo [1/4] 正在关闭旧版本（如有）...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*AcademyDebateCoach*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1

if /I "!SRC!"=="!DEST!" (
  echo [2/4] 已位于安装目录，跳过文件复制。
) else (
  echo [2/4] 正在复制程序文件，请稍候（大约 1~3 分钟）...
  rem /XD 必须给完整路径：按目录名匹配会把 runtime\electron\dist 和 dsh 里所有 dist\ 一起排除掉
robocopy "!SRC!" "!DEST!" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /XD "!SRC!\data" "!SRC!\dist" "!SRC!\build" "!SRC!\.git" "!SRC!\.backup" >nul
  set "RC=!ERRORLEVEL!"
  if !RC! GEQ 8 (
    echo.
    echo 安装失败：复制文件出错（错误码 !RC!）。
    echo 建议关闭杀毒软件后重新运行安装程序。
    exit /b 1
  )
)

echo [3/4] 正在创建桌面和开始菜单快捷方式...
powershell -NoProfile -ExecutionPolicy Bypass -File "!DEST!\install-shortcuts.ps1" -InstallDir "!DEST!"
if errorlevel 1 (
  echo 快捷方式创建失败（不影响使用，可稍后手动双击安装目录里的 launch.vbs）
)

echo [4/4] 正在启动 Academy 辩论教练...
wscript.exe "!DEST!\launch.vbs"

echo.
echo ============================================================
echo    安装完成！桌面窗口将自动打开（独立 App 窗口）。
echo.
echo    以后使用：双击桌面上的「Academy辩论教练」图标即可。
echo ============================================================
echo.
timeout /t 3 >nul
exit /b 0