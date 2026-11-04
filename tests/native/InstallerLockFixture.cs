// Disposable test helper: hold a directory handle without FILE_SHARE_DELETE.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class InstallerLockFixture {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);
    private static int Main(string[] args) {
        using (var handle = CreateFile(args[0], 0x80000000, 3, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
            if (handle.IsInvalid) return Marshal.GetLastWin32Error();
            File.WriteAllText(args[1], "ready");
            var deadline = DateTime.UtcNow.AddSeconds(120);
            while (!File.Exists(args[2]) && DateTime.UtcNow < deadline) Thread.Sleep(20);
        }
        return 0;
    }
}
