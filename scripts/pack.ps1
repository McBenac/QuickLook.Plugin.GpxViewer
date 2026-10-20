# Packs bin\Release into QuickLook.Plugin.GpxViewer.qlplugin (a zip QuickLook installs on Space).
# Run with PowerShell 7 (pwsh): Windows PowerShell 5.1 writes backslashes into zip entry names.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'QuickLook.Plugin.GpxViewer.qlplugin'
$zip = [IO.Path]::ChangeExtension($out, '.zip')
Remove-Item $out, $zip -ErrorAction SilentlyContinue
$release = Join-Path $root 'bin\Release'
$staging = Join-Path $root 'obj\pack'
Remove-Item $staging -Recurse -ErrorAction SilentlyContinue
Copy-Item $release $staging -Recurse
Get-ChildItem $staging -Recurse -File | Where-Object Extension -in '.pdb', '.xml' | Remove-Item
Get-ChildItem $staging -Recurse -File -Filter *.deps.json | Remove-Item
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip
Move-Item $zip $out
Get-Item $out | Select-Object Name, Length
