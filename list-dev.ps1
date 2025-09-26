<#
Lists Node processes that look like this project's server or worker (by command line).
It shows PID and command line so you can manually close the right windows.
#>
Write-Output "Scanning for node processes related to this repo..."
$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -match 'src\\index\.js' -or $_.CommandLine -match 'process_pending_jobs\.js' -or $_.CommandLine -match 'nodemon') }
if (-not $procs) { Write-Output "No matching node processes found."; exit 0 }

foreach ($p in $procs) {
  $cmd = $p.CommandLine -replace "`"", '"' # keep readable
  [PSCustomObject]@{
    Id = $p.ProcessId
    Name = $p.Name
    CommandLine = $cmd
    CreationDate = $p.CreationDate
  }
}
