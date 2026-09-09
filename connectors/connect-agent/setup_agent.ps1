[CmdletBinding()]
param(
  [string]$PythonPath = "",
  [string]$ProfilePath = "",
  [string]$Wheelhouse = "",
  [switch]$Recreate,
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $root ".venv"
$requirements = Join-Path $root "requirements-lock.txt"

if (-not (Test-Path -LiteralPath $requirements -PathType Leaf)) {
  throw "requirements-lock.txt is missing from the connector package"
}

if ($PythonPath) {
  $basePython = (Resolve-Path -LiteralPath $PythonPath).Path
} else {
  $basePython = (Get-Command python.exe -ErrorAction Stop).Source
}

& $basePython -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
if ($LASTEXITCODE -ne 0) {
  throw "CaratOS Connect requires Python 3.10 or newer"
}

if ($Recreate -and (Test-Path -LiteralPath $venv)) {
  $resolvedRoot = [System.IO.Path]::GetFullPath($root).TrimEnd('\')
  $resolvedVenv = [System.IO.Path]::GetFullPath($venv).TrimEnd('\')
  if ($resolvedVenv -ne ($resolvedRoot + "\.venv")) {
    throw "Refusing to remove an unexpected virtual-environment path"
  }
  Remove-Item -LiteralPath $resolvedVenv -Recurse -Force
}

$runtimePython = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path -LiteralPath $runtimePython -PathType Leaf)) {
  & $basePython -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw "Failed to create the connector virtual environment" }
}

$installArgs = @("-m", "pip", "install", "--disable-pip-version-check")
if ($Wheelhouse) {
  $resolvedWheelhouse = (Resolve-Path -LiteralPath $Wheelhouse).Path
  $installArgs += @("--no-index", "--find-links", $resolvedWheelhouse)
}
$installArgs += @("-r", $requirements)
& $runtimePython @installArgs
if ($LASTEXITCODE -ne 0) { throw "Connector dependency installation failed" }

Push-Location $root
try {
  & $runtimePython -c "import platform, pyodbc, requests; print(f'Runtime ready: Python {platform.python_version()} ({platform.architecture()[0]}), requests {requests.__version__}, pyodbc {pyodbc.version}'); print('Visible ODBC drivers: ' + (', '.join(pyodbc.drivers()) or '[none]'))"
  if ($LASTEXITCODE -ne 0) { throw "Connector runtime import check failed" }
  if ($ProfilePath) {
    $resolvedProfile = (Resolve-Path -LiteralPath $ProfilePath).Path
    & $runtimePython -m caratos_connect.cli --profile $resolvedProfile doctor
    if ($LASTEXITCODE -ne 0) {
      throw "Connector profile/runtime compatibility check failed"
    }
  }
  if (-not $SkipTests) {
    & $runtimePython -m unittest discover -s tests -p "test_*.py"
    if ($LASTEXITCODE -ne 0) { throw "Connector self-tests failed" }
  }
} finally {
  Pop-Location
}

Write-Output "CaratOS Connect runtime is ready at '$runtimePython'."
Write-Output "Run configure and the masked preview as the Windows user that will own the scheduled task."
