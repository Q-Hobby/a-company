[CmdletBinding()]
param(
  [switch]$PrepareOnly,
  [switch]$Local,
  [switch]$PullNever,
  [switch]$Offline
)

$ErrorActionPreference = "Stop"

$DownloadBase = if ($env:ACOMPANY_DOWNLOAD_BASE) { $env:ACOMPANY_DOWNLOAD_BASE.TrimEnd("/") } else { "https://raw.githubusercontent.com/phuocka/a-company/main/infra/compose" }
if (-not $DownloadBase.StartsWith("https://")) {
  Write-Error "A-Company setup failed: ACOMPANY_DOWNLOAD_BASE must use https."
  exit 1
}

if ($env:ACOMPANY_DOWNLOAD_SKIP_EXISTING -eq "1") { $Local = $true }
if ($env:ACOMPANY_PULL_NEVER -eq "1") { $PullNever = $true }
if ($Offline) {
  $Local = $true
  $PullNever = $true
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Error "A-Company setup failed: 'docker' is required. Install Docker Desktop first."
  exit 1
}

docker compose version *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Error "A-Company setup failed: the Docker Compose plugin is required."
  exit 1
}

function New-HexSecret([int]$Bytes = 16) {
  $buffer = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  return ([System.BitConverter]::ToString($buffer) -replace "-", "").ToLowerInvariant()
}

$ComposeFile = "docker-compose.images.yml"
$EnvExample = ".env.images.example"
$EnvFile = ".env"

if (-not ($Local -and (Test-Path $ComposeFile))) {
  Invoke-WebRequest -UseBasicParsing -Uri "$DownloadBase/$ComposeFile" -OutFile $ComposeFile
}
if (-not ($Local -and (Test-Path $EnvExample))) {
  Invoke-WebRequest -UseBasicParsing -Uri "$DownloadBase/$EnvExample" -OutFile $EnvExample
}

if (-not (Test-Path $EnvFile)) {
  $content = Get-Content $EnvExample -Raw
  $pgPass = New-HexSecret 16
  $replacements = @{
    "POSTGRES_PASSWORD"        = $pgPass
    "BETTER_AUTH_SECRET"       = (New-HexSecret 32)
    "ENCRYPTION_KEY"           = (New-HexSecret 32)
    "SCREEN_PROXY_SECRET"      = (New-HexSecret 32)
    "SANDBOX_SUPERVISOR_TOKEN" = (New-HexSecret 32)
  }
  foreach ($key in $replacements.Keys) {
    $val = $replacements[$key]
    $content = [regex]::Replace($content, "(?m)^$key=.*$", "$key=$val")
  }
  Set-Content -Path $EnvFile -Value $content -NoNewline -Encoding UTF8
  Write-Host "Created $EnvFile with fresh random secrets."
} else {
  Write-Host "Preserving existing $EnvFile."
}

if ($PrepareOnly) {
  Write-Host "Prepared $ComposeFile and $EnvFile (-PrepareOnly)."
  exit 0
}

$args = @("compose", "--env-file", $EnvFile, "-f", $ComposeFile, "up", "-d")
if ($PullNever) {
  $args += "--pull=never"
}

& docker @args
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Host "A-Company is running at http://127.0.0.1:5173"
