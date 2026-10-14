param(
    [string]$ProcessName = "app",
    [string]$WindowTitle = "Swarm Desktop",
    [string]$OutputPath = "artifacts\spike_screenshots\tauri_spike_live_window.png"
)

Add-Type @'
using System;
using System.Text;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;

public class WinCapture {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern IntPtr GetDC(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);

    [DllImport("gdi32.dll")]
    public static extern bool BitBlt(IntPtr hdcDest, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hdcSrc, int nXSrc, int nYSrc, int dwRop);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public static IntPtr FindTargetHwnd(uint targetPid, string titleFilter) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == targetPid && IsWindowVisible(hWnd)) {
                StringBuilder sb = new StringBuilder(256);
                GetWindowText(hWnd, sb, 256);
                string title = sb.ToString();
                RECT rc;
                GetWindowRect(hWnd, out rc);
                int w = rc.Right - rc.Left;
                int h = rc.Bottom - rc.Top;
                if (w > 400 && h > 300) {
                    if (string.IsNullOrEmpty(titleFilter) || title.Contains(titleFilter)) {
                        found = hWnd;
                        return false; // stop enumeration
                    }
                }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static Bitmap Capture(IntPtr hwnd) {
        ShowWindow(hwnd, 9); // SW_RESTORE
        SetForegroundWindow(hwnd);
        Thread.Sleep(600);

        RECT rc;
        GetWindowRect(hwnd, out rc);
        int w = rc.Right - rc.Left;
        int h = rc.Bottom - rc.Top;
        if (w <= 0 || h <= 0) return null;

        Bitmap bmp = new Bitmap(w, h);
        using (Graphics g = Graphics.FromImage(bmp)) {
            IntPtr hdcDest = g.GetHdc();
            IntPtr hdcSrc = GetDC(IntPtr.Zero);
            try {
                // SRCCOPY = 0x00CC0020
                bool ok = BitBlt(hdcDest, 0, 0, w, h, hdcSrc, rc.Left, rc.Top, 0x00CC0020);
                if (!ok) {
                    PrintWindow(hwnd, hdcDest, 2);
                }
            } finally {
                ReleaseDC(IntPtr.Zero, hdcSrc);
                g.ReleaseHdc(hdcDest);
            }
        }
        return bmp;
    }
}
'@ -ReferencedAssemblies System.Drawing

$pList = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
if (-not $pList) {
    Write-Host "Process $ProcessName not found"
    exit 1
}

$targetHwnd = [IntPtr]::Zero
foreach ($proc in $pList) {
    $h = [WinCapture]::FindTargetHwnd($proc.Id, $WindowTitle)
    if ($h -ne [IntPtr]::Zero) {
        $targetHwnd = $h
        break
    }
}

if ($targetHwnd -eq [IntPtr]::Zero) {
    Write-Host "No window matching title '$WindowTitle' and size > 400x300 found"
    exit 2
}

$bmp = [WinCapture]::Capture($targetHwnd)
if ($bmp) {
    $parent = Split-Path -Parent $OutputPath
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $bmp.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Window capture saved successfully to: $OutputPath"
} else {
    Write-Host "Capture failed: bitmap was null"
    exit 3
}
