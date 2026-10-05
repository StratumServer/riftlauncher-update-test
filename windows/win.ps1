# Windows probes for driver.mjs. Every action prints one JSON document on stdout, except that
# watch keeps looping (screenshots, visible windows, update-related processes every 2 s) until its
# stop file appears, and writes into a folder instead.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File win.ps1 -Action <action> [-Target ..] [-Name ..]
#
#   shot    -Target <png>                 capture the whole desktop
#   windows                               visible top-level windows
#   procs                                 launcher, installer, uninstaller and running-app-check processes
#   reg                                   the launcher's uninstall and install registry entries
#   ver     -Target <exe>                 version resource, size and hash of a file
#   uia     -Target <pid>                 controls of every top-level window of one process
#   invoke  -Target <pid> -Name <button>  press one installer button: Next >, Install or Finish only
#   close   -Target <pid>                 send WM_CLOSE to that process's visible top-level windows
#   watch   -Target <folder> -Name <stop file>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("shot", "windows", "procs", "reg", "ver", "uia", "invoke", "close", "watch")]
  [string]$Action,
  [string]$Target = "",
  [string]$Name = ""
)

$ErrorActionPreference = "Stop"

# Compiled only by the actions that need it (windows, close, watch): each compile costs a second or two.
$NativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class RlutWindow
{
    public long Hwnd { get; set; }
    public uint Pid { get; set; }
    public string Process { get; set; }
    public string Class { get; set; }
    public string Title { get; set; }
    public int Left { get; set; }
    public int Top { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public bool Owned { get; set; }
}

public static class RlutWin
{
    private delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    private const uint GW_OWNER = 4;
    private const uint WM_CLOSE = 0x0010;

    public static List<RlutWindow> Visible()
    {
        var list = new List<RlutWindow>();
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            var title = new StringBuilder(512);
            GetWindowText(h, title, title.Capacity);
            var cls = new StringBuilder(256);
            GetClassName(h, cls, cls.Capacity);
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            Rect r;
            GetWindowRect(h, out r);
            string name = "";
            try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
            list.Add(new RlutWindow
            {
                Hwnd = h.ToInt64(), Pid = pid, Process = name, Class = cls.ToString(), Title = title.ToString(),
                Left = r.Left, Top = r.Top, Width = r.Right - r.Left, Height = r.Bottom - r.Top,
                Owned = GetWindow(h, GW_OWNER) != IntPtr.Zero
            });
            return true;
        }, IntPtr.Zero);
        return list;
    }

    // The message a window's own close button ends in, sent to every visible unowned top-level
    // window of one process. Never a kill.
    public static int Close(uint pid)
    {
        int sent = 0;
        foreach (var w in Visible())
        {
            if (w.Pid != pid || w.Owned) continue;
            if (PostMessage(new IntPtr(w.Hwnd), WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) sent++;
        }
        return sent;
    }
}
'@

function Use-Native { if (-not ("RlutWin" -as [type])) { Add-Type -TypeDefinition $NativeSource } }

function Out-Json($Value) { ConvertTo-Json -InputObject $Value -Depth 8 -Compress }

function Save-Shot([string]$Path) {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  return "$($bounds.Width)x$($bounds.Height)"
}

# The launcher (installed exe and its helpers), the downloaded installer, the old version's
# uninstaller (NSIS runs it as Un_A.exe from a temp folder), and the PowerShell one-liners the
# installer's running-app check spawns (they are the only ones calling Path.StartsWith).
function Get-Procs {
  $all = Get-CimInstance Win32_Process
  foreach ($p in $all) {
    $hit = ($p.Name -match '(?i)riftlauncher|^un_[a-z]\.exe$') -or
      ($p.ExecutablePath -match '(?i)\\riftlauncher-updater\\|\\Programs\\RiftLauncher\\') -or
      ($p.Name -eq 'powershell.exe' -and $p.CommandLine -and $p.CommandLine.Contains('StartsWith('))
    if (-not $hit) { continue }
    [ordered]@{
      pid = [int]$p.ProcessId
      ppid = [int]$p.ParentProcessId
      name = $p.Name
      path = $p.ExecutablePath
      cmd = $p.CommandLine
      created = if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString("o") } else { $null }
    }
  }
}

function Read-Key([string]$Path) {
  try {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $props = Get-ItemProperty -LiteralPath $Path
    $out = [ordered]@{}
    foreach ($prop in $props.PSObject.Properties) {
      if ($prop.Name -notlike 'PS*') { $out[$prop.Name] = $prop.Value }
    }
    return $out
  } catch {
    return [ordered]@{ error = $_.Exception.Message }
  }
}

function Get-UiaWindows([int]$ProcessId) {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $ae = [System.Windows.Automation.AutomationElement]
  $condition = New-Object System.Windows.Automation.PropertyCondition($ae::ProcessIdProperty, $ProcessId)
  $windows = $ae::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  foreach ($w in $windows) {
    $items = New-Object System.Collections.Generic.List[object]
    $all = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($e in $all) {
      $c = $e.Current
      if ([string]::IsNullOrWhiteSpace($c.Name)) { continue }
      $state = $null
      $pattern = $null
      if ($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
        $state = $pattern.Current.ToggleState.ToString()
      } elseif ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        $state = if ($pattern.Current.IsSelected) { "Selected" } else { "NotSelected" }
      }
      $items.Add([ordered]@{
        type = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', '')
        name = $c.Name
        enabled = $c.IsEnabled
        offscreen = $c.IsOffscreen
        state = $state
      })
    }
    [ordered]@{ title = $w.Current.Name; cls = $w.Current.ClassName; hwnd = $w.Current.NativeWindowHandle; items = $items.ToArray() }
  }
}

switch ($Action) {
  "shot" {
    Out-Json ([ordered]@{ path = $Target; screen = (Save-Shot $Target) })
  }
  "windows" {
    Use-Native
    Out-Json @([RlutWin]::Visible() | Where-Object { $_.Title -ne "" })
  }
  "procs" {
    Out-Json @(Get-Procs)
  }
  "reg" {
    $uninstall = New-Object System.Collections.Generic.List[object]
    $install = New-Object System.Collections.Generic.List[object]
    $machine = New-Object System.Collections.Generic.List[object]
    foreach ($k in @(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue)) {
      $v = Read-Key $k.PSPath
      if ($v -and "$($v['DisplayName'])" -like 'RiftLauncher*') {
        $uninstall.Add([ordered]@{ key = $k.PSChildName; values = $v })
        $install.Add([ordered]@{ key = "HKCU\Software\$($k.PSChildName)"; values = (Read-Key "HKCU:\Software\$($k.PSChildName)") })
      }
    }
    foreach ($root in @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
      foreach ($k in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
        $v = Read-Key $k.PSPath
        if ($v -and "$($v['DisplayName'])" -like 'RiftLauncher*') { $machine.Add([ordered]@{ key = "$root\$($k.PSChildName)"; values = $v }) }
      }
    }
    Out-Json ([ordered]@{ hkcuUninstall = $uninstall.ToArray(); hkcuInstall = $install.ToArray(); hklmUninstall = $machine.ToArray() })
  }
  "ver" {
    if (-not (Test-Path -LiteralPath $Target)) {
      Out-Json ([ordered]@{ path = $Target; exists = $false })
      break
    }
    $item = Get-Item -LiteralPath $Target
    $vi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($item.FullName)
    Out-Json ([ordered]@{
      path = $item.FullName
      exists = $true
      length = $item.Length
      lastWriteUtc = $item.LastWriteTimeUtc.ToString("o")
      productVersion = $vi.ProductVersion
      fileVersion = $vi.FileVersion
      productName = $vi.ProductName
      fileDescription = $vi.FileDescription
      sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
    })
  }
  "uia" {
    Out-Json @(Get-UiaWindows ([int]$Target))
  }
  "invoke" {
    # The installer's own forward buttons, the ones a player presses to get through it. Never Back,
    # Cancel, a radio button or a checkbox: the page is left exactly as the installer set it up.
    $allowed = @("Next >", "Install", "Finish")
    if ($allowed -notcontains $Name) { throw "refusing to press '$Name': only $($allowed -join ', ') may be pressed" }
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $ae = [System.Windows.Automation.AutomationElement]
    $condition = New-Object System.Windows.Automation.PropertyCondition($ae::ProcessIdProperty, [int]$Target)
    $pressed = $null
    foreach ($w in $ae::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)) {
      $buttonCondition = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
      foreach ($b in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)) {
        if (($b.Current.Name -replace '&', '') -ne $Name -or -not $b.Current.IsEnabled -or $b.Current.IsOffscreen) { continue }
        $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $pressed = [ordered]@{ window = $w.Current.Name; button = $b.Current.Name }
        break
      }
      if ($pressed) { break }
    }
    Out-Json ([ordered]@{ invoked = [bool]$pressed; pressed = $pressed })
  }
  "close" {
    Use-Native
    Out-Json ([ordered]@{ pid = [int]$Target; closeMessagesSent = [RlutWin]::Close([uint32]$Target) })
  }
  "watch" {
    Use-Native
    $outDir = $Target
    $stopFile = $Name
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    $logFile = Join-Path $outDir "watch.jsonl"
    $deadline = (Get-Date).AddMinutes(10)
    $n = 0
    $last = ""
    while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $stopFile)) {
      try {
        $now = (Get-Date).ToUniversalTime().ToString("o")
        $wins = @([RlutWin]::Visible() | Where-Object { $_.Title -ne "" } | ForEach-Object { "{0}|{1}|{2}|{3}|{4},{5},{6}x{7}" -f $_.Pid, $_.Process, $_.Class, $_.Title, $_.Left, $_.Top, $_.Width, $_.Height })
        $procs = @(Get-Procs | ForEach-Object { "{0}<{1}|{2}|{3}" -f $_.pid, $_.ppid, $_.name, $_.cmd })
        $signature = ($wins + $procs) -join "`n"
        $shot = $null
        if ($signature -ne $last -or ($n % 5) -eq 0) {
          $shot = "{0:D3}.png" -f $n
          try { [void](Save-Shot (Join-Path $outDir $shot)) } catch { $shot = "failed: $($_.Exception.Message)" }
        }
        [System.IO.File]::AppendAllText($logFile, (Out-Json ([ordered]@{ t = $now; shot = $shot; windows = $wins; procs = $procs })) + "`n")
        $last = $signature
      } catch {
        [System.IO.File]::AppendAllText($logFile, (Out-Json ([ordered]@{ t = (Get-Date).ToUniversalTime().ToString("o"); error = $_.Exception.Message })) + "`n")
      }
      $n++
      Start-Sleep -Milliseconds 2000
    }
    Out-Json ([ordered]@{ ticks = $n })
  }
}
