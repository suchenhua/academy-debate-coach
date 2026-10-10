@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title Academy 辩论教练 - 安装

rem ============================================================
rem  用法（两种都支持）：
rem    1) 双击直接运行            -> 装到默认位置 %LOCALAPPDATA%\AcademyDebateCoach，两个快捷方式都建
rem    2) 由安装向导调用：
rem       setup.bat <目标目录> [desktop] [menu]
rem       后两个开关可选，给了才建对应快捷方式
rem ============================================================

set "SRC=%~dp0"
set "DEST=%~1"

rem 未传目标目录时用默认位置（保持双击 setup.bat / 一键安装.bat 的旧行为）
if not defined DEST set "DEST=%LOCALAPPDATA%\AcademyDebateCoach"

rem 快捷方式开关。用 %~2 / %~3 位置参数而不是 for %%A in (%*)：
rem 后者会把带空格的路径拆成多段，导致「D:\My Programs」被解析错。
rem 哨兵值 "-1" = 调用方没表态（裸跑 setup.bat），此时默认两个都建；
rem 显式给 "0" 表示用户主动取消勾选，必须尊重，不能当成没表态。
set "WANT_DESKTOP=-1"
set "WANT_MENU=-1"
set "A2=%~2"
set "A3=%~3"
if /I "%A2%"=="desktop" set "WANT_DESKTOP=1"
if /I "%A2%"=="nodesktop" set "WANT_DESKTOP=0"
if /I "%A2%"=="menu" set "WANT_MENU=1"
if /I "%A2%"=="nomenu" set "WANT_MENU=0"
if /I "%A3%"=="menu" set "WANT_MENU=1"
if /I "%A3%"=="nomenu" set "WANT_MENU=0"
if /I "%A3%"=="nodesktop" set "WANT_DESKTOP=0"
if "!WANT_DESKTOP!"=="-1" set "WANT_DESKTOP=1"
if "!WANT_MENU!"=="-1" set "WANT_MENU=1"

if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"
if "%DEST:~-1%"=="\" set "DEST=%DEST:~0,-1%"

echo ============================================================
echo    Academy 辩论教练  -  安装
echo.
echo    安装位置: %DEST%
echo ============================================================
echo.

echo [1/4] 正在关闭旧版本（如有）...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*AcademyDebateCoach*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*AcademyDebateCoach*' } | ForEach-Object { Stop-Process -Id $_.Id -Force }" >nul 2>&1

if /I "!SRC!"=="!DEST!" (
  echo [2/4] 已位于安装目录，跳过文件复制。
) else (
  echo [2/4] 正在复制程序文件，请稍候（大约 1~3 分钟）...

  rem ============================================================
  rem  升级保护 1/2：先把旧的内核 / 运行时目录整体删掉再铺
  rem    robocopy /E 只覆盖同名文件、**不会删除**目标里多出来的文件。
  rem    换 DSH 内核时，旧内核里被删掉或改名的 @deepseek-ai/dsh-* 包
  rem    会残留在目标目录 → 新旧内核混树（最难排查的一类故障）。
  rem    这三个目录只装程序文件、不含任何用户数据，可以安全整体删除。
  rem    只在源包里确实带了该目录时才删（避免精简包把运行时删没了）。
  rem ============================================================
  if exist "!SRC!\runtime\dsh"      if exist "!DEST!\runtime\dsh"      rmdir /s /q "!DEST!\runtime\dsh"
  if exist "!SRC!\runtime\node"     if exist "!DEST!\runtime\node"     rmdir /s /q "!DEST!\runtime\node"
  if exist "!SRC!\runtime\electron" if exist "!DEST!\runtime\electron" rmdir /s /q "!DEST!\runtime\electron"

  rem ============================================================
  rem  升级保护 2/2：data/ 是用户数据（对话记录 / 资料库 / 记忆 / Key / 技能），
  rem    安装只允许「不碰」，绝不允许删除。这里先记住它在不在，装完必须还在。
  rem    将来若有人给 robocopy 加上 /PURGE，下面这行会立刻拦住 —— 而不是
  rem    静默把用户几年的资料清空。
  rem ============================================================
  set "HAD_DATA=0"
  if exist "!DEST!\data" set "HAD_DATA=1"

  rem /XD 必须给完整路径：按目录名匹配会把 runtime\electron\dist 和 dsh 里所有 dist\ 一起排除掉
  robocopy "!SRC!" "!DEST!" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /XD "!SRC!\data" "!SRC!\dist" "!SRC!\build" "!SRC!\.git" "!SRC!\.backup" >nul
  set "RC=!ERRORLEVEL!"
  if !RC! GEQ 8 (
    echo.
    echo 安装失败：复制文件出错（错误码 !RC!）。
    echo 建议关闭杀毒软件后重新运行安装程序。
    exit /b 1
  )
  if "!HAD_DATA!"=="1" if not exist "!DEST!\data" (
    echo.
    echo 严重错误：用户数据目录 data 不见了，安装已中止。
    echo 请先备份原 data 目录再联系维护者，不要继续使用本目录。
    exit /b 1
  )
)

echo [3/4] 正在创建快捷方式...
rem install-shortcuts.ps1 只有「跳过」开关（-NoDesktop/-NoMenu）；
rem 要建就什么都不传 —— 别传 -Desktop/-Menu，那对参数不存在会报错。
set "SC_ARGS=-InstallDir ""!DEST!"""
if not "!WANT_DESKTOP!"=="1" set "SC_ARGS=!SC_ARGS! -NoDesktop"
if not "!WANT_MENU!"=="1" set "SC_ARGS=!SC_ARGS! -NoMenu"
powershell -NoProfile -ExecutionPolicy Bypass -File "!DEST!\install-shortcuts.ps1" !SC_ARGS!
if errorlevel 1 (
  echo 快捷方式创建失败（不影响使用，可稍后手动双击安装目录里的 launch.vbs）
)

echo [4/4] 正在启动 Academy 辩论教练...
wscript.exe "!DEST!\launch.vbs"

echo.
echo ============================================================
echo    安装完成！
echo.
echo    安装位置：!DEST!
echo    以后使用：双击桌面上的「Academy辩论教练」图标（若未创建，用开始菜单）
echo ============================================================
echo.
timeout /t 3 >nul
exit /b 0
