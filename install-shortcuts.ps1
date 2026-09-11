# install-shortcuts.ps1 - 创建桌面/开始菜单快捷方式（指向 Electron 桌面窗口）
#
# 开关（都可选，默认都建，保持老调用方兼容）：
#   -NoDesktop   不在桌面建快捷方式
#   -NoMenu      不在开始菜单建快捷方式
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallDir,
    [switch]$Desktop,
    [switch]$Menu,
    [switch]$NoDesktop,
    [switch]$NoMenu
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

# 桌面（除非明确要求跳过）
if ($NoDesktop) {
    Write-Output '  skip: 桌面快捷方式（按用户选择跳过）'
} else {
    $desktop = [Environment]::GetFolderPath('Desktop')
    if ($desktop) { New-AcademyLink -LinkPath $desktop -LinkName 'Academy辩论教练' }
}

# 开始菜单（除非明确要求跳过）
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Academy辩论教练'
if ($NoMenu) {
    Write-Output '  skip: 开始菜单快捷方式（按用户选择跳过）'
} else {
    try {
        New-Item -ItemType Directory -Path $startMenu -Force -ErrorAction SilentlyContinue | Out-Null
        New-AcademyLink -LinkPath $startMenu -LinkName 'Academy辩论教练'
    } catch {
        Write-Warning "开始菜单快捷方式创建失败（不影响桌面快捷方式）"
    }

    # 开始菜单「卸载」入口：指向安装目录里的 uninstall.bat（卸载前会自动备份用户数据到桌面）
    $uninstallBat = Join-Path $InstallDir 'uninstall.bat'
    if (Test-Path $uninstallBat) {
        try {
            $ulink = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startMenu '卸载 Academy辩论教练.lnk'))
            $ulink.TargetPath = $uninstallBat
            $ulink.WorkingDirectory = $InstallDir
            $ulink.IconLocation = (Join-Path $InstallDir 'appicon.ico')
            $ulink.Description = '卸载 Academy 辩论教练（会先自动备份你的数据到桌面）'
            $ulink.Save()
            Write-Output "  OK created: 卸载 Academy辩论教练.lnk"
        } catch {
            Write-Warning "卸载快捷方式创建失败（可手动运行安装目录里的 uninstall.bat）"
        }
    } else {
        Write-Warning "未找到 uninstall.bat，跳过卸载快捷方式"
    }
}

Write-Output "== 完成 =="
