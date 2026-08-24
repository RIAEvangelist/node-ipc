param(
    [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$project = Join-Path $PSScriptRoot 'src/NodeIpc/NodeIpc.csproj'
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$temporaryRoot = Join-Path $temporaryBase ('node-ipc-csharp-package-' + [Guid]::NewGuid().ToString('N'))
$packageDirectory = if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    Join-Path $temporaryRoot 'package'
}
else {
    [IO.Path]::GetFullPath($OutputDirectory)
}
$consumerDirectory = Join-Path $temporaryRoot 'consumer'
$packagesCache = Join-Path $temporaryRoot 'nuget-cache'

New-Item -ItemType Directory -Path $packageDirectory -Force | Out-Null
try {
    Set-Location -LiteralPath $PSScriptRoot
    & dotnet pack $project -c Release --nologo -o $packageDirectory
    if ($LASTEXITCODE -ne 0) { throw 'dotnet pack failed' }

    $packages = @(Get-ChildItem -LiteralPath $packageDirectory -Filter 'node-ipc.14.0.0.nupkg')
    if ($packages.Count -ne 1) { throw "Expected one node-ipc.14.0.0.nupkg, found $($packages.Count)." }
    $package = $packages[0]
    if ($package.Length -le 0) { throw 'The NuGet package is empty.' }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($package.FullName)
    try {
        $entries = @($archive.Entries | ForEach-Object FullName)
        $required = @(
            'node-ipc.nuspec',
            'lib/net8.0/NodeIpc.dll',
            'lib/net8.0/NodeIpc.xml',
            'README.md',
            'licence'
        )
        foreach ($entry in $required) {
            if ($entries -notcontains $entry) { throw "NuGet package is missing $entry." }
        }
        if ($entries | Where-Object { $_ -match '(^|/)(tests|interop|examples|bin|obj)/' }) {
            throw 'Repository-only tests, interop, examples, or build output entered the NuGet package.'
        }
    }
    finally {
        $archive.Dispose()
    }

    & dotnet new console --framework net8.0 --output $consumerDirectory --no-restore
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create the package consumer.' }
    $program = @'
using System.Text;
using NodeIpc;

var frame = new FastParser().encode("package", new { ok = true });
var wire = Encoding.UTF8.GetString(frame);
if (wire != "{\"type\":\"package\",\"data\":{\"ok\":true}}\f")
{
    throw new InvalidOperationException($"Unexpected package wire output: {wire}");
}
Console.WriteLine("PASS NuGet consumer");
'@
    [IO.File]::WriteAllText((Join-Path $consumerDirectory 'Program.cs'), $program, [Text.UTF8Encoding]::new($false))
    $env:NUGET_PACKAGES = $packagesCache
    & dotnet add (Join-Path $consumerDirectory 'consumer.csproj') package node-ipc --version 14.0.0 --source $packageDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Unable to restore the packed node-ipc package.' }
    & dotnet run --project (Join-Path $consumerDirectory 'consumer.csproj') -c Release --nologo
    if ($LASTEXITCODE -ne 0) { throw 'The packed-package consumer failed.' }

    $hash = (Get-FileHash -LiteralPath $package.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifest = Join-Path $packageDirectory ($package.Name + '.sha256')
    [IO.File]::WriteAllText(
        $manifest,
        "$hash  $($package.Name)`n",
        [Text.UTF8Encoding]::new($false)
    )
    Write-Output "PASS node-ipc.14.0.0.nupkg $hash"
}
finally {
    $resolvedTemporary = [IO.Path]::GetFullPath($temporaryRoot)
    if (!$resolvedTemporary.StartsWith($temporaryBase, [StringComparison]::OrdinalIgnoreCase) -or
        ![IO.Path]::GetFileName($resolvedTemporary).StartsWith('node-ipc-csharp-package-', [StringComparison]::Ordinal)) {
        throw "Refusing to remove unexpected temporary path: $resolvedTemporary"
    }
    if (Test-Path -LiteralPath $resolvedTemporary) {
        Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
    }
    Set-Location -LiteralPath $repositoryRoot
}
