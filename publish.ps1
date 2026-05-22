[CmdletBinding()]param()
function main() {
  $SrcDir = $PSScriptRoot
  $targetDir = "C:\projects\Marc\cawoodm.github.io\easydbaccess"

  Push-Location $SrcDir
  $ver = (Get-Content -Raw .\package.json | ConvertFrom-Json).version
  $msg = (git log -1 --pretty=%s).Trim()

  Push-Location packages\renderer
  npx vite build --base /easydbaccess/
  if ($LASTEXITCODE -ne 0) { Pop-Location; Pop-Location; throw "vite build failed" }
  Pop-Location

  if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir | Out-Null }
  Copy-Item packages\renderer\dist\* $targetDir -Force -Recurse
  if (Test-Path .\README.md) { Copy-Item .\README.md $targetDir -Force }

  Push-Location $targetDir
  Write-Host "***************************************************" -ForegroundColor Cyan
  Write-Host "                v$($ver): $msg" -ForegroundColor Cyan
  Write-Host "***************************************************" -ForegroundColor Cyan
  git add . && git commit -m "easyDBAccess App $($ver): $msg" && git push
  Pop-Location

  Pop-Location
}
$ErrorActionPreference = "Stop"
main
