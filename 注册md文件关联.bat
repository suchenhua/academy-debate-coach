@echo off
chcp 65001 >nul
setlocal
title 注册 Markdown 文件关联 - Academy 辩论教练
cd /d "%~dp0"

set "ELECTRON=%~dp0runtime\electron\dist\electron.exe"
set "READER=%~dp0app\md-reader-window.js"

if not exist "%ELECTRON%" (
  echo [错误] 找不到 Electron 运行时：%ELECTRON%
  echo 请确认从完整安装目录运行本脚本。
  pause >nul
  exit /b 1
)

echo ============================================
echo   正在把 .md / .txt / .srt 关联到
echo   「Academy 辩论教练」内置轻量阅读器（独立小窗）
echo ============================================
echo.

rem 注意：%%1 必须带引号，否则路径含空格时会被拆成多个参数
set "OPENCMD="%ELECTRON%" "%READER%" --md "%%1""

reg add "HKCU\Software\Classes\.md" /ve /t REG_SZ /d "AcademyMD.md" /f >nul
reg add "HKCU\Software\Classes\.md\OpenWithProgids" /v "AcademyMD.md" /t REG_SZ /d "" /f >nul
reg add "HKCU\Software\Classes\.markdown" /ve /t REG_SZ /d "AcademyMD.md" /f >nul
reg add "HKCU\Software\Classes\.markdown\OpenWithProgids" /v "AcademyMD.md" /t REG_SZ /d "" /f >nul
reg add "HKCU\Software\Classes\AcademyMD.md" /ve /t REG_SZ /d "Academy MD Document" /f >nul
reg add "HKCU\Software\Classes\AcademyMD.md\DefaultIcon" /ve /t REG_SZ /d "%~dp0appicon.ico" /f >nul
reg add "HKCU\Software\Classes\AcademyMD.md\shell\open\command" /ve /t REG_SZ /d "%OPENCMD%" /f >nul

echo.
echo  关联成功！现在双击 .md 会直接打开轻量阅读窗。
echo  想看深加工：在阅读窗点「在 Academy 接着做」即可。
echo.
echo  （若想恢复默认，运行 取消md文件关联.bat）
echo.
pause >nul
exit /b 0