param(
    [Parameter(Mandatory = $true)][string]$WindowTitle,
    [string]$ManifestPath = 'test-results/wt-overlay-formula.json',
    [string]$LogPath = 'test-results/wt-overlay-probe.json',
    [string]$StopPath = '.cache/research/wt-overlay-stop.txt',
    [int]$MaxSeconds = 240
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Windows.Forms, System.Drawing, System.Web.Extensions
$references = @(
    [System.Windows.Automation.AutomationElement].Assembly.Location,
    [System.Windows.Automation.AutomationIdentifier].Assembly.Location,
    [System.Windows.Rect].Assembly.Location,
    [System.Windows.Forms.Form].Assembly.Location,
    [System.Drawing.Image].Assembly.Location,
    [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location
)
Add-Type -Path "$PSScriptRoot/WindowsTerminalOverlayProbe.cs" -ReferencedAssemblies $references
[WindowsTerminalOverlayProbe]::Run($WindowTitle, [IO.Path]::GetFullPath($ManifestPath),
    [IO.Path]::GetFullPath($LogPath), [IO.Path]::GetFullPath($StopPath), $MaxSeconds)
