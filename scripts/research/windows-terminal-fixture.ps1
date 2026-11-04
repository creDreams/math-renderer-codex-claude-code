param([Parameter(Mandatory = $true)][string]$ControlPath, [string]$RunId = '')

# Disposable synthetic terminal content, not an agent or a PTY wrapper.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class MathFixtureInput {
    [StructLayout(LayoutKind.Explicit, Size = 20, CharSet = CharSet.Unicode)] struct Record {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(4)] public int Down;
        [FieldOffset(10)] public ushort Key;
        [FieldOffset(14)] public char Character;
        [FieldOffset(16)] public uint Modifiers;
    }
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll", EntryPoint="PeekConsoleInputW")] static extern bool Peek(IntPtr input, out Record record, uint length, out uint read);
    [DllImport("kernel32.dll", EntryPoint="ReadConsoleInputW")] static extern bool Read(IntPtr input, out Record record, uint length, out uint read);
    public static ConsoleKeyInfo[] Available() {
        var keys = new List<ConsoleKeyInfo>();
        var input = GetStdHandle(-10);
        Record record; uint count;
        for (int i = 0; i < 256 && Peek(input, out record, 1, out count) && count != 0; i++) {
            if (!Read(input, out record, 1, out count) || count == 0) break;
            if (record.Type == 1 && record.Down != 0)
                keys.Add(new ConsoleKeyInfo(record.Character, (ConsoleKey)record.Key,
                    (record.Modifiers & 16) != 0, (record.Modifiers & 12) != 0, (record.Modifiers & 3) != 0));
        }
        return keys.ToArray();
    }
}
'@
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$esc = [char]27
$bullet = [char]0x2022
$prompt = [char]0x203A
$unicode = ([string][char]0x4E2D) + [char]0x6587
$last = ''
$typed = ''
$cursor = 0
try {
    while ($true) {
        try { $phase = if (Test-Path -LiteralPath $ControlPath) { [IO.File]::ReadAllText($ControlPath).Trim() } else { 'normal' } }
        catch [IO.IOException] { Start-Sleep -Milliseconds 30; continue }
        if ($phase -eq 'exit') { break }
        if ($phase -ne $last) {
            if ($phase -eq 'alternate') { [Console]::Write("$esc[?1049h") }
            if ($last -eq 'alternate') { [Console]::Write("$esc[?1049l") }
            [Console]::Write("$esc[2J$esc[H")
            if ($phase -eq 'approval') {
                [Console]::Write("Allow this command?`r`n  echo \\[ x^2 \\]`r`n$prompt 1. Allow once`r`n  2. Deny`r`n")
            } else {
                $second = if ($phase -eq 'multiple') { "  \[`r`n  x^2+y^2=z^2`r`n  \]`r`n" } else { '' }
                $runLabel = if ($RunId) { " [$RunId]" } else { '' }
                [Console]::Write("$bullet Formula display research ($phase)$runLabel, $unicode and regular text.`r`n  \[`r`n  \max_q \left\{ \mathbb E_{a\sim q}[\widehat Q(s,a)]`r`n  - \eta\,\mathrm{KL}(q\|q_{\mathrm{prior}}) \right\}.`r`n  \]`r`n${second}  This is a complete synthetic assistant message.`r`n`r`n  Worked for 6s $bullet 02:31`r`n`r`n$prompt Ask a question ")
            }
            if ($phase -eq 'scrolled') {
                for ($index = 0; $index -lt 60; $index++) { [Console]::Write("filler $index`r`n") }
            }
            $last = $phase
            $typed = ''; $cursor = 0
        }
        # Console.ReadKey can block after focus/mouse records even if
        # KeyAvailable was true. Drain only already queued input records.
        foreach ($key in [MathFixtureInput]::Available()) {
            if ($key.Key -eq 'Backspace' -and $cursor -gt 0) {
                $typed = $typed.Remove($cursor - 1, 1); $cursor--
            } elseif ($key.Key -eq 'LeftArrow') { $cursor = [Math]::Max(0, $cursor - 1)
            } elseif ($key.Key -eq 'RightArrow') { $cursor = [Math]::Min($typed.Length, $cursor + 1)
            } elseif (-not [char]::IsControl($key.KeyChar)) {
                $typed = $typed.Insert($cursor, [string]$key.KeyChar); $cursor++
            }
            [Console]::Write("`r$esc[2K$prompt Ask a question $typed")
            if ($cursor -lt $typed.Length) { [Console]::Write("$esc[$($typed.Length - $cursor)D") }
        }
        Start-Sleep -Milliseconds 100
    }
} finally {
    [Console]::Write("$esc[?1049l")
}
