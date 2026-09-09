[CmdletBinding()]
param(
    [string]$PythonPath = '',
    [string]$Wheelhouse = '',
    [switch]$Recreate,
    [switch]$SkipTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$securityCheck = Join-Path $root 'verify_install_security.ps1'
$lockFile = Join-Path $root 'requirements-lock.txt'
$venv = Join-Path $root '.venv'
$runtimePython = Join-Path $venv 'Scripts\python.exe'

if (-not (Test-Path -LiteralPath $securityCheck -PathType Leaf)) {
    throw 'verify_install_security.ps1 is missing.'
}
& $securityCheck -InstallPath $root
if ($LASTEXITCODE -ne 0) {
    throw 'Move this package to a private local per-user directory before setup.'
}
if (-not (Test-Path -LiteralPath $lockFile -PathType Leaf)) {
    throw 'requirements-lock.txt is missing.'
}

$basePython = if ($PythonPath) {
    (Resolve-Path -LiteralPath $PythonPath).Path
} else {
    (Get-Command python.exe -ErrorAction Stop).Source
}
& $basePython -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'
if ($LASTEXITCODE -ne 0) {
    throw 'The Gati connector requires Python 3.10 or newer.'
}

if ($Recreate -and (Test-Path -LiteralPath $venv)) {
    $resolvedRoot = [IO.Path]::GetFullPath($root).TrimEnd('\')
    $resolvedVenv = [IO.Path]::GetFullPath($venv).TrimEnd('\')
    if ($resolvedVenv -ne ($resolvedRoot + '\.venv')) {
        throw 'Refusing to remove an unexpected virtual-environment path.'
    }
    Remove-Item -LiteralPath $resolvedVenv -Recurse -Force
}

if (-not (Test-Path -LiteralPath $runtimePython -PathType Leaf)) {
    & $basePython -m venv $venv
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not create the private Python runtime.'
    }
}

$installArgs = @(
    '-m', 'pip', 'install',
    '--disable-pip-version-check',
    '--only-binary=:all:'
)
if ($Wheelhouse) {
    $resolvedWheelhouse = (Resolve-Path -LiteralPath $Wheelhouse).Path
    $installArgs += @('--no-index', '--find-links', $resolvedWheelhouse)
}
$installArgs += @('-r', $lockFile)
& $runtimePython @installArgs
if ($LASTEXITCODE -ne 0) {
    throw 'Exact connector dependency installation failed. Use a reviewed wheelhouse for an offline client.'
}

Push-Location $root
try {
    & $runtimePython -c "import platform,pyodbc,requests,openpyxl,PIL; print(f'Runtime ready: Python {platform.python_version()} ({platform.architecture()[0]}), pyodbc {pyodbc.version}, requests {requests.__version__}, openpyxl {openpyxl.__version__}, Pillow {PIL.__version__}'); print('Visible ODBC drivers: ' + (', '.join(pyodbc.drivers()) or '[none]'))"
    if ($LASTEXITCODE -ne 0) {
        throw 'The private runtime cannot import its locked dependencies.'
    }
    if (-not $SkipTests) {
        & $runtimePython -m unittest -v test_gati_runtime.py test_gati_machine_auth.py test_sync_acknowledgement.py test_sync_media.py test_import_website.py
        if ($LASTEXITCODE -ne 0) {
            throw 'Gati connector self-tests failed.'
        }
        & $runtimePython test_sigv4.py
        if ($LASTEXITCODE -ne 0) {
            throw 'Gati storage-signing self-tests failed.'
        }
    }
} finally {
    Pop-Location
}

Write-Output "Private Gati runtime ready at '$runtimePython'."
Write-Output 'Continue with 1_discover.bat as this same non-admin Windows user.'
