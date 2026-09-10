# install-shortcuts.ps1 - 创建桌面/开始菜单快捷方式（指向 Electron 桌面窗口）
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallDir
)

$ErrorActionPreference = 'Stop'

$electron = Join-Path $InstallDir 'runtime\electron\dist\electron.exe'
$main     = Join-Path $InstallDir 'app\electron-main.js'

if (-not (Test-Path $electron)) {
    Write-Warning "Electron runtime not found at: $electron"
    exit 1
}

function New-AcademyLink {
    param([string]$LinkPath, [string]$LinkName)

    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $LinkPath ($LinkName + '.lnk')))
    $shortcut.TargetPath = $electron
    $shortcut.Arguments = '"' + $main + '"'
    $shortcut.WorkingDirectory = $InstallDir
    $shortcut.IconLocation = (Join-Path $InstallDir 'appicon.ico')
    $shortcut.Description = '逻敏 · Academy 辩论教练（独立桌面窗口）'
    $shortcut.Save()
    Write-Output "  OK created: $LinkName.lnk"
}

Write-Output "== 创建 Academy 辩论教练快捷方式 =="

# 桌面
$desktop = [Environment]::GetFolderPath('Desktop')
if ($desktop) { New-AcademyLink -LinkPath $desktop -LinkName 'Academy辩论教练' }

# 开始菜单
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Academy辩论教练'
try {
    New-Item -ItemType Directory -Path $startMenu -Force -ErrorAction SilentlyContinue | Out-Null
    New-AcademyLink -LinkPath $startMenu -LinkName 'Academy辩论教练'
} catch {
    Write-Warning "开始菜单快捷方式创建失败（不影响桌面快捷方式）"
}

Write-Output "== 完成 =="
