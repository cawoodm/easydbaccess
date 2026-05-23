[CmdletBinding()]param(
  [switch]$Installer  # also build the NSIS installer (electron-builder)
)
function main() {
  $SrcDir = $PSScriptRoot
  Push-Location $SrcDir

  # 1. Build shared + server (electron pulls them as workspace deps)
  npm run build --workspace @easydb/shared
  if ($LASTEXITCODE -ne 0) { throw "shared build failed" }
  npm run build --workspace @easydb/server
  if ($LASTEXITCODE -ne 0) { throw "server build failed" }

  # 2. Build renderer with relative base so assets resolve under file://
  Push-Location packages\renderer
  npx vite build --base ./
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "renderer build failed" }
  Pop-Location

  # 3. Build electron main + preload (tsc)
  npm run build --workspace @easydb/electron
  if ($LASTEXITCODE -ne 0) { throw "electron tsc failed" }

  Write-Host "***************************************************" -ForegroundColor Cyan
  Write-Host " Electron build complete. To run:" -ForegroundColor Cyan
  Write-Host "   npm run start:electron" -ForegroundColor Cyan
  Write-Host "***************************************************" -ForegroundColor Cyan

  if ($Installer) {
    # 4. Package with electron-builder (NSIS on Windows)
    # NOTE: known friction with npm workspaces — electron-builder runs
    #   `npm install --omit=dev` inside packages/electron which prunes
    #   hoisted devDeps and trips Windows file locks. Run -Installer only
    #   when you're prepared to `npm install` afterwards to restore.
    npm run package --workspace @easydb/electron
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }

    $output = Join-Path $SrcDir "packages\electron\dist-installer"
    Write-Host "***************************************************" -ForegroundColor Cyan
    Write-Host " Installer built at:" -ForegroundColor Cyan
    Write-Host "   $output" -ForegroundColor Cyan
    Write-Host "***************************************************" -ForegroundColor Cyan
  }

  Pop-Location
}
$ErrorActionPreference = "Stop"
main
