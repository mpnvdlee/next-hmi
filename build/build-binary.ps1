# Build a portable Windows binary distribution of NEXT HMI.
#
# Usage from repo root (PowerShell, with the project's venv activated):
#   .\build\build-binary.ps1 [-Version <string>] [-Edition oss|ee] [-PackageOnly]
#
# Produces (oss, the default):
#   dist\nexthmi\                            one-folder PyInstaller output
#   dist\nexthmi-windows-x64-<version>.zip   the distributable
# and for ee, the same under nexthmi-enterprise.
#
# -PackageOnly runs steps 5-9 only (rename, version stamp, docs, zip, verify)
# against an already-built PyInstaller output, skipping npm ci, the SPA build and
# PyInstaller. Two uses: finishing a build that died after step 4, and re-stamping
# an artifact with a real version without paying for another full build. It starts
# from dist\<artifact>, or an already-renamed staging folder, or — failing both —
# the newest matching zip in dist\.
#
# Prerequisites: Python 3.14 with project deps + pyinstaller installed
# in the active venv, Node 20.11+, esbuild on PATH (npm install -g esbuild).
# PyInstaller can't cross-compile — run on a Windows host.

[CmdletBinding()]
param(
  [string]$Version = $(if ($env:NEXTHMI_VERSION) { $env:NEXTHMI_VERSION } else { 'dev' }),
  [ValidateSet('oss', 'ee')]
  [string]$Edition = $(if ($env:NEXTHMI_EDITION) { $env:NEXTHMI_EDITION } else { 'oss' }),
  [switch]$PackageOnly
)

$ErrorActionPreference = 'Stop'
# Windows consoles default to cp1252, so any child Python printing a non-ASCII
# character dies with UnicodeEncodeError. Force UTF-8 for every python we spawn.
$env:PYTHONUTF8 = '1'
$RepoRoot = Resolve-Path "$PSScriptRoot\.."
Set-Location $RepoRoot

# CI resolves the version from the git tag before invoking this script; a local
# run has nothing equivalent, so an unqualified build silently produces an
# artifact stamped 'dev' — including when it was meant to be a release. Cheap to
# say out loud, expensive to discover after publishing.
if (-not $PSBoundParameters.ContainsKey('Version') -and -not $env:NEXTHMI_VERSION) {
  Write-Warning "No -Version given and NEXTHMI_VERSION unset — this artifact will be stamped '$Version'. Pass -Version <x.y.z> for a release build, or -PackageOnly -Version <x.y.z> to re-stamp an existing one."
}

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

# Build outputs. Declared here rather than at the step that creates them, so the
# finally-block can reason about them however early the build died.
$BuildWork = Join-Path $RepoRoot 'build\build-pyinstaller'
$DistTemp  = Join-Path $RepoRoot "dist\$ArtifactBase"
$OutputDir = Join-Path $RepoRoot "dist\$DistName"
$Succeeded = $false

# Destructive filesystem operations on a tree PyInstaller has just written race
# against handles that are still closing — the bootloader's own, an AV scanner
# walking 1400 fresh files, Explorer. Windows marks a directory deleted but keeps
# the entry until the last handle drops, so a Move-Item onto that path fails with
# "Access to the path is denied". That flake aborts the build at step 5 with every
# expensive step already paid for, and it fails a tagged release in CI, where
# there is no way to hand-finish the remaining steps. So: retry, and wait for a
# delete to actually take effect before reusing the path.
#
# Wait against a deadline rather than a fixed ladder of attempts. A ladder has to
# guess how long the scanner takes, and guessing low is indistinguishable from no
# retry at all: the first version allowed 2.2s across four tries, and a measured
# release build needed 3.7s to hand the directory back. A deadline costs nothing
# when the path is free — the first attempt returns — and the ceiling only has to
# beat the slowest scan, not predict the typical one.
#
# Remove-Tree spends this deadline twice, not once: Invoke-WithRetry uses it
# retrying the delete itself (a handle the scanner or the bootloader is still
# closing), then the wait below uses a fresh copy of it for the directory entry
# to disappear afterward. Both are the same class of flake and each needs its
# own full budget — sharing one would let a slow-to-release delete starve the
# entry-disappearance wait of time it would otherwise have had on its own, and
# fail a build that just needed a little longer. Worst case per call is
# therefore 2x this, not this; five calls sit on the hot path.
$RetryTimeoutSec = 60

function Invoke-WithRetry {
  param(
    [Parameter(Mandatory)][scriptblock]$Action,
    [Parameter(Mandatory)][string]$What
  )
  $deadline = (Get-Date).AddSeconds($RetryTimeoutSec)
  $delayMs = 200
  $attempt = 0
  while ($true) {
    $attempt++
    try {
      & $Action
      if ($attempt -gt 1) { Write-Host "[build] $What succeeded on attempt $attempt" }
      return
    } catch {
      if ((Get-Date) -ge $deadline) {
        throw "$What failed after $attempt attempts over ${RetryTimeoutSec}s: $($_.Exception.Message)"
      }
      # One line per stuck operation, not one per attempt — a 60s wait at this
      # backoff is ~70 tries, which would bury the rest of the build log.
      if ($attempt -eq 1) {
        Write-Host "[build] $What failed ($($_.Exception.Message.Trim())) — retrying for up to ${RetryTimeoutSec}s"
      }
      Start-Sleep -Milliseconds $delayMs
      $delayMs = [Math]::Min($delayMs * 2, 1000)
    }
  }
}

function Remove-Tree {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path $Path)) { return }
  Invoke-WithRetry -What "removing $Path" -Action { Remove-Item -Recurse -Force $Path }
  # Remove-Item returns once the delete is *marked*, not once it has happened.
  # Anything that then targets the same path gets access-denied, so wait it out —
  # on the same deadline as the retries above, for the same reason.
  $deadline = (Get-Date).AddSeconds($RetryTimeoutSec)
  while ((Test-Path $Path) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (Test-Path $Path) {
    throw "$Path still exists after being deleted — a process is holding a handle on it."
  }
}

function Cleanup-Scratch {
  Remove-Item -Recurse -Force $VendorDir       -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $SeedWidgetBuild -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $SeedShipped     -ErrorAction SilentlyContinue
}

$ModeTag = if ($PackageOnly) { ' [package-only]' } else { '' }
Write-Host "[build] NEXT HMI $Version ($Edition) -> $DistName$ModeTag"

try {
  if (-not $PackageOnly) {
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
    Remove-Tree $VendorDir
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
    Remove-Tree $SeedWidgetBuild
    $env:NEXTHMI_ACTIVE_PROJECT_PATH = (Join-Path $RepoRoot 'project-seed')
    $env:NEXTHMI_WIDGET_BUILD_DIR = $SeedWidgetBuild
    $env:ESBUILD_BINARY_PATH     = (Join-Path $VendorDir 'esbuild.exe')
    $env:PYTHONPATH              = (Join-Path $RepoRoot 'backend')
    $CompilerRan = $true
    # Reset first: on PowerShell 7.4+, $PSNativeCommandUseErrorActionPreference
    # defaults on, so a python that ran and exited non-zero also lands in the
    # catch below (not just a python that never launched), and it leaves
    # $LASTEXITCODE set to that real exit code. A launch failure (bad PATH, no
    # python at all) throws before any process exists, so it never touches
    # $LASTEXITCODE — clearing it first is what makes the two distinguishable.
    $LASTEXITCODE = $null
    try {
      python -m services.widget_compiler --once
    } catch {
      if ($null -eq $LASTEXITCODE) {
        # PowerShell failed to *launch* python at all — a build-host problem,
        # not a widget problem, and not something the per-widget tolerance
        # below should quietly absorb.
        $CompilerRan = $false
        Write-Warning "seed widget compile could not run python: $($_.Exception.Message)"
      }
      # else: python launched and exited non-zero, which 7.4+'s default now
      # raises here too — fall through to the per-widget-isolated handling
      # below instead of the launch-failure branch above.
    }
    if ($CompilerRan -and $LASTEXITCODE -ne 0) {
      Write-Host "[build] seed compile exited $LASTEXITCODE (continuing — failures are per-widget isolated)"
    }
    if (Test-Path $SeedWidgetBuild) {
      Remove-Tree $SeedShipped
      Copy-Item -Recurse $SeedWidgetBuild $SeedShipped
      $Baked = @(Get-ChildItem -Path $SeedShipped -Recurse -Filter 'index.js' -ErrorAction SilentlyContinue).Count
      Write-Host "[build] seed widget-build baked ($Baked compiled widget(s))"
    } else {
      # project-seed ships no custom widgets, so no build dir is the expected
      # outcome — but it is also what a compiler that died on startup leaves
      # behind, so name it rather than passing over it in silence.
      Write-Host "[build] no seed widget-build produced (project-seed carries no custom widgets)"
    }

    # 4. PyInstaller
    Write-Host "[build] running PyInstaller"
    Remove-Tree $BuildWork
    Remove-Tree $DistTemp
    pyinstaller `
      --noconfirm `
      --clean `
      --workpath $BuildWork `
      --distpath (Join-Path $RepoRoot 'dist') `
      (Join-Path $RepoRoot 'build\nexthmi.spec')
  }

  # 5. Rename, drop version stamp. Also where -PackageOnly picks up its starting
  #    point: a fresh PyInstaller output, an already-renamed staging folder left
  #    by a build that died later than this, or the shipped zip itself.
  if (Test-Path $DistTemp) {
    Remove-Tree $OutputDir
    Invoke-WithRetry -What "moving $DistTemp to $OutputDir" -Action { Move-Item $DistTemp $OutputDir }
  } elseif (-not (Test-Path $OutputDir)) {
    if (-not $PackageOnly) { throw "PyInstaller produced no output at $DistTemp." }
    $PriorZip = Get-ChildItem -Path (Join-Path $RepoRoot 'dist') -Filter "$DistName-*.zip" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $PriorZip) {
      throw "-PackageOnly has nothing to package: no $DistTemp, no $OutputDir, and no dist\$DistName-*.zip. Run a full build first."
    }
    Write-Host "[build] unpacking $($PriorZip.Name) to re-package"
    Expand-Archive -Path $PriorZip.FullName -DestinationPath (Join-Path $RepoRoot 'dist') -Force
  }
  Set-Content -Path (Join-Path $OutputDir 'version.txt') -Value $Version -NoNewline
  # core.version.app_version() reads the copy the spec bundled, which one-folder
  # PyInstaller puts under _internal and resolves via sys._MEIPASS — not the
  # human-facing file beside the exe. Stamping only the outer one would ship a
  # binary that reports the previous version on every -PackageOnly re-stamp.
  $InternalVersion = Join-Path $OutputDir '_internal\version.txt'
  if (Test-Path $InternalVersion) {
    Set-Content -Path $InternalVersion -Value $Version -NoNewline
  }

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
  # Not Compress-Archive: Windows PowerShell 5.1 writes entry names with
  # backslashes, which the ZIP spec forbids (APPNOTE 4.4.17.1) and which every
  # non-Windows unzip reads as literal characters in the filename rather than as
  # directory separators — so the artifact only unpacks correctly on Windows.
  # CreateFromDirectory writes '/', and is faster on a tree this size. The
  # trailing $true keeps the base folder as the prefix inside the archive, which
  # is the layout an operator's shortcuts depend on.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $OutputDir, $ZipPath, [System.IO.Compression.CompressionLevel]::Optimal, $true)

  # 8. Verify the artifact before declaring success. Every step above can fail in
  #    a way that still leaves a plausible-looking zip — a half-completed move, an
  #    extra nesting level from a hand-run recovery, a version stamp that never
  #    got applied — and none of those announce themselves until an operator
  #    unzips it. Read the archive back and assert the shape it must have.
  Write-Host '[build] verifying artifact'
  $Zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    # Directory records carry an empty Name; only real files count. Separators
    # are normalised so this check reads the archive the way the spec does,
    # whatever wrote it.
    $Files = @($Zip.Entries | Where-Object { $_.Name })
    $Names = @($Files | ForEach-Object { $_.FullName -replace '\\', '/' })

    foreach ($Required in @("$DistName/nexthmi.exe", "$DistName/version.txt")) {
      if ($Names -notcontains $Required) { throw "artifact is missing $Required" }
    }
    $Stray = $Names | Where-Object { -not $_.StartsWith("$DistName/") } | Select-Object -First 1
    if ($Stray) {
      throw "artifact has entries outside $DistName/ (first: $Stray) — the staged folder was nested wrongly"
    }
    # A complete build is ~1400 files; anything near zero means a truncated tree
    # got zipped instead of the real one.
    if ($Files.Count -lt 500) {
      throw "artifact holds only $($Files.Count) files — a complete build is ~1400"
    }

    foreach ($Stamp in @("$DistName/version.txt", "$DistName/_internal/version.txt")) {
      $Entry = $Files | Where-Object { ($_.FullName -replace '\\', '/') -eq $Stamp } | Select-Object -First 1
      if (-not $Entry) { continue }
      $Reader = New-Object System.IO.StreamReader($Entry.Open())
      try { $Stamped = $Reader.ReadToEnd().Trim() } finally { $Reader.Dispose() }
      if ($Stamped -ne $Version) { throw "$Stamp reads '$Stamped', expected '$Version'" }
    }
    Write-Host "[build] verified: $($Files.Count) files, stamped $Version"
  } finally {
    $Zip.Dispose()
  }

  # 9. Remove the staged folder — the zip is the deliverable.
  Remove-Tree $OutputDir

  $Succeeded = $true
  Write-Host "[build] done: $ZipPath"
}
finally {
  # 10. Cleanup. Scratch that mutates the source tree goes either way.
  Cleanup-Scratch

  if ($Succeeded) {
    # Pure intermediate state, hundreds of MB, and it otherwise survives every
    # run. Kept on failure, where it is the only PyInstaller diagnostic left.
    Remove-Item -Recurse -Force $BuildWork -ErrorAction SilentlyContinue
  } else {
    # Steps 5-9 are cheap; the tree they work from is not. If a usable staged
    # output survived, say so — -PackageOnly resumes from there instead of
    # repeating npm ci, the SPA build and PyInstaller.
    $Staged = @($OutputDir, $DistTemp) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($Staged) {
      if (Test-Path (Join-Path $Staged 'nexthmi.exe')) {
        Write-Host "[build] staged output kept at $Staged — re-run with -PackageOnly to finish from there."
      } else {
        # No executable means PyInstaller itself never finished, so this is not a
        # resumable starting point — just 100s of MB in the next run's way.
        Remove-Item -Recurse -Force $Staged -ErrorAction SilentlyContinue
      }
    }
  }
}
