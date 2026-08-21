# Append the sound2text composition row to the web profile's cordis.patch.yml.
# Handles the fresh-profile `[]` placeholder and is idempotent.
$ErrorActionPreference = 'Stop'
$p = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'
$frag = Get-Content -Raw (Join-Path $PSScriptRoot '..\cordis.patch.fragment.yml')
if (-not (Test-Path $p)) { throw "profile patch not found: $p (run dsh web once first)" }
$t = [IO.File]::ReadAllText($p)
$t = $t -replace '(?m)^\s*\[\]\s*$', ''
if ($t -notmatch 'dsh-sound2text') {
    $t = $t.TrimEnd() + "`n`n" + $frag.TrimEnd() + "`n"
    [IO.File]::WriteAllText($p, $t)
    Write-Host "patched: $p"
} else {
    Write-Host "already patched: $p"
}
