@echo off
chcp 65001 >nul
setlocal
title 取消文件关联 - Academy 辩论教练
echo 正在移除 .md 文件关联注册...
reg delete "HKCU\Software\Classes\AcademyMD.md" /f >nul 2>&1
reg delete "HKCU\Software\Classes\AcademyMD.txt" /f >nul 2>&1
reg delete "HKCU\Software\Classes\AcademyMD.srt" /f >nul 2>&1
reg delete "HKCU\Software\Classes\.md\OpenWithProgids" /v "AcademyMD.md" /f >nul 2>&1
reg delete "HKCU\Software\Classes\.markdown\OpenWithProgids" /v "AcademyMD.md" /f >nul 2>&1
echo 已移除。.md 将恢复系统默认打开方式。
rem 有缘重捡默认：若 .md 默认仍是 AcademyMD.md 清理残留
reg delete "HKCU\Software\Classes\.md" /ve /f >nul 2>&1
pause >nul
exit /b 0