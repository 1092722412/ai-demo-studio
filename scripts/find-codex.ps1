$command = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($command) {
  Write-Output $command.Source
  exit 0
}

$package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Select-Object -First 1
if ($package) {
  $candidate = Join-Path $package.InstallLocation 'app\resources\codex.exe'
  if (Test-Path -LiteralPath $candidate -PathType Leaf) {
    Write-Output $candidate
    exit 0
  }
}

exit 1
