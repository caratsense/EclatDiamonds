param(
  [string]$TaskName = "CaratOS BUSY Customer Sync",
  [int]$IntervalMinutes = 5,
  [string]$PythonExe = "",
  [string]$AgentScript = ""
)

throw "The legacy BUSY task installer is retired. Use connectors/connect-agent/install_task.ps1 with profiles/busy-bds-starter.json."

$ErrorActionPreference = "Stop"
if ($IntervalMinutes -lt 1) { throw "IntervalMinutes must be at least 1." }
if (-not $AgentScript) { $AgentScript = Join-Path $PSScriptRoot "busy_connect.py" }
$AgentScript = [System.IO.Path]::GetFullPath($AgentScript)
if (-not (Test-Path -LiteralPath $AgentScript -PathType Leaf)) { throw "Agent script not found." }

if (-not $PythonExe) {
  $python = Get-Command pythonw.exe -ErrorAction SilentlyContinue
  if (-not $python) { $python = Get-Command python.exe -ErrorAction Stop }
  $PythonExe = $python.Source
}
$PythonExe = [System.IO.Path]::GetFullPath($PythonExe)
if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) { throw "Python executable not found." }

$required = "CARATOS_BASE_URL", "CARATOS_AGENT_TOKEN", "BUSY_DB_PATHS", "BUSY_DB_PASSWORD"
$missing = $required | Where-Object { -not [Environment]::GetEnvironmentVariable($_, "User") }
if ($missing) {
  throw "Set these as User environment variables before installing the task: $($missing -join ', ')"
}

# A scheduled one-shot avoids a permanently-running process and lets Windows
# record every launch. Environment secrets are inherited from the current user;
# none are embedded in the task action or this script.
[Environment]::SetEnvironmentVariable("BUSY_RUN_ONCE", "1", "User")
$action = New-ScheduledTaskAction -Execute $PythonExe -Argument ('"' + $AgentScript + '"')
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Description "Outbound BUSY customer-master sync to CaratOS" -Force | Out-Null
Write-Host "Installed scheduled task: $TaskName (every $IntervalMinutes minutes)"
