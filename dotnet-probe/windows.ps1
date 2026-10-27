# Lists the top-level windows a process owns, and whether each one is visible.
param([int]$ProcessId)
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class ProbeWindows {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static List<string> For(uint target) {
    var found = new List<string>();
    EnumWindows((h, l) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner == target) {
        var title = new StringBuilder(512); GetWindowText(h, title, 512);
        var cls = new StringBuilder(256); GetClassName(h, cls, 256);
        found.Add(String.Format("visible={0} class={1} title={2}", IsWindowVisible(h), cls, title));
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
[ProbeWindows]::For([uint32]$ProcessId) | ForEach-Object { $_ }
