[CmdletBinding()]param(
  [switch]$WorkingTree  # build the local working tree instead of main (uncommitted state)
)
function main() {
  cd $PSScriptRoot

  if ($WorkingTree) {
    $ver = (Get-Content -Raw .\package.json | ConvertFrom-Json).version
    Write-Warning "Building from the working tree (uncommitted local state), not main."
    $context = "."
    Build-Image $ver $context
  } else {
    $ver = (git show main:package.json | ConvertFrom-Json).version

    # First use: the Dockerfile may still be untracked on main. Fail fast with
    # a clear message instead of archiving a tree that doesn't have it.
    git cat-file -e main:Dockerfile 2>$null
    if ($LASTEXITCODE -ne 0) {
      throw "Dockerfile is not committed to main yet. Commit it, or re-run with -WorkingTree."
    }

    # Export main to a temp dir and build from there so uncommitted local
    # edits can't leak into the image.
    $tmp = Join-Path ([IO.Path]::GetTempPath()) "easydbaccess-docker-$ver"
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
      git archive main --format=tar -o "$tmp.tar"
      tar -xf "$tmp.tar" -C $tmp
      Build-Image $ver $tmp
    } finally {
      Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
      Remove-Item "$tmp.tar" -Force -ErrorAction SilentlyContinue
    }
  }
}

function Build-Image($ver, $context) {
  # Build, tagging both the versioned image and :latest.
  docker build -t "easydbaccess:$ver" -t easydbaccess:latest $context
  if ($LASTEXITCODE -ne 0) { throw "docker build failed!" }

  # Replace any existing container (running or stopped). 2>$null swallows the
  # "No such container" error on a first run, where there's nothing to remove.
  docker rm -f easydbaccess 2>$null

  # Run detached with a restart policy so the container survives host reboots
  # and Docker Engine restarts (NOT --rm, which would delete it on stop). Port
  # 8190 echoes the dev server's 5190 and avoids twikki's 8081.
  docker run -d --restart unless-stopped -p 8190:80 --name easydbaccess easydbaccess:latest
  if ($LASTEXITCODE -ne 0) { throw "docker run failed!" }

  Write-Host "easyDBAccess running at http://localhost:8190/"
}
$ErrorActionPreference = "Stop"
main
