using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;

namespace AgentMath {
    internal static class Native {
        [StructLayout(LayoutKind.Sequential)] internal struct RECT {
            public int Left, Top, Right, Bottom;
            public Rectangle ToRectangle() { return Rectangle.FromLTRB(Left, Top, Right, Bottom); }
        }
        [StructLayout(LayoutKind.Sequential)] internal struct POINT { public int X, Y; }
        internal delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);
        internal delegate bool EnumWindowProc(IntPtr hwnd, IntPtr data);
        [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumWindowProc callback, IntPtr data);
        [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetClassName(IntPtr hwnd, StringBuilder value, int size);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(IntPtr hwnd, StringBuilder value, int size);
        [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] internal static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] internal static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] internal static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] internal static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
        [DllImport("user32.dll")] internal static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint color, byte alpha, uint flags);
        [DllImport("user32.dll")] internal static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc callback, uint process, uint thread, uint flags);
        [DllImport("user32.dll")] internal static extern bool UnhookWinEvent(IntPtr hook);
        [DllImport("user32.dll")] internal static extern IntPtr WindowFromPoint(POINT point);
        [DllImport("user32.dll")] internal static extern IntPtr GetAncestor(IntPtr hwnd, uint flag);
        [DllImport("user32.dll")] internal static extern IntPtr GetWindow(IntPtr hwnd, uint command);
        [DllImport("user32.dll")] internal static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
        internal static bool IsBehindOwner(IntPtr window, IntPtr owner) {
            // EnumWindows gives a stable traversal of top-level Z order. A
            // GetWindow walk can include non-enumerated windows and exceed an
            // arbitrary hop cap even with only a few visible applications.
            int first = 0;
            EnumWindows(delegate(IntPtr candidate, IntPtr data) {
                if (candidate == window) { first = 1; return false; }
                if (candidate == owner) { first = 2; return false; }
                return true;
            }, IntPtr.Zero);
            return first == 2;
        }
        internal static string Title(IntPtr hwnd) {
            var text = new StringBuilder(1024); GetWindowText(hwnd, text, text.Capacity); return text.ToString();
        }
        internal static bool IsTerminal(IntPtr hwnd, string restrictTitle) {
            if (hwnd == IntPtr.Zero || IsIconic(hwnd)) return false;
            if (restrictTitle != null && Title(hwnd) != restrictTitle) return false;
            var value = new StringBuilder(256); GetClassName(hwnd, value, value.Capacity);
            if (value.ToString() != "CASCADIA_HOSTING_WINDOW_CLASS") return false;
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName == "WindowsTerminal"; }
            catch { return false; }
        }
        internal static bool MouseDown {
            get { return GetAsyncKeyState(1) < 0 || GetAsyncKeyState(2) < 0 || GetAsyncKeyState(4) < 0; }
        }
    }
}
