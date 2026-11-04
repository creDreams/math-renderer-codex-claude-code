using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace AgentMath {
    internal static class Program {
        [STAThread] private static int Main(string[] args) {
            Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
            var directory = AppDomain.CurrentDomain.BaseDirectory;
            string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AgentMath");
            string title = null, codexHome = null, diagnostics = null, command = null;
            bool quiet = false;
            for (int index = 0; index < args.Length; index++) {
                var arg = args[index];
                if (arg == "--quiet") quiet = true;
                else if (arg == "--quit" || arg == "--pause" || arg == "--resume" || arg == "--inline-on" || arg == "--inline-off") command = arg.Substring(2);
                else if (index + 1 < args.Length) {
                    var value = args[++index];
                    if (arg == "--profile") profile = Path.GetFullPath(value);
                    else if (arg == "--window-title") title = value;
                    else if (arg == "--codex-home") codexHome = Path.GetFullPath(value);
                    else if (arg == "--diagnostics") diagnostics = Path.GetFullPath(value);
                }
            }
            string suffix;
            using (var hash = SHA256.Create()) suffix = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(profile.ToUpperInvariant()))).Replace("-", "").Substring(0, 16);
            string prefix = "Local\\AgentMath.v02." + suffix;
            if (command != null) {
                try { using (var ev = EventWaitHandle.OpenExisting(prefix + "." + (command == "quit" ? "stop" : command))) ev.Set(); }
                catch (WaitHandleCannotBeOpenedException) { }
                return 0;
            }
            bool created;
            using (var mutex = new Mutex(true, prefix + ".mutex", out created)) {
                if (!created) {
                    if (!quiet) try { using (var ev = EventWaitHandle.OpenExisting(prefix + ".show")) ev.Set(); } catch { }
                    return 0;
                }
                try {
                    Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
                    Application.Run(new AppContext(directory, profile, title, codexHome, diagnostics, prefix, quiet));
                    return 0;
                } catch {
                    if (!quiet) MessageBox.Show("应用未能启动。请确认安装包已完整解压，然后重新启动。", "Agent Math", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return 1;
                } finally { mutex.ReleaseMutex(); }
            }
        }
    }
}
