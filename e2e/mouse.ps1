# The real mouse, for the end-to-end tests (Windows): moves the system cursor and presses
# the left button as a person would, so the pet sees what it sees on a desktop (its window
# lets clicks through except over the pet; the cursor comes from the OS). Reads one command
# per line on stdin and answers each with one line; e2e/harness.mjs (Mouse) drives it.
#   move X Y     cursor to physical screen px X, Y            -> ok
#   down / up    left button                                   -> ok
#   pos          where the cursor is                           -> X Y
#   minimize T   minimizes the window titled T                 -> ok
#   restore T    shows it again                                -> ok
Add-Type -Namespace Win32 -Name Input -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr FindWindow(string cls, string title);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int cmd);
public struct POINT { public int X; public int Y; }
"@
# Physical pixels, as the app measures them.
[Win32.Input]::SetProcessDPIAware() | Out-Null
$LEFTDOWN = 0x0002
$LEFTUP = 0x0004

function Answer($text) {
  [Console]::Out.WriteLine($text)
  [Console]::Out.Flush()
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $a = $line.Trim() -split ' ', 2
  try {
    switch ($a[0]) {
      'move' {
        $xy = $a[1] -split ' '
        if (-not [Win32.Input]::SetCursorPos([int]$xy[0], [int]$xy[1])) { throw "SetCursorPos failed" }
        Answer 'ok'
      }
      'down' { [Win32.Input]::mouse_event($LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero); Answer 'ok' }
      'up' { [Win32.Input]::mouse_event($LEFTUP, 0, 0, 0, [UIntPtr]::Zero); Answer 'ok' }
      'pos' {
        $p = New-Object Win32.Input+POINT
        [Win32.Input]::GetCursorPos([ref]$p) | Out-Null
        Answer "$($p.X) $($p.Y)"
      }
      { $_ -in 'minimize', 'restore' } {
        # [NullString]: a plain $null would be passed as "" (a class named "").
        $h = [Win32.Input]::FindWindow([NullString]::Value, $a[1])
        if ($h -eq [IntPtr]::Zero) { throw "no window titled $($a[1])" }
        # SW_MINIMIZE 6, SW_RESTORE 9
        [Win32.Input]::ShowWindow($h, $(if ($a[0] -eq 'minimize') { 6 } else { 9 })) | Out-Null
        Answer 'ok'
      }
      default { Answer "error: unknown command $($a[0])" }
    }
  } catch {
    Answer "error: $_"
  }
}
