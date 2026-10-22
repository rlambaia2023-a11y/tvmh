# Setup da TV Livre MH no PC
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path "C:\tvlivreMH\dados" | Out-Null
New-Item -ItemType Directory -Force -Path "C:\tvlivreMH\logs" | Out-Null
Write-Output "dirs ok"
$bun = "$env:USERPROFILE\.bun\bin\bun.exe"
if (Test-Path $bun) {
  Write-Output "bun ja instalado"
} else {
  Write-Output "instalando bun..."
  irm bun.sh/install.ps1 | iex
  Write-Output "bun instalado"
}
& $bun --version
Write-Output "setup concluido"
