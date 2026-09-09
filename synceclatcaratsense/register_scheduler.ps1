[CmdletBinding()]
param(
    [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$installPath = $PSScriptRoot
$securityCheck = Join-Path $installPath 'verify_install_security.ps1'
$runner = Join-Path $installPath 'run_sync.bat'

if (-not (Test-Path -LiteralPath $securityCheck -PathType Leaf)) {
    throw 'verify_install_security.ps1 is missing.'
}
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    throw 'run_sync.bat is missing.'
}

& $securityCheck -InstallPath $installPath
if ($LASTEXITCODE -ne 0) {
    throw 'Install-directory security verification failed.'
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$taskNames = @('EclatSync', 'EclatSync_Boot', 'EclatSync_Logon')
$existingTasks = @(
    Get-ScheduledTask -ErrorAction Stop |
        Where-Object { $_.TaskPath -eq '\' -and $_.TaskName -in $taskNames }
)
if ($existingTasks.Count -gt 0) {
    $names = ($existingTasks.TaskName | Sort-Object -Unique) -join ', '
    throw "Existing legacy task(s) found: $names. Do not overwrite an unknown principal. Remove them explicitly, inspect Task Scheduler, then run this installer again as the normal sync user."
}

$action = New-ScheduledTaskAction `
    -Execute $env:ComSpec `
    -Argument ('/d /c ""{0}""' -f $runner) `
    -WorkingDirectory $installPath

$repeatTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 15)
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name

$principal = New-ScheduledTaskPrincipal `
    -UserId $identity.Name `
    -LogonType Interactive `
    -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 4) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

$definition = New-ScheduledTask `
    -Action $action `
    -Trigger @($repeatTrigger, $logonTrigger) `
    -Principal $principal `
    -Settings $settings

if ($ValidateOnly) {
    Write-Output '[OK] Scheduler definition validated; no task was registered.'
    exit 0
}

Register-ScheduledTask -TaskName 'EclatSync' -InputObject $definition | Out-Null

$installed = Get-ScheduledTask -TaskName 'EclatSync' -ErrorAction Stop
$installedSid = ([Security.Principal.NTAccount]$installed.Principal.UserId).Translate(
    [Security.Principal.SecurityIdentifier]
).Value
if (
    $installedSid -ne $identity.User.Value -or
    $installed.Principal.RunLevel -ne 'Limited' -or
    $installed.Principal.LogonType -ne 'InteractiveToken'
) {
    Unregister-ScheduledTask -TaskName 'EclatSync' -Confirm:$false -ErrorAction SilentlyContinue
    throw 'The installed task principal did not match the required interactive, least-privilege user. It was removed.'
}

Write-Output "[OK] EclatSync registered for $($identity.Name), interactive and least privilege."
Write-Output '[NOTE] It runs every 15 minutes while this user is signed in, and once at sign-in.'
