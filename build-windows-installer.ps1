#Requires -Version 5.1

[CmdletBinding()]
param(
    [ValidateSet("x64", "arm64")]
    [string]$Architecture = "x64",

    [string]$Version = "",

    [switch]$SkipDependencyInstall,

    [switch]$Help
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Show-Usage {
    @"
Build the Tabby Sync Windows installer and portable archive.

Usage:
  powershell -ExecutionPolicy Bypass -File .\build-windows-installer.ps1
  powershell -ExecutionPolicy Bypass -File .\build-windows-installer.ps1 -Architecture arm64

Options:
  -Architecture x64|arm64  Target Windows architecture (default: x64)
  -Version 1.0.0          Version used when the Git repository has no release tag
  -SkipDependencyInstall  Reuse the existing node_modules directory
  -Help                   Show this help

Output:
  dist\tabby-<version>-setup-<architecture>.exe
  dist\tabby-<version>-portable-<architecture>.zip
"@
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    Write-Host "`n==> $FilePath $($Arguments -join ' ')" -ForegroundColor Cyan
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath"
    }
}

if ($Help) {
    Show-Usage
    exit 0
}

if ($env:OS -ne "Windows_NT") {
    throw "This script must be run on Windows. Use install-macos.sh on macOS."
}

$ProjectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $ProjectDirectory

$NodeCommand = Get-Command "node.exe" -ErrorAction SilentlyContinue
if ($null -eq $NodeCommand) {
    throw "Node.js 18 or newer is required. Install the current Node.js LTS release first."
}

$NodeVersionText = (& $NodeCommand.Source --version).Trim()
$NodeVersionParts = ($NodeVersionText -replace '^v', '').Split('.')
$NodeMajorVersion = [int]$NodeVersionParts[0]
$NodeMinorVersion = [int]$NodeVersionParts[1]
if (($NodeMajorVersion -lt 22) -or (($NodeMajorVersion -eq 22) -and ($NodeMinorVersion -lt 12))) {
    throw "Node.js 22.12 or newer is required (found $NodeVersionText)."
}

$YarnCommand = Get-Command "yarn.cmd" -ErrorAction SilentlyContinue
if ($null -eq $YarnCommand) {
    $CorepackCommand = Get-Command "corepack.cmd" -ErrorAction SilentlyContinue
    if ($null -eq $CorepackCommand) {
        throw "Yarn is missing. Install Yarn or a Node.js distribution with Corepack."
    }

    Invoke-NativeCommand -FilePath $CorepackCommand.Source -Arguments @("enable")
    $YarnCommand = Get-Command "yarn.cmd" -ErrorAction SilentlyContinue
    if ($null -eq $YarnCommand) {
        throw "Corepack could not make Yarn available in PATH."
    }
}

if ([string]::IsNullOrWhiteSpace($Version)) {
    $GitCommand = Get-Command "git.exe" -ErrorAction SilentlyContinue
    if ($null -ne $GitCommand) {
        $GitDescription = & $GitCommand.Source describe --tags 2>$null
        if (($LASTEXITCODE -eq 0) -and (-not [string]::IsNullOrWhiteSpace($GitDescription))) {
            # The regular build script will derive its version from this Git tag.
            $Version = ""
        }
        else {
            $Version = "1.0.0"
        }
    }
    else {
        $Version = "1.0.0"
    }
}

if (-not [string]::IsNullOrWhiteSpace($Version)) {
    if ($Version -notmatch '^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$') {
        throw "Invalid semantic version: $Version"
    }
    $env:TABBY_BUILD_VERSION = $Version
    Write-Host "Using build version $Version (no usable Git release tag was found)." -ForegroundColor Yellow
}

$env:ARCH = $Architecture
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"

if (-not $SkipDependencyInstall) {
    Invoke-NativeCommand -FilePath $YarnCommand.Source -Arguments @(
        "install",
        "--frozen-lockfile",
        "--non-interactive"
    )
}
elseif (-not (Test-Path -LiteralPath (Join-Path $ProjectDirectory "node_modules"))) {
    throw "-SkipDependencyInstall was used, but node_modules does not exist."
}

Invoke-NativeCommand -FilePath $YarnCommand.Source -Arguments @("run", "build")
Invoke-NativeCommand -FilePath $NodeCommand.Source -Arguments @("scripts/prepackage-plugins.mjs")
$PackagingStartedAt = Get-Date
Invoke-NativeCommand -FilePath $NodeCommand.Source -Arguments @("scripts/build-windows.mjs")

$DistDirectory = Join-Path $ProjectDirectory "dist"
$SetupInstallers = @(
    Get-ChildItem -LiteralPath $DistDirectory -File -Filter "*-setup-$Architecture.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $PackagingStartedAt.AddSeconds(-2) } |
        Sort-Object LastWriteTime -Descending
)
$PortableArchives = @(
    Get-ChildItem -LiteralPath $DistDirectory -File -Filter "*-portable-$Architecture.zip" -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $PackagingStartedAt.AddSeconds(-2) } |
        Sort-Object LastWriteTime -Descending
)

if ($SetupInstallers.Count -eq 0) {
    throw "electron-builder finished, but no NSIS setup executable was found in $DistDirectory."
}

Write-Host "`nWindows installer created successfully:" -ForegroundColor Green
Write-Host "  $($SetupInstallers[0].FullName)"
if ($PortableArchives.Count -gt 0) {
    Write-Host "Portable archive:"
    Write-Host "  $($PortableArchives[0].FullName)"
}
