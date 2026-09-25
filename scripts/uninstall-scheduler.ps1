param([string]$TaskName = "FSR ON.com Sync")
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed scheduled task '$TaskName'"
