<#
Starts the server (bot + API) and the worker in separate PowerShell windows for local development.

Usage: right-click -> Run with PowerShell, or from a PowerShell prompt:
    cd C:\Users\hamza\Projects\telegram-ledger-bot
    .\run-dev.ps1

This script will:
- copy .env.example -> .env if missing
- run npm install if node_modules is missing
- open two new PowerShell windows: one running `npm run dev` (server), one running the worker script
#>

$project = Split-Path -Path $MyInvocation.MyCommand.Definition -Parent
Set-Location $project

Write-Output "Starting dev environment in: $project"

if (-not (Test-Path -Path ".env") -and (Test-Path -Path ".env.example")) {
    Copy-Item -Path .env.example -Destination .env -Force
    Write-Output "Copied .env.example -> .env (please edit .env before running in production)."
}

if (-not (Test-Path -Path "node_modules")) {
    Write-Output "Installing npm dependencies (this may take a moment)..."
    npm install
}

Write-Output "Launching server (npm run dev) in a new PowerShell window..."
Start-Process -FilePath "powershell.exe" -ArgumentList "-NoExit", "-Command", "cd '$project'; npm run dev" -WindowStyle Normal

Start-Process -FilePath "powershell.exe" -ArgumentList "-NoExit", "-Command", "cd '$project'; node .\scripts\process_pending_jobs.js" -WindowStyle Normal

Write-Output "Server and worker launched in separate windows. Check their consoles for logs."
