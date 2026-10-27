$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$demoPort = 8788
$envFile = Join-Path $repoRoot '.env'
if (Test-Path -LiteralPath $envFile) {
  $portLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^AI_DEMO_PORT=\d+$' } | Select-Object -Last 1
  if ($portLine) { $demoPort = [int]($portLine -replace '^AI_DEMO_PORT=', '') }
}
if ($env:AI_DEMO_PORT) { $demoPort = [int]$env:AI_DEMO_PORT }
$demoUrl = "http://127.0.0.1:$demoPort/"
function Test-DemoReady {
  try {
    $response = Invoke-RestMethod ($demoUrl + 'api/fixtures') -TimeoutSec 2
    return ($null -ne $response.fixtures)
  } catch { return $false }
}
if (Test-DemoReady) { Write-Output "Demo already running: $demoUrl"; exit 0 }
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$logDirectory = Join-Path $repoRoot 'data'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$process = Start-Process -FilePath $nodeExecutable -ArgumentList @('--env-file-if-exists=.env', '--import', 'tsx', 'tools/ai-demo/index.ts') -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory 'ai-demo.log') -RedirectStandardError (Join-Path $logDirectory 'ai-demo-error.log') -PassThru
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  if (Test-DemoReady) { Write-Output "Demo running in the background: $demoUrl (PID $($process.Id))"; exit 0 }
  if ($process.HasExited) { throw 'Demo exited during startup. See data/ai-demo-error.log.' }
  Start-Sleep -Milliseconds 250
}
throw 'Demo did not become ready. See data/ai-demo-error.log.'
