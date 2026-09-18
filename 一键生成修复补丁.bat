@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "NODE=%~dp0runtime\node\node.exe"
if not exist "%NODE%" set "NODE=node"

echo ============================================
echo   Build repair patch (for already-installed users)
echo   Output: dist\Academy...-patch-v..exe
echo ============================================
echo.
echo   This packages ONLY the files changed in git
echo   working tree, so the result is a few MB
echo   instead of the full ~175 MB installer.
echo.

"%NODE%" tools\patch.js %*
if errorlevel 1 goto :failed

echo.
echo   Done. Send the exe in dist\ to your users.
echo.
pause
exit /b 0

:failed
echo.
echo   Patch build FAILED. See the error above.
echo.
pause
exit /b 1
