param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('instructions', 'schema')]
  [string]$Target
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exportScript = Join-Path $PSScriptRoot 'gpt-builder-export.mjs'
$tempFile = Join-Path ([System.IO.Path]::GetTempPath()) ("btcgpt-builder-{0}-{1}.txt" -f $Target, [Guid]::NewGuid().ToString('N'))

try {
  Push-Location $root
  & node $exportScript $Target "--output=$tempFile"
  if ($LASTEXITCODE -ne 0) {
    throw "GPT Builder export failed with exit code $LASTEXITCODE"
  }

  $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
  $text = [System.IO.File]::ReadAllText($tempFile, $utf8)
  if ($text.Contains([char]0xFFFD)) {
    throw 'Export contains Unicode replacement characters; clipboard was not changed.'
  }

  Set-Clipboard -Value $text
  Write-Host ("Copied GPT Builder {0} to clipboard using explicit UTF-8 decoding." -f $Target)
}
finally {
  Pop-Location
  if (Test-Path $tempFile) {
    Remove-Item $tempFile -Force
  }
}
