# An ordinary desktop window for the end-to-end tests (Windows), for the pet to stand on:
# a plain form at X, Y (physical px) of W x H, titled -Title, until the process is ended.
param(
  [int]$X = 400,
  [int]$Y = 500,
  [int]$W = 600,
  [int]$H = 400,
  [string]$Title = "ePet test window"
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace Win32 -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[Win32.Dpi]::SetProcessDPIAware() | Out-Null
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.Size = New-Object System.Drawing.Size($W, $H)
$form.ShowInTaskbar = $true
[System.Windows.Forms.Application]::Run($form)
