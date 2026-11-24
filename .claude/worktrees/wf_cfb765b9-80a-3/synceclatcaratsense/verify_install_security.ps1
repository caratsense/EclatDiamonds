[CmdletBinding()]
param(
    [string]$InstallPath = $PSScriptRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Stop-InstallSecurity {
    param([string]$Message)
    [Console]::Error.WriteLine("[SECURITY STOP] $Message")
    exit 20
}

try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $identity.User) {
        Stop-InstallSecurity 'The current Windows account has no user SID.'
    }

    $currentSid = $identity.User.Value
    $serviceSids = @('S-1-5-18', 'S-1-5-19', 'S-1-5-20')
    if ($currentSid -in $serviceSids) {
        Stop-InstallSecurity 'The sync may not run as SYSTEM, LOCAL SERVICE, or NETWORK SERVICE.'
    }

    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Stop-InstallSecurity 'This process is elevated. Sign in as the intended sync user and run it normally, without Run as administrator.'
    }

    $root = (Resolve-Path -LiteralPath $InstallPath).Path.TrimEnd('\')
    if ($root.StartsWith('\\')) {
        Stop-InstallSecurity 'The install directory is a network/UNC path. Use a private local NTFS directory.'
    }

    $rootItem = Get-Item -LiteralPath $root -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Stop-InstallSecurity 'The install directory is a junction or symbolic link. Use a normal local directory.'
    }

    # The folder holds a database password and an agent token. Only the exact
    # run-as user, SYSTEM (backup/AV), and local Administrators may have allow
    # entries. Read access by another local/domain principal is already a secret
    # disclosure, even if that principal cannot modify the scripts.
    $allowedSids = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    @($currentSid, 'S-1-5-18', 'S-1-5-32-544') | ForEach-Object {
        [void]$allowedSids.Add($_)
    }

    $pathsToCheck = @($rootItem)
    $pathsToCheck += Get-ChildItem -LiteralPath $root -Force -File |
        Where-Object { $_.Extension -in @('.bat', '.py', '.ps1', '.json', '.txt') }
    @(
        (Join-Path $root '.venv'),
        (Join-Path $root '.venv\Scripts'),
        (Join-Path $root '.venv\Scripts\python.exe'),
        (Join-Path $root '.venv\Lib\site-packages')
    ) | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object {
        $pathsToCheck += Get-Item -LiteralPath $_ -Force
    }

    foreach ($item in $pathsToCheck) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Stop-InstallSecurity "A protected runtime file is a link: $($item.FullName)"
        }

        $acl = Get-Acl -LiteralPath $item.FullName
        try {
            $ownerSid = ([Security.Principal.NTAccount]$acl.Owner).Translate(
                [Security.Principal.SecurityIdentifier]
            ).Value
        }
        catch {
            $ownerSid = $acl.Owner
        }
        if (-not $allowedSids.Contains($ownerSid)) {
            Stop-InstallSecurity "Unexpected owner '$($acl.Owner)' on $($item.FullName)."
        }

        foreach ($rule in $acl.Access) {
            if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
                continue
            }

            try {
                $ruleSid = $rule.IdentityReference.Translate(
                    [Security.Principal.SecurityIdentifier]
                ).Value
            }
            catch {
                Stop-InstallSecurity "Could not resolve ACL identity '$($rule.IdentityReference)' on $($item.FullName)."
            }

            # CREATOR OWNER is safe only as an inherit-only template; it grants
            # no access to this object itself.
            if (
                $ruleSid -eq 'S-1-3-0' -and
                ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0
            ) {
                continue
            }

            if (-not $allowedSids.Contains($ruleSid)) {
                Stop-InstallSecurity "'$($rule.IdentityReference)' has access to $($item.FullName). Move the agent to a private per-user NTFS directory and ask IT to restrict its ACL."
            }
        }
    }

    Write-Output "[OK] Private install directory and unelevated user verified: $($identity.Name)"
}
catch {
    Stop-InstallSecurity $_.Exception.Message
}
