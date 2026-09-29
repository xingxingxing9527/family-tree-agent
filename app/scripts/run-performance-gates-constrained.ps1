[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$applicationRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$affinityMask = [IntPtr]15
$environmentNames = @(
  "FAMILY_AGENT_PERF_LOGICAL_CORES",
  "FAMILY_AGENT_PERF_MEMORY_LIMIT_MB",
  "FAMILY_AGENT_PERF_AFFINITY_MASK"
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

try {
  $env:FAMILY_AGENT_PERF_LOGICAL_CORES = "4"
  $env:FAMILY_AGENT_PERF_MEMORY_LIMIT_MB = "6144"
  $env:FAMILY_AGENT_PERF_AFFINITY_MASK = "0x0000000f"
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $nodeExecutable
  $startInfo.Arguments = "--max-old-space-size=6144 --import tsx scripts/run-performance-gates.ts"
  $startInfo.WorkingDirectory = $applicationRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  $startedAtUtc = [DateTime]::UtcNow
  if (!$process.Start()) { throw "Failed to start constrained performance process" }
  try {
    $process.ProcessorAffinity = $affinityMask
    $process.Refresh()
    $observedAffinity = [int64]$process.ProcessorAffinity
    if ($observedAffinity -ne 15) {
      throw "Failed to enforce the four-logical-core affinity mask (observed $observedAffinity)"
    }
    Write-Host "[performance] constrained runner affinity=0x0000000f logicalCores=4 nodeHeapLimitMb=6144"
    $process.WaitForExit()
    $process.Refresh()
    $childExitCode = $process.ExitCode
    if ($childExitCode -ne 0) {
      throw "Constrained performance gate exited with code $childExitCode"
    }
    $reportPath = Join-Path $applicationRoot "release\reports\performance-report.json"
    if (!(Test-Path -LiteralPath $reportPath -PathType Leaf)) {
      throw "Constrained performance process did not write its report"
    }
    $reportFile = Get-Item -LiteralPath $reportPath
    $report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
    if ($reportFile.LastWriteTimeUtc -lt $startedAtUtc -or !$report.passed -or !$report.runtime.constraints.constrained) {
      throw "Constrained performance report is stale, failed, or lacks enforced constraints"
    }
    Write-Output (Get-Content -Raw -LiteralPath $reportPath)
  } catch {
    if (!$process.HasExited) { $process.Kill($true) }
    throw
  } finally {
    $process.Dispose()
  }
} finally {
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
  }
}
