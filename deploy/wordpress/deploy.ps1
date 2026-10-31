# Deploy the WordPress front end to a Google Compute Engine VM (Docker: WordPress + MariaDB + Caddy HTTPS).
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File deploy\wordpress\deploy.ps1 -Domain uno.example.com
# Without -Domain it only creates the static IP, firewall rule and VM, and prints the IP for your DNS A record.
# Safe to re-run: also updates the plugin files and its backend settings (backend URL + key from .env).
# By default the site runs behind Cloudflare: the DNS record must be Proxied (orange cloud) with SSL/TLS mode
# "Full (strict)". Caddy then trusts Cloudflare's visitor-IP header and the firewall only admits Cloudflare's IPs.
# -NoCloudflare: DNS-only record pointing at the VM, firewall open to everyone.
param(
    [string]$Domain = "",
    [string]$Project = "uno-rag-chatbot",
    [string]$Region = "us-central1",
    [string]$Zone = "us-central1-a",
    [string]$Instance = "uno-wordpress",
    [string]$Machine = "e2-small",
    [string]$BackendService = "uno-rag-backend",
    [int]$DnsWaitMinutes = 10,
    [switch]$NoCloudflare
)
$ErrorActionPreference = "Continue"   # gcloud writes progress to stderr; check $LASTEXITCODE instead
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$gcloud = (Get-Command gcloud -ErrorAction SilentlyContinue).Source
if (-not $gcloud) { $gcloud = "C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd" }
if (-not (Test-Path $gcloud)) { Write-Error "gcloud not found - install the Google Cloud SDK"; exit 1 }
$ipName = "$Instance-ip"
$tag = "uno-wp"
$Domain = $Domain.Trim().ToLower() -replace '^https?://', '' -replace '/.*$', ''

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Check($what) { if ($LASTEXITCODE -ne 0) { Write-Error "$what failed (exit $LASTEXITCODE)"; exit 1 } }
function Exists { & $gcloud @args --project $Project *> $null; return ($LASTEXITCODE -eq 0) }
function OnVm($command) {
    & $gcloud compute ssh $Instance --zone $Zone --project $Project --quiet --strict-host-key-checking=no --command $command
}
function InCidr([string]$address, [string]$cidr) {
    $net, $bits = $cidr.Split('/')
    $a = [BitConverter]::ToUInt32(([Net.IPAddress]::Parse($address).GetAddressBytes())[3..0], 0)
    $n = [BitConverter]::ToUInt32(([Net.IPAddress]::Parse($net).GetAddressBytes())[3..0], 0)
    $mask = if ([int]$bits -eq 0) { [uint32]0 } else { [uint32]([uint64][uint32]::MaxValue -shl (32 - [int]$bits) -band [uint32]::MaxValue) }
    return (($a -band $mask) -eq ($n -band $mask))
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Step "Static IP $ipName"
if (-not (Exists compute addresses describe $ipName --region $Region)) {
    & $gcloud compute addresses create $ipName --region $Region --project $Project
    Check "Reserving the static IP"
}
$ip = (& $gcloud compute addresses describe $ipName --region $Region --project $Project --format "value(address)").Trim()
Write-Host "IP: $ip"

Step "Firewall rule for HTTP/HTTPS"
if (-not (Exists compute firewall-rules describe "$tag-web")) {
    & $gcloud compute firewall-rules create "$tag-web" --project $Project --network default --direction INGRESS `
        --allow "tcp:80,tcp:443,udp:443" --source-ranges "0.0.0.0/0" --target-tags $tag `
        --description "Public web traffic to the UNO chatbot WordPress VM"
    Check "Creating the firewall rule"
}

Step "VM $Instance ($Machine, $Zone)"
if (-not (Exists compute instances describe $Instance --zone $Zone)) {
    & $gcloud compute instances create $Instance --project $Project --zone $Zone `
        --machine-type $Machine --image-family debian-12 --image-project debian-cloud `
        --boot-disk-size 20GB --boot-disk-type pd-balanced --tags $tag --address $ip `
        --scopes "logging-write,monitoring-write" --shielded-secure-boot
    Check "Creating the VM"
    Write-Host "Waiting for SSH to come up..."
    for ($i = 0; $i -lt 30; $i++) {
        OnVm "true" *> $null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Seconds 10
    }
}

if (-not $Domain) {
    Write-Host "`nInfrastructure ready. Next:" -ForegroundColor Green
    Write-Host "  1. At your DNS provider create an A record:  <your domain>  ->  $ip"
    Write-Host "  2. Re-run:  powershell -ExecutionPolicy Bypass -File deploy\wordpress\deploy.ps1 -Domain <your domain>"
    exit 0
}

$cfV4 = @(); $cfV6 = @()
if (-not $NoCloudflare) {
    Step "Fetching Cloudflare's IP ranges"
    try {
        $cf = (Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/ips" -TimeoutSec 20).result
        $cfV4 = @($cf.ipv4_cidrs); $cfV6 = @($cf.ipv6_cidrs)
    } catch { }
    if ($cfV4.Count -lt 5) { Write-Error "Could not fetch Cloudflare's IP ranges (api.cloudflare.com/client/v4/ips)"; exit 1 }
    Write-Host "$($cfV4.Count) IPv4 + $($cfV6.Count) IPv6 ranges"
}

if ($NoCloudflare) { Step "Checking that $Domain points to $ip" } else { Step "Checking that $Domain is proxied by Cloudflare" }
$deadline = (Get-Date).AddMinutes($DnsWaitMinutes)
while ($true) {
    $found = @(Resolve-DnsName -Name $Domain -Type A -DnsOnly -Server 8.8.8.8 -ErrorAction SilentlyContinue |
        Where-Object { $_.Type -eq "A" } | ForEach-Object { $_.IPAddress })
    if ($NoCloudflare) {
        $ok = $found -contains $ip
    } else {
        $outside = @($found | Where-Object { $a = $_; -not @($cfV4 | Where-Object { InCidr $a $_ }).Count })
        $ok = ($found.Count -gt 0) -and ($outside.Count -eq 0)
    }
    if ($ok) { Write-Host "OK: $Domain -> $($found -join ', ')"; break }
    if ((Get-Date) -gt $deadline) {
        Write-Host "$Domain resolves to '$($found -join ', ')'." -ForegroundColor Yellow
        if ($NoCloudflare) {
            Write-Host "Create (or fix) the DNS-only A record  $Domain -> $ip, wait a few minutes and re-run."
        } else {
            Write-Host "In Cloudflare: A record  $Domain -> $ip  with Proxy status 'Proxied' (orange cloud), and"
            Write-Host "SSL/TLS encryption mode 'Full (strict)'. Then re-run (or add -NoCloudflare for a DNS-only setup)."
        }
        exit 2
    }
    Write-Host "  waiting for DNS ($Domain -> $($found -join ', '))..."
    Start-Sleep -Seconds 20
}

Step "Packaging the site files"
$backendUrl = (& $gcloud run services describe $BackendService --region $Region --project $Project --format "value(status.url)").Trim()
Check "Reading the Cloud Run backend URL"
$apiKey = ""
$envLine = Get-Content (Join-Path $root ".env") | Where-Object { $_ -match '^\s*BACKEND_API_KEY\s*=' } | Select-Object -First 1
if ($envLine) { $apiKey = ($envLine -split '=', 2)[1].Trim().Trim('"') }
if (-not $apiKey) { Write-Error "BACKEND_API_KEY is empty in .env"; exit 1 }

$stage = Join-Path $env:TEMP ("uno-wp-" + [guid]::NewGuid().ToString("N"))
$bundle = "$stage.tgz"
try {
    New-Item -ItemType Directory -Force "$stage\plugin", "$stage\setup" | Out-Null
    Copy-Item deploy\wordpress\docker-compose.yml, deploy\wordpress\Caddyfile, deploy\wordpress\vm-setup.sh $stage
    Copy-Item -Recurse deploy\wordpress\caddy "$stage\caddy"
    Copy-Item -Recurse wordpress\uno-rag-chatbot "$stage\plugin\uno-rag-chatbot"
    if (-not $NoCloudflare) {
        [IO.File]::WriteAllText("$stage\cloudflare-ips.txt", (($cfV4 + $cfV6) -join "`n") + "`n", (New-Object Text.UTF8Encoding $false))
    }
    Copy-Item wordpress\setup\pages.php, deploy\wordpress\plugin-options.php "$stage\setup"
    $settings = @{ backend_url = $backendUrl; api_key = $apiKey } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText("$stage\plugin-settings.json", $settings, (New-Object Text.UTF8Encoding $false))
    & "$env:SystemRoot\System32\tar.exe" -czf $bundle -C $stage .
    Check "Creating the bundle"

    Step "Uploading to $Instance"
    & $gcloud compute scp $bundle "${Instance}:uno-wp-bundle.tgz" --zone $Zone --project $Project --quiet --strict-host-key-checking=no
    Check "Uploading the bundle"
}
finally {
    # The bundle contains the backend API key
    Remove-Item -Recurse -Force $stage, $bundle -ErrorAction SilentlyContinue
}

Step "Installing / updating WordPress on the VM (first run takes a few minutes)"
OnVm ("set -e; sudo mkdir -p /opt/uno-wp; sudo chmod 750 /opt/uno-wp; " +
     "sudo rm -rf /opt/uno-wp/plugin /opt/uno-wp/setup /opt/uno-wp/caddy /opt/uno-wp/cloudflare-ips.txt; " +
     "sudo tar -xzf ~/uno-wp-bundle.tgz -C /opt/uno-wp --no-same-owner; rm -f ~/uno-wp-bundle.tgz; " +
     "sudo bash /opt/uno-wp/vm-setup.sh $Domain")
$setupExit = $LASTEXITCODE
OnVm "sudo rm -f /opt/uno-wp/plugin-settings.json ~/uno-wp-bundle.tgz" *> $null
if ($setupExit -ne 0) { Write-Error "vm-setup.sh failed (exit $setupExit)"; exit 1 }

if ($NoCloudflare) {
    Step "Firewall: web traffic from anywhere"
    & $gcloud compute firewall-rules update "$tag-web" --project $Project --source-ranges "0.0.0.0/0"
    Check "Updating the firewall rule"
} else {
    # Only lock the VM down to Cloudflare once the site works through Cloudflare (orange cloud + Full (strict))
    Step "Checking https://$Domain/ through Cloudflare"
    $viaCf = $false
    for ($i = 0; $i -lt 12 -and -not $viaCf; $i++) {
        try {
            $r = Invoke-WebRequest -Uri "https://$Domain/" -UseBasicParsing -TimeoutSec 30
            $viaCf = ($r.StatusCode -eq 200) -and [bool]$r.Headers["CF-RAY"]
            if (-not $viaCf) { Write-Host "  HTTP $($r.StatusCode), CF-RAY '$($r.Headers["CF-RAY"])'" }
        } catch { Write-Host "  $($_.Exception.Message)" }
        if (-not $viaCf) { Start-Sleep -Seconds 15 }
    }
    if (-not $viaCf) {
        Write-Host "The site does not answer through Cloudflare yet, so the firewall was left open." -ForegroundColor Yellow
        Write-Host "Check: Proxied (orange cloud) DNS record and SSL/TLS mode 'Full (strict)', then re-run."
    } else {
        Step "Firewall: web traffic only from Cloudflare"
        & $gcloud compute firewall-rules update "$tag-web" --project $Project --source-ranges ($cfV4 -join ",")
        Check "Updating the firewall rule"
    }
}

$credFile = Join-Path $root "wordpress\admin-credentials-gcp.txt"
$cred = OnVm "sudo cat /opt/uno-wp/admin-credentials.txt" 2>$null
if ($cred) { $cred | Set-Content $credFile; Write-Host "Admin credentials saved to $credFile" }

Write-Host "`nDeployed:" -ForegroundColor Green
Write-Host "  Home     : https://$Domain/"
Write-Host "  Chat     : https://$Domain/uno-rules-chat/"
Write-Host "  Admin    : https://$Domain/wp-admin/"
Write-Host "  SSH      : gcloud compute ssh $Instance --zone $Zone --project $Project"
Write-Host "  Logs     : (on the VM) cd /opt/uno-wp; sudo docker compose logs -f"
