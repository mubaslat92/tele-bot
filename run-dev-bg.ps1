<#
Run server and worker as background processes (no interactive windows). Use this for quick local runs.

Usage:
  cd C:\path\to\repo
  .\run-dev-bg.ps1

This will start the server (npm run start) and the worker using Start-Process.
#>

$project = Split-Path -Path $MyInvocation.MyCommand.Definition -Parent
Set-Location $project

if (-not (Test-Path -Path "node_modules")) {
    Write-Output "Installing npm dependencies..."
    npm install
}

Write-Output "Starting server (background)..."
Start-Process -FilePath "node" -ArgumentList "src/index.js" -WindowStyle Hidden

Write-Output "Starting worker (background)..."
Start-Process -FilePath "node" -ArgumentList "scripts/process_pending_jobs.js" -WindowStyle Hidden

Write-Output "Server and worker started in the background. Use Task Manager to stop them or restart your machine."
