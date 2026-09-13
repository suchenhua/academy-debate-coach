@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title Academy 辩论教练 - 卸载

rem 卸载目录 = 本脚本所在目录。这样不管用户当初装到哪（自定义路径也认），
rem 都能删对地方 —— 早先这里写死 %LOCALAPPDATA%\AcademyDebateCoach，
rem 一旦支持自选安装位置就会卸错目录。
set "DEST=%~dp0"
if "!DEST:~-1!"=="\" set "DEST=!DEST:~0,-1!"

echo ============================================================
echo    Academy 辩论教练 - 卸载
echo ============================================================
echo.
echo 安装位置：!DEST!
echo.
echo 将执行：
echo   1. 停止正在运行的辩论教练
echo   2. 【自动备份】把你的数据打包保存到桌面
echo   3. 删除桌面和开始菜单快捷方式
echo   4. 删除上面的安装目录
echo.
echo   注意：对话记录、API Key、个人资料库都在安装目录内，
echo        卸载会一并删除 —— 但会先自动备份，不用担心。
echo.
choice /C YN /N /M "确定卸载吗？[Y=卸载，N=取消]"
if errorlevel 2 exit /b 0

echo.
echo [1/4] 停止程序...
rem 既按默认目录名匹配，也按「当前实际安装目录」匹配 —— 用户自选/改名安装时
rem 只有后者能命中，否则文件被占用，最后一步 rmdir 会失败。
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $dest='!DEST!'; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*AcademyDebateCoach*' -or $_.CommandLine -like ('*' + $dest + '*')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $dest='!DEST!'; Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -like '*AcademyDebateCoach*' -or $_.Path -like ($dest + '*')) } | ForEach-Object { Stop-Process -Id $_.Id -Force }" >nul 2>&1
rem 给系统一点时间释放文件句柄，否则紧接着的 rmdir 可能删不干净
powershell -NoProfile -Command "Start-Sleep -Milliseconds 1500" >nul 2>&1

echo [2/4] 正在备份你的数据...
set "BAKDIR=%USERPROFILE%\Desktop\Academy辩论教练-数据备份"
if not exist "%BAKDIR%" mkdir "%BAKDIR%" >nul 2>&1

rem 只备份用户数据，不备份几百 MB 的程序文件和浏览器缓存
set "BAKNAME=Academy数据_%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%_%TIME:~0,2%%TIME:~3,2%.zip"
set "BAKNAME=%BAKNAME: =0%"
set "BAKZIP=%BAKDIR%\%BAKNAME%"

if exist "%DEST%\data" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $src='!DEST!\data'; $dst='%BAKZIP%'; $tmp=Join-Path $env:TEMP ('acabak_' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $tmp -Force | Out-Null; Copy-Item -LiteralPath $src -Destination (Join-Path $tmp 'data') -Recurse -Force -ErrorAction Stop; $inner=Join-Path $tmp 'data'; foreach ($j in @('electron-user-data','electron-user-data-reader','edge-profile')) { Remove-Item -LiteralPath (Join-Path $inner $j) -Recurse -Force -ErrorAction SilentlyContinue }; if (Test-Path $dst) { Remove-Item $dst -Force }; Compress-Archive -LiteralPath $inner -DestinationPath $dst -CompressionLevel Optimal -ErrorAction Stop; Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue; Write-Output 'BACKUP_OK'" 2>&1 | findstr BACKUP_OK >nul
  if exist "%BAKZIP%" (
    echo     OK 数据已备份到：
    echo       %BAKZIP%
  ) else (
    echo     ! 备份未成功生成，为安全起见已中止卸载。
    echo       请手动复制以下目录后再重试：
    echo       %DEST%\data
    echo.
    pause
    exit /b 1
  )
) else (
  echo     未找到数据目录，跳过备份。
)

echo [3/4] 删除快捷方式...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $d=[Environment]::GetFolderPath('Desktop'); Remove-Item -LiteralPath (Join-Path $d 'Academy辩论教练.lnk') -Force; $p=[Environment]::GetFolderPath('Programs'); Remove-Item -LiteralPath (Join-Path $p 'Academy辩论教练') -Recurse -Force" >nul 2>&1

echo [4/4] 删除安装目录...
cd /d "%USERPROFILE%"
rmdir /s /q "%DEST%" 2>nul
if exist "%DEST%" (
  echo    部分文件被占用，将稍后自动清理。
  powershell -NoProfile -Command "Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 3; Remove-Item -LiteralPath \"%DEST%\" -Recurse -Force' -WindowStyle Hidden" >nul 2>&1
)

echo.
echo ============================================================
echo   卸载完成
echo.
echo   你的数据备份保存在：
echo     %BAKZIP%
echo.
echo   重装后可把备份里的 data 文件夹放回安装目录恢复记录。
echo.
echo   小提醒：备份 zip 里有你的 API Key，请妥善保管；
echo          如果不再重装，确认数据已另存后可以把这个 zip 删掉。
echo ============================================================
echo.
echo （按任意键关闭，将打开备份所在文件夹）
pause >nul
if exist "%BAKDIR%" start "" "%BAKDIR%"
exit /b 0
