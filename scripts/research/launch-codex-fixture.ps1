param([Parameter(Mandatory = $true)][string]$PromptPath)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Join-Path $PSScriptRoot '../..')
$promptText = [IO.File]::ReadAllText($PromptPath).Trim()
# A normal interactive Codex, constrained to read-only for this explicitly invoked test.
# No wrapper, PTY proxy or injected terminal output is involved.
codex --sandbox read-only --ask-for-approval on-request $promptText
