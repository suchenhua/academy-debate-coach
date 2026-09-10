# 📄 本知识库由 QFUD（驻青四校联合辩论培训计划）整理发布，
# 采用 知识共享署名-非商业性使用-相同方式共享 4.0 国际 (CC BY-NC-SA 4.0) 许可。
# 详情：https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh

# 辩手风格切换脚本
# 用法: .\switch-persona.ps1 -Persona "丁冠羽" [-TargetPath "..\..\SOUL.md"]
# 将指定辩手的人设文件复制为当前 Agent 的 SOUL.md

param(
    [Parameter(Mandatory=$true)]
    [string]$Persona,

    [string]$TargetPath = "$PSScriptRoot\..\..\..\SOUL.md"
)

$personaFile = "$PSScriptRoot\..\personas\$Persona.md"

if (-not (Test-Path $personaFile)) {
    $available = Get-ChildItem "$PSScriptRoot\..\personas" -Filter "*.md" | Where-Object { $_.Name -ne "_template.md" } | ForEach-Object { $_.BaseName }
    Write-Error "人设文件不存在: $Persona"
    Write-Host "可用风格: $($available -join ', ')"
    exit 1
}

# 备份当前 SOUL.md
$backupPath = "$PSScriptRoot\..\..\..\SOUL.backup.md"
if (Test-Path $TargetPath) {
    Copy-Item $TargetPath $backupPath -Force
    Write-Host "已备份当前 SOUL.md → SOUL.backup.md"
}

# 复制人设文件
$personaContent = Get-Content $personaFile -Raw

# 包装为 SOUL.md 格式
$soulContent = @"
# SOUL.md

$personaContent
"@

Set-Content $TargetPath $soulContent -Encoding UTF8
Write-Host "已切换风格: $Persona"
Write-Host "目标文件: $TargetPath"
Write-Host "恢复原人设: .\switch-persona.ps1 -Persona default (需手动恢复)"
