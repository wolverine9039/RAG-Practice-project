# Deploy the FastAPI backend to Google Cloud Run. Safe to re-run (also used for updates).
# Run from the project root:  powershell -ExecutionPolicy Bypass -File deploy\cloudrun\deploy.ps1
# Requires: Google Cloud SDK logged in (gcloud auth login), the project's billing enabled, and a local index
# (python -m app.ingest --reset) built with the same Gemini embedding settings as .env.
param(
    [string]$Project = "uno-rag-chatbot",
    [string]$Region = "us-central1",
    [string]$Service = "uno-rag-backend",
    [switch]$SkipIamGrants   # skip the role grants (already done, or done by a project owner)
)
$ErrorActionPreference = "Continue"   # gcloud writes progress to stderr; check $LASTEXITCODE instead
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$gcloud = (Get-Command gcloud -ErrorAction SilentlyContinue).Source
if (-not $gcloud) { $gcloud = "C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd" }
if (-not (Test-Path $gcloud)) { Write-Error "gcloud not found - install the Google Cloud SDK"; exit 1 }
$python = Join-Path $root ".venv\Scripts\python.exe"
$sa = "$Service@$Project.iam.gserviceaccount.com"

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Check($what) { if ($LASTEXITCODE -ne 0) { Write-Error "$what failed (exit $LASTEXITCODE)"; exit 1 } }

Step "Enabling APIs (Cloud Run, Cloud Build, Artifact Registry, Vertex AI)"
& $gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com aiplatform.googleapis.com --project $Project
Check "Enabling APIs"

Step "Service account $sa (Vertex AI User)"
& $gcloud iam service-accounts describe $sa --project $Project *> $null
if ($LASTEXITCODE -ne 0) {
    & $gcloud iam service-accounts create $Service --project $Project --display-name "UNO RAG backend (Cloud Run)"
    Check "Creating service account"
}
if (-not $SkipIamGrants) {
    & $gcloud projects add-iam-policy-binding $Project --member "serviceAccount:$sa" --role roles/aiplatform.user --condition=None --quiet *> $null
    Check "Granting roles/aiplatform.user"

    Step "Build permissions for source deploys (default compute service account)"
    $projectNumber = (& $gcloud projects describe $Project --format "value(projectNumber)").Trim()
    $computeSa = "$projectNumber-compute@developer.gserviceaccount.com"
    foreach ($role in @("roles/run.builder", "roles/cloudbuild.builds.builder")) {
        & $gcloud projects add-iam-policy-binding $Project --member "serviceAccount:$computeSa" --role $role --condition=None --quiet *> $null
        Check "Granting $role"
    }
    # IAM changes can take a minute or two to apply; the first build right after granting may fail and just needs a re-run.
} else {
    Write-Host "Skipping IAM role grants (-SkipIamGrants)"
}

Step "Preparing the vector index for the image"
& $python deploy\cloudrun\prepare_index.py
Check "prepare_index.py"

Step "Generating Cloud Run environment variables from .env"
& $python deploy\cloudrun\make_env.py
Check "make_env.py"
$envFile = "deploy\cloudrun\env.generated.yaml"

try {
    Step "Building and deploying $Service to $Region (takes a few minutes)"
    & $gcloud run deploy $Service `
        --source . `
        --project $Project `
        --region $Region `
        --service-account $sa `
        --env-vars-file $envFile `
        --allow-unauthenticated `
        --min-instances 0 `
        --max-instances 1 `
        --memory 1Gi `
        --cpu 1 `
        --concurrency 20 `
        --timeout 120 `
        --cpu-boost `
        --quiet
    Check "gcloud run deploy"
}
finally {
    # The env file contains BACKEND_API_KEY and Langfuse keys
    Remove-Item $envFile -ErrorAction SilentlyContinue
}

$url = (& $gcloud run services describe $Service --project $Project --region $Region --format "value(status.url)").Trim()
Write-Host "`nDeployed: $url" -ForegroundColor Green
Write-Host "  Health : $url/health"
Write-Host "  Logs   : gcloud run services logs read $Service --region $Region --project $Project"
Write-Host "Point WordPress at it: Settings -> UNO Chatbot -> Backend URL = $url"
