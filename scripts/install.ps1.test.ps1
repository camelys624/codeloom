#!/usr/bin/env pwsh
# Modified for Codeloom: cover the pinned CLI-only installer.
#
# Tests for scripts/install.ps1, the PowerShell counterpart of
# scripts/install.test.sh. External effects are stubbed so the suite also runs
# on a non-Windows agent and never touches the network.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path (Split-Path $PSCommandPath -Parent) -Parent
$InstallerPath = Join-Path $RepoRoot "scripts/install.ps1"

# install.ps1 resolves its install directory from USERPROFILE. Provide one so
# these tests also run on a non-Windows agent.
if (-not $env:USERPROFILE) { $env:USERPROFILE = [System.IO.Path]::GetTempPath() }

function Fail-Test {
    param([string]$Message)
    Write-Host "FAIL: $Message" -ForegroundColor Red
    exit 1
}

# install.ps1 dispatches at the bottom on import, so load only the definitions.
function Get-InstallerDefinitions {
    $source = Get-Content -Raw -Path $InstallerPath
    $marker = "# Entry point"
    $index = $source.IndexOf($marker)
    if ($index -lt 0) {
        Fail-Test "could not find the entry-point marker in install.ps1"
    }
    # Trim back to the comment banner that precedes the marker.
    $banner = $source.LastIndexOf("# ---", $index)
    if ($banner -ge 0) { $index = $banner }
    return $source.Substring(0, $index)
}

# ---------------------------------------------------------------------------
# 1. install.ps1 must parse
# ---------------------------------------------------------------------------
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($InstallerPath, [ref]$null, [ref]$parseErrors) | Out-Null
if ($parseErrors) {
    $parseErrors | ForEach-Object { Write-Host "  $($_.Message) (line $($_.Extent.StartLineNumber))" }
    Fail-Test "install.ps1 has parse errors"
}

$definitions = Get-InstallerDefinitions

# ---------------------------------------------------------------------------
# 2. Install-Cli keeps the pinned version and replaces any other
# ---------------------------------------------------------------------------
# Runs Install-Cli with `multica version` answering $Versions in order (the last
# answer repeats). Install-CliBinary only records that it ran, and Write-Fail
# throws instead of exiting so the failure message can be asserted.
function Invoke-InstallCli {
    param(
        [string[]]$Versions,
        [bool]$Present = $true
    )

    $script:versionAnswers = [System.Collections.Generic.Queue[string]]::new([string[]]$Versions)
    $script:lastVersion = $null
    $script:binaryInstalled = $false

    & {
        Invoke-Expression $definitions
        function multica {
            if ($script:versionAnswers.Count -gt 0) { $script:lastVersion = $script:versionAnswers.Dequeue() }
            "multica $($script:lastVersion) (commit: test)"
        }
        function Test-CommandExists { param([string]$Name) $Present }
        function Install-CliBinary { $script:binaryInstalled = $true }
        function Write-Fail { param([string]$Msg) throw $Msg }

        $failure = $null
        try {
            Install-Cli
        } catch {
            $failure = $_.Exception.Message
        }
        [pscustomobject]@{ Installed = $script:binaryInstalled; Failure = $failure }
    }
}

$result = Invoke-InstallCli -Versions @("0.5.0") -Present $false
if (-not $result.Installed -or $result.Failure) {
    Fail-Test "fresh install: expected the pinned binary to install cleanly, got installed=$($result.Installed) failure='$($result.Failure)'"
}

$result = Invoke-InstallCli -Versions @("v0.5.0")
if ($result.Installed -or $result.Failure) {
    Fail-Test "pinned version installed: expected no reinstall, got installed=$($result.Installed) failure='$($result.Failure)'"
}

$result = Invoke-InstallCli -Versions @("0.5.2", "0.5.0")
if (-not $result.Installed -or $result.Failure) {
    Fail-Test "newer version installed: expected a switch to v0.5.0, got installed=$($result.Installed) failure='$($result.Failure)'"
}

# E.g. a Scoop-managed multica that stays first on PATH.
$result = Invoke-InstallCli -Versions @("0.5.2", "0.5.2")
if (-not $result.Failure -or $result.Failure -notmatch [regex]::Escape("'multica' on PATH is v0.5.2")) {
    Fail-Test "shadowing multica: expected a failure naming v0.5.2, got '$($result.Failure)'"
}

# ---------------------------------------------------------------------------
# 3. Install-CliBinary downloads the pinned upstream release
# ---------------------------------------------------------------------------
function Get-DownloadUrl {
    param([string]$VersionOverride)

    $script:requestedUrls = @()
    $previous = $env:MULTICA_CLI_VERSION
    if ($VersionOverride) {
        $env:MULTICA_CLI_VERSION = $VersionOverride
    } else {
        Remove-Item Env:MULTICA_CLI_VERSION -ErrorAction SilentlyContinue
    }

    try {
        & {
            Invoke-Expression $definitions
            function Get-WindowsCliArch { "amd64" }
            function Invoke-WebRequest {
                param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
                $script:requestedUrls += $Uri
                throw "offline"
            }
            function Write-Fail { param([string]$Msg) throw $Msg }
            try { Install-CliBinary } catch {}
        }
    } finally {
        if ($null -eq $previous) {
            Remove-Item Env:MULTICA_CLI_VERSION -ErrorAction SilentlyContinue
        } else {
            $env:MULTICA_CLI_VERSION = $previous
        }
    }
    return ($script:requestedUrls | Select-Object -First 1)
}

$expected = "https://github.com/multica-ai/multica/releases/download/v0.5.0/multica-cli-0.5.0-windows-amd64.zip"
$actual = Get-DownloadUrl
if ($actual -ne $expected) {
    Fail-Test "pinned download: expected '$expected', got '$actual'"
}

$expected = "https://github.com/multica-ai/multica/releases/download/v0.5.1/multica-cli-0.5.1-windows-amd64.zip"
$actual = Get-DownloadUrl -VersionOverride "0.5.1"
if ($actual -ne $expected) {
    Fail-Test "MULTICA_CLI_VERSION override: expected '$expected', got '$actual'"
}

# ---------------------------------------------------------------------------
# 4. Server modes point to the Codeloom deployment instead of provisioning
# ---------------------------------------------------------------------------
# Each mode runs in its own pwsh process because install.ps1 exits on failure.
foreach ($mode in @("with-server", "local", "stop")) {
    $previous = $env:MULTICA_MODE
    $env:MULTICA_MODE = $mode
    try {
        $output = & pwsh -NoProfile -File $InstallerPath 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        if ($null -eq $previous) {
            Remove-Item Env:MULTICA_MODE -ErrorAction SilentlyContinue
        } else {
            $env:MULTICA_MODE = $previous
        }
    }

    $rendered = ($output | Out-String)
    if ($exitCode -ne 1) {
        Write-Host $rendered
        Fail-Test "MULTICA_MODE=$($mode): expected exit 1, got $exitCode"
    }
    if ($rendered -notmatch [regex]::Escape("SELF_HOSTING.md#codeloom-internal-deployment")) {
        Write-Host $rendered
        Fail-Test "MULTICA_MODE=$($mode): expected a pointer to the Codeloom deployment docs"
    }
}

Write-Host "install.ps1 tests passed" -ForegroundColor Green
