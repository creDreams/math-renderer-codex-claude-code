param([string]$InputPath, [string]$ControlPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$data = [IO.File]::ReadAllText($InputPath) | ConvertFrom-Json
$last = ''
while ($true) {
    try { $phase = [IO.File]::ReadAllText($ControlPath).Trim() }
    catch [IO.IOException] { Start-Sleep -Milliseconds 20; continue }
    if ($phase -eq 'exit') { break }
    if ($phase -ne $last) {
        if ($phase.StartsWith('redraw-')) {
            foreach ($frame in $data.$phase) {
                [Console]::Write(([char]27) + '[2J' + ([char]27) + '[H' + [string]$frame)
                Start-Sleep -Milliseconds 160
            }
        } elseif ($phase -eq 'fixed' -or $phase -eq 'moving') {
            foreach ($chunk in $data.$phase) {
                [Console]::Write([string]$chunk)
                Start-Sleep -Milliseconds $(if ($phase -eq 'moving') { 80 } else { 35 })
            }
        } else {
            [Console]::Write(([char]27) + '[3J' + ([char]27) + '[2J' + ([char]27) + '[H' + [string]$data.$phase)
        }
        [IO.File]::WriteAllText($ControlPath + '.ready', $phase)
        $last = $phase
    }
    Start-Sleep -Milliseconds 20
}
