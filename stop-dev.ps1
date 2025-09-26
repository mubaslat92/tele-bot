<#
Stops Node processes that look like this project's server or worker (by command line).
Use with care — it will stop processes whose command line contains src/index.js or process_pending_jobs.js
#>
Write-Output "Finding node processes for this project..."
$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -match 'src\\index\.js' -or $_.CommandLine -match 'process_pending_jobs\.js' -or $_.CommandLine -match 'nodemon') }
if (-not $procs) { Write-Output "No matching processes found."; exit 0 }

foreach ($p in $procs) {
  try {
    Write-Output "Stopping PID $($p.ProcessId): $($p.CommandLine)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
  } catch {
    Write-Output "Failed to stop PID $($p.ProcessId): $_"
  }
}

Write-Output "Done."
