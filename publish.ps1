[CmdletBinding()]param(
  # Deployment slot under the GitHub Pages repo. Drives BOTH the Vite base path
  # (/$Target/) and the destination folder, so a branch preview publishes next
  # to the main deploy. Default = "easydbaccess" (the production deploy). Use a
  # suffix like "easydbaccess3" to publish the current branch as a preview at
  #   https://cawoodm.github.io/easydbaccess3/
  # e.g.  npm run publish -- -Target easydbaccess3
  [string]$Target = "easydbaccess"
)
function main() {
  # Guard: $Target names a single folder — never empty and never a path (an
  # empty or "../" value would clear the WRONG directory below).
  if ($Target -notmatch '^[A-Za-z0-9._-]+$') {
    throw "Invalid -Target '$Target' (letters, digits, dot, dash, underscore only)"
  }

  $SrcDir = $PSScriptRoot
  $pagesRepo = "C:\projects\Marc\cawoodm.github.io"
  $targetDir = Join-Path $pagesRepo $Target

  Push-Location $SrcDir
  $ver = (Get-Content -Raw .\package.json | ConvertFrom-Json).version
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  $msg = (git log -1 --pretty=%s).Trim()

  Push-Location packages\renderer
  npx vite build --base "/$Target/"
  if ($LASTEXITCODE -ne 0) { Pop-Location; Pop-Location; throw "vite build failed" }
  Pop-Location

  if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir | Out-Null }
  # Clear the slot first so renamed/removed build artefacts (hashed asset names)
  # don't accumulate across publishes, then drop in the fresh build.
  Get-ChildItem -Path $targetDir -Force | Remove-Item -Recurse -Force
  Copy-Item packages\renderer\dist\* $targetDir -Force -Recurse
  if (Test-Path .\README.md) { Copy-Item .\README.md $targetDir -Force }

  Push-Location $targetDir
  Write-Host "***************************************************" -ForegroundColor Cyan
  Write-Host "        $Target v$($ver) [$branch]: $msg" -ForegroundColor Cyan
  Write-Host "***************************************************" -ForegroundColor Cyan
  git add . && git commit -m "easyDBAccess $Target $($ver) [$branch]: $msg" && git push
  Pop-Location

  Pop-Location
}
$ErrorActionPreference = "Stop"
main
