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
[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr hWnd, uint msg, System.IntPtr w, System.IntPtr l);
[DllImport("user32.dll")] public static extern System.IntPtr GetParent(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern int GetDlgCtrlID(System.IntPtr hWnd);
"@
$WM_COMMAND = 0x0111
$A = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]

$p = Start-Process -FilePath $Setup -PassThru
$pages = New-Object System.Collections.Generic.List[string]
$errors = New-Object System.Collections.Generic.List[string]
$clicks = New-Object System.Collections.Generic.List[string]
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
        # What a click does in a dialog: WM_COMMAND (BN_CLICKED) to the button's parent with
        # its id. Neither UI Automation's Invoke nor BM_CLICK reached NSIS's buttons on CI.
        $hwnd = [System.IntPtr]$button.Current.NativeWindowHandle
        if ($hwnd -ne [System.IntPtr]::Zero) {
          $id = [Win32.User32]::GetDlgCtrlID($hwnd)
          [Win32.User32]::PostMessage([Win32.User32]::GetParent($hwnd), $WM_COMMAND, [System.IntPtr]$id, $hwnd) | Out-Null
        } else {
          $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        }
        $clicks.Add("$($button.Current.Name) (hwnd $hwnd)")
      } elseif ($errors.Count -lt 20) {
        $errors.Add("no button to press on: $page")
      }
    }
  } catch {
    # The window changed under us; look again (kept for the report).
    if ($errors.Count -lt 20) { $errors.Add("$_") }
  }
}
$timedOut = -not $p.HasExited
if ($timedOut) { Stop-Process -Id $p.Id -Force }
@{ exitCode = $(if ($timedOut) { -1 } else { $p.ExitCode }); timedOut = $timedOut; pages = $pages; clicks = $clicks; errors = $errors } |
  ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $Out
