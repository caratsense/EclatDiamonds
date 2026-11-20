[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PythonPath,
  [Parameter(Mandatory = $true)][string]$ProfilePath,
  [Parameter(Mandatory = $true)][string]$StateDir,
  [Parameter(Mandatory = $true)][string]$CredentialPath,
  [Parameter(Mandatory = $true)][string]$LogDir,
  [ValidateRange(1, 90)][int]$RetentionDays = 14
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logs = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($LogDir))
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$log = Join-Path $logs ("connect-wrapper-{0}.log" -f (Get-Date -Format "yyyyMMdd"))
$exitCode = 2
$locationPushed = $false

# Scheduled runs never accept preview's --show-values flag. The CLI also redacts
# known secrets before returning an error, so this file contains operational
# status/counts only. Old connector logs are removed from this exact directory.
try {
  $python = (Resolve-Path -LiteralPath $PythonPath).Path
  $profile = (Resolve-Path -LiteralPath $ProfilePath).Path
  $credential = (Resolve-Path -LiteralPath $CredentialPath).Path
  $state = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($StateDir))
  $profileDocument = Get-Content -Raw -LiteralPath $profile | ConvertFrom-Json
  $profileId = $profileDocument.id
  if (-not $profileId -or $profileId -notmatch '^[a-z0-9][a-z0-9._-]{1,79}$') {
    throw "The scheduled connector profile has no valid id"
  }
  $log = Join-Path $logs ("connect-{0}-{1}.log" -f $profileId, (Get-Date -Format "yyyyMMdd"))
  $cutoff = (Get-Date).AddDays(-$RetentionDays)
  Get-ChildItem -LiteralPath $logs -File -Filter ("connect-{0}-*.log" -f $profileId) -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    Remove-Item -Force

  $started = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
  Add-Content -LiteralPath $log -Value "[$started] scheduled sync started"
  Push-Location $root
  $locationPushed = $true
  $output = & $python -m caratos_connect.cli --profile $profile --state-dir $state --credential-file $credential sync 2>&1
  $exitCode = $LASTEXITCODE
  if ($output) { $output | Add-Content -LiteralPath $log }
} catch {
  # This wrapper has no source connection string or token arguments. Avoid
  # serialising the full PowerShell error object, which can include process data.
  Add-Content -LiteralPath $log -Value ("ERROR: wrapper failure: {0}" -f $_.Exception.Message)
  $exitCode = 2
} finally {
  if ($locationPushed) { Pop-Location }
}

$finished = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
Add-Content -LiteralPath $log -Value "[$finished] scheduled sync finished with exit code $exitCode"
exit $exitCode
