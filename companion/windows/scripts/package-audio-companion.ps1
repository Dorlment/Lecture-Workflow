param(
    [string] $OutputDirectory = 'release-artifacts'
)

$ErrorActionPreference = 'Stop'
$windowsRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $windowsRoot '../..')).Path
$manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'manifest.json') -Raw | ConvertFrom-Json
$archiveName = "lecture-workflow-windows-helper-win-x64-v$($manifest.version).zip"
$destination = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
    [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))
}
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("lecture-workflow-release-" + [guid]::NewGuid().ToString('N'))

try {
    $publish = Join-Path $stage 'publish'
    $packageRoot = Join-Path $stage 'package'
    $helperDirectory = Join-Path $packageRoot 'companion/windows'
    New-Item -ItemType Directory -Path $publish, $helperDirectory -Force | Out-Null
    $project = Join-Path $windowsRoot 'src/LectureWorkflow.AudioCompanion.Windows/LectureWorkflow.AudioCompanion.Windows.csproj'
    & dotnet publish $project -c Release -r win-x64 --self-contained true --output $publish
    if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed' }

    foreach ($file in @(
        'LectureWorkflow.AudioCompanion.Windows.exe',
        'LectureWorkflow.AudioCompanion.Windows.dll',
        'LectureWorkflow.AudioCompanion.Core.dll',
        'LectureWorkflow.AudioCompanion.Protocol.dll',
        'LectureWorkflow.AudioCompanion.Windows.deps.json',
        'LectureWorkflow.AudioCompanion.Windows.runtimeconfig.json',
        'NAudio.Core.dll',
        'NAudio.Wasapi.dll',
        'hostfxr.dll',
        'System.Private.CoreLib.dll'
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $publish $file) -PathType Leaf)) {
            throw "Published helper is incomplete: $file"
        }
    }

    Get-ChildItem -LiteralPath $publish -Force | Where-Object {
        $_.Name -notmatch '\.(?:pdb|log|tmp|temp)$'
    } | Copy-Item -Destination $helperDirectory -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $windowsRoot 'THIRD_PARTY_NOTICES.txt') -Destination $helperDirectory
    $dotnetDirectory = Split-Path -Parent (Get-Command dotnet -ErrorAction Stop).Source
    foreach ($notice in @(
        @{ Source = 'LICENSE.txt'; Destination = 'DOTNET_LICENSE.txt' },
        @{ Source = 'ThirdPartyNotices.txt'; Destination = 'DOTNET_THIRD_PARTY_NOTICES.txt' }
    )) {
        $source = Join-Path $dotnetDirectory $notice.Source
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Missing .NET distribution notice: $($notice.Source)"
        }
        Copy-Item -LiteralPath $source -Destination (Join-Path $helperDirectory $notice.Destination)
    }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    $archive = Join-Path $destination $archiveName
    Compress-Archive -Path (Join-Path $packageRoot 'companion') -DestinationPath $archive -Force
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath "$archive.sha256" -Value "$hash  $archiveName" -Encoding ascii
    Write-Output "Archive: $archive"
    Write-Output "SHA-256: $hash"
} finally {
    if ((Test-Path -LiteralPath $stage) -and
        $stage.StartsWith([System.IO.Path]::GetTempPath(), [System.StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $stage) -like 'lecture-workflow-release-*') {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
