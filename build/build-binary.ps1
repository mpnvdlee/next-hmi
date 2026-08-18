# Build a portable Windows binary distribution of NEXT HMI.
#
# Usage from repo root (PowerShell, with the project's venv activated):
#   .\build\build-binary.ps1 [-Version <string>] [-Edition oss|ee]
#
# Produces (oss, the default):
#   dist\nexthmi\                            one-folder PyInstaller output
#   dist\nexthmi-windows-x64-<version>.zip   the distributable
# and for ee, the same under nexthmi-enterprise.
#
# Prerequisites: Python 3.14 with project deps + pyinstaller installed
# in the active venv, Node 20+, esbuild on PATH (npm install -g esbuild).
# PyInstaller can't cross-compile — run on a Windows host.

[CmdletBinding()]
param(
  [string]$Version = $(if ($env:NEXTHMI_VERSION) { $env:NEXTHMI_VERSION } else { 'dev' }),
  [ValidateSet('oss', 'ee')]
  [string]$Edition = $(if ($env:NEXTHMI_EDITION) { $env:NEXTHMI_EDITION } else { 'oss' })
)

$ErrorActionPreference = 'Stop'
# Windows consoles default to cp1252, so any child Python printing a non-ASCII
# character dies with UnicodeEncodeError. Force UTF-8 for every python we spawn.
$env:PYTHONUTF8 = '1'
$RepoRoot = Resolve-Path "$PSScriptRoot\.."
Set-Location $RepoRoot

# The edition selects the frontend alias target, the packaged backend tree, and
# the artifact name. It has to reach *both* the SPA build and PyInstaller: the
# spec bundles whatever is in frontend\dist, so a frontend built for the other
# edition would be packaged as-is. Set once here, read by both.
$env:NEXTHMI_EDITION = $Edition
if ($Edition -eq 'ee' -and -not (Test-Path (Join-Path $RepoRoot 'enterprise\frontend\registry.ts'))) {
  throw "Edition 'ee' but enterprise\ is missing — clone the enterprise repository into enterprise\."
}

$OsTag   = 'windows'
$ArchTag = 'x64'
$ArtifactBase = if ($Edition -eq 'ee') { 'nexthmi-enterprise' } else { 'nexthmi' }
$DistName = "$ArtifactBase-$OsTag-$ArchTag"

# Scratch artifacts that mutate the source tree. Declared up-front so the
# finally-block can clean them up even if an exception aborts the build
# part-way through — mirrors the EXIT trap in build-binary.sh.
$VendorDir       = Join-Path $RepoRoot 'build\_vendor'
$SeedWidgetBuild = Join-Path $RepoRoot 'build\_seed-widget-build'
$SeedShipped     = Join-Path $RepoRoot 'project-seed\.widget-build'

function Cleanup-Scratch {
  Remove-Item -Recurse -Force $VendorDir       -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $SeedWidgetBuild -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $SeedShipped     -ErrorAction SilentlyContinue
}

Write-Host "[build] NEXT HMI $Version ($Edition) -> $DistName"

try {
  # 1. Frontend bundle, built for this edition and stamped with it. The stamp is
  #    what lets the spec refuse a bundle left behind by a build of the other
  #    edition; it is removed first so an aborted build can never leave a stale
  #    stamp that happens to match.
  Write-Host "[build] building frontend ($Edition)"
  $EditionStamp = Join-Path $RepoRoot 'frontend\dist\.nexthmi-edition'
  Remove-Item -Force $EditionStamp -ErrorAction SilentlyContinue
  Push-Location frontend
  npm ci
  Pop-Location
  if ($Edition -eq 'ee') {
    # enterprise\ carries no package.json, so Node can only resolve react and
    # the app's own aliases from that tree through a link to frontend\node_modules.
    $EeModules = Join-Path $RepoRoot 'enterprise\node_modules'
    if (-not (Test-Path $EeModules)) {
      New-Item -ItemType Junction -Path $EeModules `
        -Target (Join-Path $RepoRoot 'frontend\node_modules') | Out-Null
    }
  }
  Push-Location frontend
  npm run build
  Pop-Location
  Set-Content -Path $EditionStamp -Value $Edition -NoNewline

  # 2. Vendor esbuild + version stamp
  if (Test-Path $VendorDir) { Remove-Item -Recurse -Force $VendorDir }
  New-Item -ItemType Directory -Path $VendorDir | Out-Null

  # esbuild ships as a native binary inside its per-platform package
  # (@esbuild/win32-x64/esbuild.exe). Get-Command resolves the npm .cmd/.ps1
  # shim instead, and copying that into esbuild.exe yields "not a valid
  # application for this OS platform" when the frozen app runs it standalone.
  # Resolve the real PE from the global install (or the frontend local copy).
  $globalRoot = (& npm root -g).Trim()
  $EsbuildCandidates = @(
    (Join-Path $globalRoot '@esbuild\win32-x64\esbuild.exe'),
    (Join-Path $globalRoot 'esbuild\bin\esbuild.exe'),
    (Join-Path $RepoRoot 'frontend\node_modules\@esbuild\win32-x64\esbuild.exe')
  )
  $EsbuildBin = $EsbuildCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $EsbuildBin) {
    throw "native esbuild.exe not found. Looked in:`n  $($EsbuildCandidates -join "`n  ")`nInstall with 'npm install -g esbuild', or run 'npm ci' in frontend."
  }
  Copy-Item $EsbuildBin (Join-Path $VendorDir 'esbuild.exe')
  Set-Content -Path (Join-Path $VendorDir 'version.txt') -Value $Version -NoNewline

  # 3. Bake the seed widget-build
  Write-Host "[build] baking seed widget-build"
  if (Test-Path $SeedWidgetBuild) { Remove-Item -Recurse -Force $SeedWidgetBuild }
  $env:NEXTHMI_ACTIVE_PROJECT_PATH = (Join-Path $RepoRoot 'project-seed')
  $env:NEXTHMI_WIDGET_BUILD_DIR = $SeedWidgetBuild
  $env:ESBUILD_BINARY_PATH     = (Join-Path $VendorDir 'esbuild.exe')
  $env:PYTHONPATH              = (Join-Path $RepoRoot 'backend')
  try {
    python -m services.widget_compiler --once
  } catch {
    Write-Host "[build] seed compile reported issues (continuing — failures are per-widget isolated)"
  }
  if (Test-Path $SeedWidgetBuild) {
    if (Test-Path $SeedShipped) { Remove-Item -Recurse -Force $SeedShipped }
    Copy-Item -Recurse $SeedWidgetBuild $SeedShipped
  }

  # 4. PyInstaller
  Write-Host "[build] running PyInstaller"
  $BuildWork = Join-Path $RepoRoot 'build\build-pyinstaller'
  $DistTemp  = Join-Path $RepoRoot "dist\$ArtifactBase"
  if (Test-Path $BuildWork) { Remove-Item -Recurse -Force $BuildWork }
  if (Test-Path $DistTemp)  { Remove-Item -Recurse -Force $DistTemp }
  pyinstaller `
    --noconfirm `
    --clean `
    --workpath $BuildWork `
    --distpath (Join-Path $RepoRoot 'dist') `
    (Join-Path $RepoRoot 'build\nexthmi.spec')

  # 5. Rename, drop version stamp
  $OutputDir = Join-Path $RepoRoot "dist\$DistName"
  if (Test-Path $OutputDir) { Remove-Item -Recurse -Force $OutputDir }
  Move-Item $DistTemp $OutputDir
  Set-Content -Path (Join-Path $OutputDir 'version.txt') -Value $Version -NoNewline

  # 6. Documentation. Rendered to self-contained HTML beside the executable, so
  #    it is browsable straight from the unzipped folder and the manager can
  #    serve it at /help for the editor's Help button (see api/docs_api.py).
  Write-Host '[build] rendering documentation'
  & python (Join-Path $RepoRoot 'build\render-docs.py') (Join-Path $OutputDir 'docs') $Version
  if ($LASTEXITCODE -ne 0) { throw "docs render failed (exit $LASTEXITCODE)" }

  # 7. Zip. The name carries the version so two downloads of different releases
  #    don't collide in a downloads folder; the folder *inside* stays
  #    unversioned, because that's the path an operator's shortcuts point at.
  Get-ChildItem -Path (Join-Path $RepoRoot 'dist') -Filter "$DistName*.zip" -ErrorAction SilentlyContinue |
    Remove-Item -Force
  $ZipPath = Join-Path $RepoRoot "dist\$DistName-$Version.zip"
  Compress-Archive -Path $OutputDir -DestinationPath $ZipPath

  # 8. Remove the staged folder — the zip is the deliverable.
  Remove-Item -Recurse -Force $OutputDir

  Write-Host "[build] done: $ZipPath"
}
finally {
  # 9. Cleanup scratch artifacts even if a step above threw.
  Cleanup-Scratch
}
