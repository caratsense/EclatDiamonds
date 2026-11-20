param(
  [Parameter(Mandatory = $true)][string]$ProfilePath,
  [string]$TaskName = "",
  [string]$StateDir = "",
  [string]$CredentialPath = "",
  [string]$PythonPath = "",
  [string]$LogDir = "",
  [int]$EveryMinutes = 5,
  [ValidateRange(1, 90)][int]$LogRetentionDays = 14,
  [switch]$Enable,
  [switch]$Replace
)

$ErrorActionPreference = "Stop"
if ($EveryMinutes -lt 5 -or $EveryMinutes -gt 1440) {
  throw "EveryMinutes must be between 5 and 1440"
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$profile = (Resolve-Path -LiteralPath $ProfilePath).Path
$profileDocument = Get-Content -Raw -LiteralPath $profile | ConvertFrom-Json
$profileId = $profileDocument.id
if (-not $profileId -or $profileId -notmatch '^[a-z0-9][a-z0-9._-]{1,79}$') {
  throw "The connector profile has no valid id"
}
if ($profileDocument.discoveryOnly -or -not $profileDocument.entities) {
  throw "Discovery-only profiles cannot be scheduled for sync"
}
if (-not $TaskName) { $TaskName = "CaratOS Connect - $profileId" }
if (-not $StateDir) {
  $StateDir = Join-Path $env:LOCALAPPDATA "CaratOS\Connect\state"
}
$state = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($StateDir))
if (-not $CredentialPath) {
  $CredentialPath = Join-Path (Split-Path -Parent $state) "credentials\$profileId.bin"
}
$credential = (Resolve-Path -LiteralPath $CredentialPath).Path
if (-not $LogDir) {
  $LogDir = Join-Path (Split-Path -Parent $state) "logs"
}
$logs = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($LogDir))
if ($PythonPath) {
  $python = (Resolve-Path -LiteralPath $PythonPath).Path
} else {
  $bundledPython = Join-Path $root ".venv\Scripts\python.exe"
  if (Test-Path -LiteralPath $bundledPython -PathType Leaf) {
    $python = (Resolve-Path -LiteralPath $bundledPython).Path
  } else {
    throw "The isolated runtime is missing. Run setup_agent.ps1 first, or pass -PythonPath explicitly."
  }
}
$taskRunner = (Resolve-Path -LiteralPath (Join-Path $root "run_scheduled_sync.ps1")).Path
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and -not $Replace) {
  throw "Scheduled task '$TaskName' already exists. Pass -Replace only after reviewing it."
}

# A scheduled sync is never registered until the exact interpreter, profile,
# credential vault, source and server mapper have passed a zero-write dry run.
# Resolve the module from this script's folder, not whichever folder the
# administrator happened to invoke the installer from.
Push-Location $root
try {
  & $python -m caratos_connect.cli --profile $profile --state-dir $state --credential-file $credential sync --dry-run --require-active
  if ($LASTEXITCODE -ne 0) {
    throw "Connector dry-run preflight failed; no scheduled task was registered"
  }
} finally {
  Pop-Location
}

# No token, source password or connection string is placed in the task action.
# DPAPI binds the credential file to the current Windows user. An explicit
# interactive, least-privilege principal prevents a later installer invocation
# from silently switching the task to SYSTEM or another service account.
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$arguments = "-NoLogo -NoProfile -NonInteractive -File `"$taskRunner`" -PythonPath `"$python`" -ProfilePath `"$profile`" -StateDir `"$state`" -CredentialPath `"$credential`" -LogDir `"$logs`" -RetentionDays $LogRetentionDays"
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes ([Math]::Max(10, $EveryMinutes - 1)))

$register = @{
  TaskName = $TaskName
  Action = $action
  Trigger = $trigger
  Settings = $settings
  Principal = $principal
  Description = "Outbound read-only CaratOS connector"
}
if ($Replace) { $register.Force = $true }
Register-ScheduledTask @register | Out-Null
if (-not $Enable) { Disable-ScheduledTask -TaskName $TaskName | Out-Null }
$stateLabel = if ($Enable) { "enabled" } else { "disabled; enable it after reviewing the dry-run output" }
Write-Output "Installed scheduled task '$TaskName' for '$currentUser' ($stateLabel)."
Write-Output "Redacted operational logs will be written under '$logs'."
