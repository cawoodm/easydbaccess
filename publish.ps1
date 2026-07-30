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

  # GitHub Pages serves only master of the Pages repo, whatever branch we publish
  # FROM. Switch back if a previous run left it elsewhere — a detached HEAD (from
  # a conflicted pull) reports as "HEAD", and a commit on it would look
  # successful but publish nothing. Done before the build so a failure here does
  # not clear the slot first.
  $pagesBranch = (git -C $pagesRepo rev-parse --abbrev-ref HEAD).Trim()
  if ($pagesBranch -ne "master") {
    Write-Host "Pages repo was on '$pagesBranch' - switching to master" -ForegroundColor Yellow
    # A half-done rebase or merge blocks the switch. The repo holds generated
    # build output only, so dropping that state (and any local edit, hence
    # --force) loses nothing that this run does not rewrite anyway.
    foreach ($state in ".git\rebase-merge", ".git\rebase-apply") {
      if (Test-Path (Join-Path $pagesRepo $state)) { git -C $pagesRepo rebase --abort }
    }
    if (Test-Path (Join-Path $pagesRepo ".git\MERGE_HEAD")) { git -C $pagesRepo merge --abort }
    git -C $pagesRepo checkout --force master
    if ($LASTEXITCODE -ne 0) { throw "Cannot switch Pages repo to master (it is on '$pagesBranch')" }
  }

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
  # Explicit refspec: the deploy lands on master even if this repo's HEAD moved,
  # and it never follows a push.default that could target another branch.
  git add . && git commit -m "easyDBAccess $Target $($ver) [$branch]: $msg" && git push origin master
  Pop-Location

  Pop-Location
}
$ErrorActionPreference = "Stop"
main
