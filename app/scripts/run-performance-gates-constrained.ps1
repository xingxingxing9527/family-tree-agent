[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$applicationRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$affinityMask = [IntPtr]15
$jobMemoryLimitBytes = [UInt64](8192 * 1MB)
$requiredRelationshipDistribution = [ordered]@{
  direct = 30
  ancestor = 25
  collateral = 30
  cousin = 25
  affinity = 30
  multipath = 25
  conflict = 15
  missing = 20
}

function Get-Sha256Lower([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Get-Utf8Sha256Lower([string]$Text) {
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Text)
    return ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

# V8 old-space remains an inner guard. The Job Object is the authoritative
# 8 GiB boundary and covers native allocations and descendant processes.
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class FamilyAgentJobObject
{
    public const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    public sealed class Evidence
    {
        public uint LimitFlags;
        public ulong JobMemoryLimit;
        public ulong PeakProcessMemoryUsed;
        public ulong PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength,
        IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    private static Win32Exception LastError(string operation)
    {
        return new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    private static JOBOBJECT_EXTENDED_LIMIT_INFORMATION QueryRaw(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(), buffer, false);
            if (!QueryInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size, IntPtr.Zero))
                throw LastError("QueryInformationJobObject");
            return (JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(
                buffer,
                typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public static IntPtr CreateAndConfigure(ulong memoryLimitBytes)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw LastError("CreateJobObject");
        try
        {
            var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            information.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            information.JobMemoryLimit = new UIntPtr(memoryLimitBytes);
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(information, buffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size))
                    throw LastError("SetInformationJobObject");
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION observed = QueryRaw(job);
            uint required = JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if ((observed.BasicLimitInformation.LimitFlags & required) != required ||
                observed.JobMemoryLimit.ToUInt64() != memoryLimitBytes)
                throw new InvalidOperationException("Kernel did not retain the requested Job Object limits");
            return job;
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
    }

    public static void AssignAndVerify(IntPtr job, int processId)
    {
        using (Process process = Process.GetProcessById(processId))
        {
            if (!AssignProcessToJobObject(job, process.Handle))
                throw LastError("AssignProcessToJobObject");
            bool assigned;
            if (!IsProcessInJob(process.Handle, job, out assigned))
                throw LastError("IsProcessInJob");
            if (!assigned) throw new InvalidOperationException("Process was not assigned to the Job Object");
        }
    }

    public static Evidence Query(IntPtr job)
    {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION information = QueryRaw(job);
        return new Evidence {
            LimitFlags = information.BasicLimitInformation.LimitFlags,
            JobMemoryLimit = information.JobMemoryLimit.ToUInt64(),
            PeakProcessMemoryUsed = information.PeakProcessMemoryUsed.ToUInt64(),
            PeakJobMemoryUsed = information.PeakJobMemoryUsed.ToUInt64()
        };
    }

    public static void Release(IntPtr job)
    {
        if (job != IntPtr.Zero && !CloseHandle(job)) throw LastError("CloseHandle");
    }
}
"@

$environmentNames = @(
  "FAMILY_AGENT_PERF_LOGICAL_CORES",
  "FAMILY_AGENT_PERF_MEMORY_LIMIT_MB",
  "FAMILY_AGENT_PERF_AFFINITY_MASK",
  "FAMILY_AGENT_PERF_JOB_MEMORY_LIMIT_BYTES",
  "FAMILY_AGENT_PERF_JOB_LIMIT_FLAGS",
  "FAMILY_AGENT_PERF_JOB_LIMIT_VERIFIED",
  "FAMILY_AGENT_PERF_SOURCE_COMMIT"
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

$jobHandle = [IntPtr]::Zero
$process = $null
try {
  $jobHandle = [FamilyAgentJobObject]::CreateAndConfigure($jobMemoryLimitBytes)
  $configuredJob = [FamilyAgentJobObject]::Query($jobHandle)
  $requiredFlags = [FamilyAgentJobObject]::JOB_OBJECT_LIMIT_JOB_MEMORY -bor [FamilyAgentJobObject]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  if (($configuredJob.LimitFlags -band $requiredFlags) -ne $requiredFlags -or $configuredJob.JobMemoryLimit -ne $jobMemoryLimitBytes) {
    throw "Queried Job Object configuration does not match the requested 8 GiB cap"
  }
  $jobLimitFlagsText = "0x{0:x8}" -f [UInt32]$configuredJob.LimitFlags
  $sourceCommit = (& git -C $applicationRoot rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch "^[0-9a-f]{40}$") {
    throw "Unable to resolve the source commit for constrained performance evidence"
  }

  $env:FAMILY_AGENT_PERF_LOGICAL_CORES = "4"
  $env:FAMILY_AGENT_PERF_MEMORY_LIMIT_MB = "8192"
  $env:FAMILY_AGENT_PERF_AFFINITY_MASK = "0x0000000f"
  $env:FAMILY_AGENT_PERF_JOB_MEMORY_LIMIT_BYTES = [string]$configuredJob.JobMemoryLimit
  $env:FAMILY_AGENT_PERF_JOB_LIMIT_FLAGS = $jobLimitFlagsText
  $env:FAMILY_AGENT_PERF_JOB_LIMIT_VERIFIED = "true"
  $env:FAMILY_AGENT_PERF_SOURCE_COMMIT = $sourceCommit

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
  [FamilyAgentJobObject]::AssignAndVerify($jobHandle, $process.Id)
  $process.ProcessorAffinity = $affinityMask
  $process.Refresh()
  $observedAffinity = [int64]$process.ProcessorAffinity
  if ($observedAffinity -ne 15) {
    throw "Failed to enforce the four-logical-core affinity mask (observed $observedAffinity)"
  }
  Write-Host "[performance] constrained runner affinity=0x0000000f logicalCores=4 v8HeapLimitMb=6144 kernelJobLimitMb=8192"

  $process.WaitForExit()
  $process.Refresh()
  $childExitCode = $process.ExitCode
  $completedJob = [FamilyAgentJobObject]::Query($jobHandle)
  if ($childExitCode -ne 0) {
    throw "Constrained performance gate exited with code $childExitCode"
  }
  if ($completedJob.JobMemoryLimit -ne $jobMemoryLimitBytes -or $completedJob.PeakJobMemoryUsed -gt $jobMemoryLimitBytes) {
    throw "Constrained performance process exceeded or lost its kernel Job Object cap"
  }

  $reportPath = Join-Path $applicationRoot "release\reports\performance-report.json"
  if (!(Test-Path -LiteralPath $reportPath -PathType Leaf)) {
    throw "Constrained performance process did not write its report"
  }
  $reportFile = Get-Item -LiteralPath $reportPath
  $report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
  $generatedAtUtc = [DateTime]::Parse($report.generatedAt).ToUniversalTime()
  if ($reportFile.LastWriteTimeUtc -lt $startedAtUtc -or $generatedAtUtc -lt $startedAtUtc -or !$report.passed -or !$report.runtime.constraints.constrained) {
    throw "Constrained performance report is stale, failed, or lacks enforced constraints"
  }
  if ($report.source.commit -ne $sourceCommit -or !$report.source.digestSha256 -or !$report.source.files) {
    throw "Constrained performance report lacks matching source commit/digest evidence"
  }
  $sourceDigestInput = New-Object Text.StringBuilder
  foreach ($sourceFile in $report.source.files) {
    $resolvedSourceFile = [IO.Path]::GetFullPath((Join-Path $applicationRoot $sourceFile.path))
    $containedPrefix = $applicationRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (!$resolvedSourceFile.StartsWith($containedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Performance source evidence escaped the application root: $($sourceFile.path)"
    }
    $observedHash = Get-Sha256Lower $resolvedSourceFile
    if ($observedHash -ne $sourceFile.sha256) {
      throw "Performance source digest mismatch: $($sourceFile.path)"
    }
    [void]$sourceDigestInput.Append("$($sourceFile.path):$observedHash`n")
  }
  if ((Get-Utf8Sha256Lower $($sourceDigestInput.ToString())) -ne $report.source.digestSha256) {
    throw "Performance source tree digest does not match its verified file manifest"
  }
  foreach ($category in $requiredRelationshipDistribution.Keys) {
    if ([int]$report.workloads.relationships.$category -ne $requiredRelationshipDistribution[$category]) {
      throw "Performance workload count mismatch for $category"
    }
  }
  if (
    [int]$report.gates.defaultTreeAndLayout.sampleCount -ne 5 -or
    [int]$report.gates.viewpointRelabel.sampleCount -ne 5 -or
    [int]$report.gates.relationshipP95.sampleCount -ne 200 -or
    [int]$report.gates.importPreview.sampleCount -ne 3 -or
    $report.workloads.importPreview.formats.Count -ne 3
  ) {
    throw "Performance report sample counts do not match the fixed workload"
  }

  $report.runtime.constraints.kernelJob | Add-Member -NotePropertyName assignmentVerified -NotePropertyValue $true -Force
  $report.runtime.constraints.kernelJob | Add-Member -NotePropertyName peakJobMemoryUsedBytes -NotePropertyValue ([UInt64]$completedJob.PeakJobMemoryUsed) -Force
  $report.runtime.constraints.kernelJob | Add-Member -NotePropertyName peakProcessCommitBytes -NotePropertyValue ([UInt64]$completedJob.PeakProcessMemoryUsed) -Force
  $report.runtime.constraints.kernelJob | Add-Member -NotePropertyName withinLimit -NotePropertyValue $true -Force
  $report.runtime.constraints | Add-Member -NotePropertyName observedAffinityMask -NotePropertyValue "0x0000000f" -Force
  $report.runtime.constraints | Add-Member -NotePropertyName childExitCode -NotePropertyValue $childExitCode -Force
  $report.runtime.constraints | Add-Member -NotePropertyName wrapperValidatedAt -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force

  $json = $report | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($reportPath, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  Write-Output (Get-Content -Raw -LiteralPath $reportPath)
} catch {
  if ($null -ne $process -and !$process.HasExited) { $process.Kill($true) }
  throw
} finally {
  if ($null -ne $process) { $process.Dispose() }
  if ($jobHandle -ne [IntPtr]::Zero) { [FamilyAgentJobObject]::Release($jobHandle) }
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
  }
}
