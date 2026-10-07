# Runs an ePet installer through its pages as a person would, pressing Next / Install /
# Finish, and writes what each page said to a JSON file (e2e/upgrade.test.mjs checks that an
# upgrade asks nothing). Windows only.
param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Minutes = 5
)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace Win32 -Name User32 -MemberDefinition @"
[DllImport("user32.dll")] public static extern System.IntPtr SendMessage(System.IntPtr hWnd, uint msg, System.IntPtr w, System.IntPtr l);
"@
$BM_CLICK = 0x00F5
$A = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]

$p = Start-Process -FilePath $Setup -PassThru
$pages = New-Object System.Collections.Generic.List[string]
$errors = New-Object System.Collections.Generic.List[string]
$deadline = (Get-Date).AddMinutes($Minutes)
while (-not $p.HasExited -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 800
  try {
    $cond = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $p.Id)
    # Its windows: the wizard, or a message box over it.
    foreach ($win in $A::RootElement.FindAll($scope::Children, $cond)) {
      $all = $win.FindAll($scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $texts = @($all | ForEach-Object { $_.Current.Name } | Where-Object { $_ -and $_.Trim() })
      $page = ($texts -join " | ")
      if ($pages.Count -eq 0 -or $pages[$pages.Count - 1] -ne $page) { $pages.Add($page) }
      $button = $all | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
        $_.Current.IsEnabled -and $_.Current.Name -match '^(&?Next|&?Install|&?Finish|OK|&?Yes)'
      } | Select-Object -First 1
      if ($button) {
        # A real click on the button (BM_CLICK), as a mouse would; UI Automation's Invoke
        # doesn't reach NSIS's buttons from a service session.
        $hwnd = [System.IntPtr]$button.Current.NativeWindowHandle
        if ($hwnd -ne [System.IntPtr]::Zero) {
          [Win32.User32]::SendMessage($hwnd, $BM_CLICK, [System.IntPtr]::Zero, [System.IntPtr]::Zero) | Out-Null
        } else {
          $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        }
      }
    }
  } catch {
    # The window changed under us; look again (kept for the report).
    if ($errors.Count -lt 20) { $errors.Add("$_") }
  }
}
$timedOut = -not $p.HasExited
if ($timedOut) { Stop-Process -Id $p.Id -Force }
@{ exitCode = $(if ($timedOut) { -1 } else { $p.ExitCode }); timedOut = $timedOut; pages = $pages; errors = $errors } |
  ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $Out
