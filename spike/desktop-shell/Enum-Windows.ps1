Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class WinEnum {
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

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static void ListWindows(uint targetPid) {
        EnumWindows((hWnd, lParam) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == targetPid) {
                StringBuilder sb = new StringBuilder(256);
                GetWindowText(hWnd, sb, 256);
                RECT rc;
                GetWindowRect(hWnd, out rc);
                int w = rc.Right - rc.Left;
                int h = rc.Bottom - rc.Top;
                bool vis = IsWindowVisible(hWnd);
                Console.WriteLine("HWND: " + hWnd + " Title: '" + sb.ToString() + "' Visible: " + vis + " Rect: " + w + "x" + h + " at (" + rc.Left + "," + rc.Top + ")");
            }
            return true;
        }, IntPtr.Zero);
    }
}
'@

$proc = Start-Process -FilePath "spike\desktop-shell\src-tauri\target\debug\app.exe" -WorkingDirectory "spike\desktop-shell" -PassThru
Start-Sleep -Seconds 4
Write-Host "Listing windows for PID $($proc.Id):"
[WinEnum]::ListWindows($proc.Id)
Stop-Process -Id $proc.Id -Force
