// Disposable test helper: real directory locks and Windows short-path aliases.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class InstallerLockFixture {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetShortPathName(string path, StringBuilder output, uint capacity);
    private static int Main(string[] args) {
        if (args[0] == "--short-path") {
            var output = new StringBuilder(32768);
            uint length = GetShortPathName(args[1], output, (uint)output.Capacity);
            if (length == 0 || length >= output.Capacity) return 1;
            Console.OutputEncoding = new UTF8Encoding(false);
            Console.WriteLine(output.ToString());
            return 0;
        }
        using (var handle = CreateFile(args[0], 0x80000000, 3, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
            if (handle.IsInvalid) return Marshal.GetLastWin32Error();
            File.WriteAllText(args[1], "ready");
            var deadline = DateTime.UtcNow.AddSeconds(120);
            while (!File.Exists(args[2]) && DateTime.UtcNow < deadline) Thread.Sleep(20);
        }
        return 0;
    }
}
