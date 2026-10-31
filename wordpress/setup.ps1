# One-shot local WordPress setup for the UNO RAG chatbot.
# Run from the project root:  powershell -ExecutionPolicy Bypass -File wordpress\setup.ps1
# Requires Docker Desktop running. Safe to run again (skips steps already done).
param(
    [string]$SiteUrl = "http://localhost:8080",
    [string]$AdminUser = "admin",
    [string]$AdminEmail = "admin@example.com",
    [string]$BackendUrl = "http://host.docker.internal:8000"
)
# Native tools (docker) write progress to stderr; check $LASTEXITCODE instead of stopping on stderr
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Wp {
    $out = docker compose --progress quiet run --rm -T wpcli wp @args 2>&1 | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] -or $_ -notmatch 'Container .* (Running|Creating|Created|Starting|Started)' }
    $out
}

# Backend API key from .env (sent by WordPress as X-API-Key)
$apiKey = ""
$envLine = Get-Content (Join-Path $root ".env") | Where-Object { $_ -match '^\s*BACKEND_API_KEY\s*=' } | Select-Object -First 1
if ($envLine) { $apiKey = ($envLine -split '=', 2)[1].Trim().Trim('"') }

Write-Host "Starting containers..."
docker compose --progress quiet up -d db wordpress 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "docker compose up failed (is Docker Desktop running?)"; exit 1 }

Write-Host "Waiting for WordPress at $SiteUrl ..."
for ($i = 0; $i -lt 60; $i++) {
    try { Invoke-WebRequest -Uri $SiteUrl -UseBasicParsing -TimeoutSec 3 | Out-Null; break } catch { Start-Sleep -Seconds 2 }
}

$credFile = Join-Path $PSScriptRoot "admin-credentials.txt"
docker compose --progress quiet run --rm -T wpcli wp core is-installed 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    $password = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 16 | ForEach-Object { [char]$_ })
    Wp core install --url=$SiteUrl --title="UNO Rules Chat" --admin_user=$AdminUser --admin_password=$password --admin_email=$AdminEmail --skip-email
    "WordPress admin: $SiteUrl/wp-admin  user: $AdminUser  password: $password" | Set-Content $credFile
    Write-Host "WordPress installed. Credentials saved to $credFile"
} else {
    Write-Host "WordPress already installed."
}

Wp rewrite structure "/%postname%/" --hard | Out-Null
Wp plugin activate uno-rag-chatbot | Out-Null

$options = @{
    backend_url = $BackendUrl
    api_key     = $apiKey
    title       = "UNO Rules Assistant"
    welcome     = "Hi! Ask me anything about UNO, UNO Flip, UNO Dare, UNO No Mercy or UNO All Wild."
    floating    = 1
    per_hour    = 10
} | ConvertTo-Json -Compress
# Base64 avoids PowerShell 5.1 quoting/BOM problems when passing JSON to a native command
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($options))
Wp eval "update_option('uno_rag_chatbot_options', json_decode(base64_decode('$b64'), true));" | Out-Null
$saved = (Wp option get uno_rag_chatbot_options --format=json) -replace '"api_key":"[^"]*"', '"api_key":"***"'
Write-Host "Plugin settings saved: $saved"

# Chat page, Home page (front page) and the "Main menu" navigation - shared with the Google Cloud setup
Wp eval-file /setup/pages.php

Write-Host ""
Write-Host "Done."
Write-Host "  Home page : $SiteUrl/"
Write-Host "  Chat page : $SiteUrl/uno-rules-chat/"
Write-Host "  Settings  : $SiteUrl/wp-admin/options-general.php?page=uno-rag-chatbot"
if (Test-Path $credFile) { Get-Content $credFile }
Write-Host "Make sure the backend is running on the host:  python -m app.main"
