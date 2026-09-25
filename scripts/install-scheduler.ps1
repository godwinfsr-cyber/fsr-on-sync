# Registers a Windows Task Scheduler job that runs `node src/cli.ts tick` every hour.
# `tick` only starts a sync when SYNC_INTERVAL_HOURS has elapsed, the sync is not paused and no
# other sync is running - so changing the interval from the dashboard needs no re-registration.
# Survives reboots/app restarts (the task is stored by Windows, not in a Node process).
param([string]$TaskName = "FSR ON.com Sync")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "src\cli.ts tick" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -AllowStartIfOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Full Size Run: sync ON.com Last Season shoes to Shopify (runs tick hourly; syncs every SYNC_INTERVAL_HOURS)" -Force | Out-Null
Write-Host "Registered scheduled task '$TaskName' (hourly tick) for $root"
