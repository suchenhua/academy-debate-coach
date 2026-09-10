@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "NODE=%~dp0runtime\node\node.exe"
if not exist "%NODE%" set "NODE=node"

echo ============================================
echo   Build distributable zip for Academy
echo   Step 1/2: dist\Academy-Bianlun-Coach-portable.zip
echo ============================================

"%NODE%" tools\pack.js
if errorlevel 1 goto :failed

echo ============================================
echo   Step 2/2: Academy辩论教练-安装版.exe
echo ============================================
"%NODE%" tools\build-installer.js
if errorlevel 1 goto :failed

echo.
echo   全部完成：
echo     dist\Academy-Bianlun-Coach-portable.zip
echo     dist\Academy辩论教练-安装版.exe
echo.
pause
exit /b 0

:failed
echo.
echo 打包失败，请查看上方错误信息。
echo.
pause
exit /b 1
