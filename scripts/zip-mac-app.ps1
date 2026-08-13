# Zip a built .app directory with correct Unix permission bits (macOS distribution format).
# Usage: powershell -File scripts/zip-mac-app.ps1 -AppDir <path-to-app> -OutZip <out.zip>
#
# Native Windows zip tools do not write Unix modes, so after macOS extraction the
# binaries would lose their executable bit and the app would not start. This script
# uses .NET ZipArchive ExternalAttributes to write standard unix permissions
# (dir 0755, executable 0755, data 0644); Archive Utility / unzip on macOS
# restore them faithfully.
param(
  [Parameter(Mandatory = $true)][string]$AppDir,
  [Parameter(Mandatory = $true)][string]$OutZip
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# .NET APIs resolve relative paths against the process CWD (not the PS location),
# so normalize to absolute paths up front.
$OutZip = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutZip)
$appDir = (Resolve-Path -LiteralPath $AppDir).Path
$root = Split-Path $appDir -Parent
if (Test-Path -LiteralPath $OutZip) { Remove-Item -LiteralPath $OutZip -Force }

$modeDir = [int]([Convert]::ToInt32('40755', 8))
$modeExec = [int]([Convert]::ToInt32('100755', 8))
$modeData = [int]([Convert]::ToInt32('100644', 8))

$files = Get-ChildItem -LiteralPath $appDir -Recurse -Force
Write-Host ("Packing {0} entries -> {1}" -f $files.Count, $OutZip)

$zip = [System.IO.Compression.ZipFile]::Open($OutZip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
    if ($f.PSIsContainer) {
      $mode = $modeDir
    } else {
      $ext = [System.IO.Path]::GetExtension($f.Name).ToLowerInvariant()
      $noExt = $ext -eq ''
      $isExec =
        ($rel -match '(^|/)Contents/MacOS/') -or
        ($ext -in @('.dylib', '.node', '.so', '.a')) -or
        ($f.Name -in @('node', 'rg')) -or
        ($noExt -and $rel -match '\.framework/')
      if ($isExec) { $mode = $modeExec } else { $mode = $modeData }
    }
    $entry = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
    # ExternalAttributes is Int32; unix mode sits in the high 16 bits, so the
    # bit pattern exceeds Int32.MaxValue. PowerShell casts are checked, so
    # reinterpret the raw bytes instead.
    $bits = ([uint32]$mode) -shl 16
    $entry.ExternalAttributes = [BitConverter]::ToInt32([BitConverter]::GetBytes($bits), 0)
    if (-not $f.PSIsContainer) {
      $in = [System.IO.File]::OpenRead($f.FullName)
      try {
        $out = $entry.Open()
        try { $in.CopyTo($out) } finally { $out.Dispose() }
      } finally {
        $in.Dispose()
      }
    }
  }
} finally {
  $zip.Dispose()
}

$sizeMb = [math]::Round((Get-Item -LiteralPath $OutZip).Length / 1MB, 1)
Write-Host ("Done: {0} ({1} MB)" -f $OutZip, $sizeMb)
