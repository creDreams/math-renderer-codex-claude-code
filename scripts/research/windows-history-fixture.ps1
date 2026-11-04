param([string]$InputPath,[string]$ControlPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$data = [IO.File]::ReadAllText($InputPath) | ConvertFrom-Json
$last = ''
while ($true) {
    try { $phase = [IO.File]::ReadAllText($ControlPath).Trim() }
    catch [IO.IOException] { Start-Sleep -Milliseconds 30; continue }
    if ($phase -eq 'exit') { break }
    if ($phase -ne $last) {
        $text = [string]$data.$phase
        if (-not $text) { throw 'Unknown fixture phase' }
        if (@($data.appendPhases) -contains $phase) { [Console]::Write($text) }
        else { [Console]::Write(([char]27) + '[3J' + ([char]27) + '[2J' + ([char]27) + '[H' + $text) }
        [IO.File]::WriteAllText($ControlPath + '.ready', $phase)
        $last = $phase
    }
    Start-Sleep -Milliseconds 100
}
