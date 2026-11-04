using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace AgentMathSetup {
    internal static class Setup {
        private const string Version = "0.2.0-preview.30";
        private const string RegistryPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentMath";
        private static readonly string DefaultTarget = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "AgentMath");
        private static string target = DefaultTarget;
        private static bool silent, noLaunch, noShortcuts, startup;
        private static string Quote(string value) { return "\"" + value.Replace("\"", "") + "\""; }
        [STAThread] private static int Main(string[] args) {
            Application.EnableVisualStyles();
            bool uninstall = false, worker = false;
            for (int i = 0; i < args.Length; i++) {
                if (args[i] == "--target" && i + 1 < args.Length) target = Path.GetFullPath(args[++i]);
                else if (args[i] == "--silent") silent = true;
                else if (args[i] == "--no-launch") noLaunch = true;
                else if (args[i] == "--no-shortcuts") noShortcuts = true;
                else if (args[i] == "--startup") startup = true;
                else if (args[i] == "--uninstall") uninstall = true;
                else if (args[i] == "--uninstall-worker") { uninstall = true; worker = true; }
            }
#if UNINSTALLER
            uninstall = true;
            if (Array.IndexOf(args, "--target") < 0) target = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
#endif
            target = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar);
            try {
                if (uninstall) {
                    if (!silent && !worker && MessageBox.Show("卸载 Agent Math？本地设置将保留，Codex 和终端不受影响。", "Agent Math", MessageBoxButtons.OKCancel) != DialogResult.OK) return 0;
                    string current = Assembly.GetExecutingAssembly().Location;
                    if (!worker && current.StartsWith(target + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) {
                        string temp = Path.Combine(Path.GetTempPath(), "AgentMath-Uninstall-" + Guid.NewGuid().ToString("N"));
                        Directory.CreateDirectory(temp);
                        string helper = Path.Combine(temp, "Uninstall.exe"); File.Copy(current, helper);
                        Process.Start(new ProcessStartInfo(helper, "--uninstall-worker --target " + Quote(target) + (silent ? " --silent" : "")) { UseShellExecute = false });
                        return 0;
                    }
                    Uninstall();
                    if (worker) CleanTemporaryHelper();
                    if (!silent) MessageBox.Show("Agent Math 已卸载。", "Agent Math");
                    return 0;
                }
                if (silent) { Install(); return 0; }
                using (var form = new Form { Text = "安装 Agent Math " + Version, ClientSize = new Size(485, 270),
                    FormBorderStyle = FormBorderStyle.FixedDialog, StartPosition = FormStartPosition.CenterScreen,
                    MaximizeBox = false, MinimizeBox = false }) {
                    var heading = new Label { Text = "在现有终端中查看公式", AutoSize = true, Location = new Point(24, 22), Font = new Font(SystemFonts.MessageBoxFont.FontFamily, 15) };
                    var description = new Label { Text = "安装后，照常在 Windows Terminal 中运行 Codex。\r\n公式在本地排版；选中和复制时仍使用原始源码。", AutoSize = true, Location = new Point(26, 64) };
                    var destination = new Label { Text = "安装到当前用户：\r\n" + target, AutoSize = false, Size = new Size(435, 42), Location = new Point(26, 111) };
                    var launch = new CheckBox { Text = "安装完成后启动", Checked = true, AutoSize = true, Location = new Point(26, 165) };
                    var login = new CheckBox { Text = "登录 Windows 时启动", Checked = startup, AutoSize = true, Location = new Point(26, 193) };
                    var install = new Button { Text = "安装", Location = new Point(350, 218), Size = new Size(105, 32) };
                    install.Click += delegate {
                        install.Enabled = false; install.Text = "安装中…";
                        noLaunch = !launch.Checked; startup = login.Checked;
                        try { Install(); form.Close(); }
                        catch (Exception error) { MessageBox.Show(error.Message, "安装未完成"); install.Enabled = true; install.Text = "安装"; }
                    };
                    form.Controls.AddRange(new Control[] { heading, description, destination, launch, login, install });
                    Application.Run(form);
                }
                return 0;
            } catch (Exception error) {
                if (silent) { try { Console.Error.WriteLine(error.Message); } catch { } }
                else MessageBox.Show(error.Message, "Agent Math");
                return 1;
            }
        }
        private static bool IsOurDirectory(string directory) {
            string marker = Path.Combine(directory, "product.json");
            if (!File.Exists(marker)) return false;
            string value = File.ReadAllText(marker);
            return value.Contains("\"name\": \"Agent Math\"") && value.Contains("\"platform\": \"win32-x64\"");
        }
        private static void ValidateTarget() {
            if (target.Length < 12 || target == Path.GetPathRoot(target).TrimEnd('\\') ||
                target == Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) ||
                target == Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData))
                throw new Exception("请选择专用的应用目录。");
            if (Directory.Exists(target) && Directory.GetFileSystemEntries(target).Length > 0 && !IsOurDirectory(target))
                throw new Exception("此目录中已有其他文件。请选择一个空目录。");
        }
        private static void StopApp() {
            string app = Path.Combine(target, "AgentMath.exe");
            if (!File.Exists(app)) return;
            // A package lifecycle check uses a separate target/profile. If this
            // target is not running, do not signal the shared default profile
            // and accidentally stop the user's companion from another path.
            bool ownsProcess = false;
            foreach (var process in Process.GetProcessesByName("AgentMath")) {
                using (process) { try { if (String.Equals(process.MainModule.FileName, app, StringComparison.OrdinalIgnoreCase)) ownsProcess = true; } catch { } }
            }
            if (!ownsProcess) return;
            using (var process = Process.Start(new ProcessStartInfo(app, "--quit") { UseShellExecute = false, CreateNoWindow = true })) process.WaitForExit(3000);
            // Only wait for this installation's own executable, never terminate a terminal or agent.
            for (int i = 0; i < 30; i++) {
                bool running = false;
                foreach (var process in Process.GetProcessesByName("AgentMath")) {
                    using (process) { try { if (String.Equals(process.MainModule.FileName, app, StringComparison.OrdinalIgnoreCase)) running = true; } catch { } }
                }
                if (!running) return; Thread.Sleep(100);
            }
            throw new Exception("请从系统托盘退出 Agent Math，然后重试。");
        }
        private static void FileOperation(Action operation, string description) {
            // Windows may briefly retain executable/directory handles after a
            // process exits or while scanning newly extracted binaries. Retry
            // only filesystem contention, with a fixed deadline; never kill
            // another process or change permissions to force an update.
            var watch = Stopwatch.StartNew();
            for (;;) {
                Exception failure;
                try { operation(); return; }
                catch (IOException error) { failure = error; }
                catch (UnauthorizedAccessException error) { failure = error; }
                if (watch.ElapsedMilliseconds >= 5000) throw new IOException(description + "\r\n" + failure.Message, failure);
                Thread.Sleep(100);
            }
        }
        private static void MoveDirectory(string source, string destination) {
            FileOperation(delegate { Directory.Move(source, destination); }, "Unable to move installation directory: " + source);
        }
        private static void DeleteDirectory(string directory) {
            FileOperation(delegate { Directory.Delete(directory, true); }, "Unable to remove installation directory: " + directory);
        }
        private static void Install() {
            ValidateTarget();
            string parent = Path.GetDirectoryName(target); Directory.CreateDirectory(parent);
            string stage = Path.Combine(parent, ".AgentMath-stage-" + Guid.NewGuid().ToString("N"));
            string backup = Path.Combine(parent, ".AgentMath-previous-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(stage);
            try {
                using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")) {
                    if (stream == null) throw new Exception("安装资源不完整。");
                    using (var zip = new ZipArchive(stream, ZipArchiveMode.Read)) {
                        foreach (var entry in zip.Entries) {
                            string destination = Path.GetFullPath(Path.Combine(stage, entry.FullName));
                            if (!destination.StartsWith(stage + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("安装包路径无效。");
                            if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(destination); continue; }
                            Directory.CreateDirectory(Path.GetDirectoryName(destination));
                            using (var source = entry.Open()) using (var output = File.Create(destination)) source.CopyTo(output);
                        }
                    }
                }
                if (!IsOurDirectory(stage) || !File.Exists(Path.Combine(stage, "AgentMath.exe"))) throw new Exception("安装包不完整。");
                if (Directory.Exists(target)) { StopApp(); MoveDirectory(target, backup); }
                try { MoveDirectory(stage, target); }
                catch { if (Directory.Exists(backup)) MoveDirectory(backup, target); throw; }
                if (!noShortcuts) {
                    Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Agent Math.lnk"), Path.Combine(target, "AgentMath.exe"), "");
                    string login = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Agent Math.lnk");
                    if (startup) Shortcut(login, Path.Combine(target, "AgentMath.exe"), "--quiet");
                    else if (File.Exists(login)) File.Delete(login);
                }
                if (String.Equals(target, DefaultTarget, StringComparison.OrdinalIgnoreCase)) {
                    using (var key = Registry.CurrentUser.CreateSubKey(RegistryPath)) {
                        key.SetValue("DisplayName", "Agent Math"); key.SetValue("DisplayVersion", Version);
                        key.SetValue("Publisher", "Agent Math contributors"); key.SetValue("InstallLocation", target);
                        key.SetValue("UninstallString", Quote(Path.Combine(target, "Uninstall.exe")));
                        key.SetValue("DisplayIcon", Path.Combine(target, "AgentMath.exe"));
                        key.SetValue("NoModify", 1); key.SetValue("NoRepair", 1);
                    }
                }
                if (Directory.Exists(backup)) DeleteDirectory(backup);
                if (!noLaunch) Process.Start(new ProcessStartInfo(Path.Combine(target, "AgentMath.exe")) { UseShellExecute = true });
            } finally { if (Directory.Exists(stage)) DeleteDirectory(stage); }
        }
        private static void Uninstall() {
            if (!Directory.Exists(target)) return;
            if (!IsOurDirectory(target)) throw new Exception("此目录不是 Agent Math 安装目录，未删除任何文件。");
            StopApp(); DeleteDirectory(target);
            if (String.Equals(target, DefaultTarget, StringComparison.OrdinalIgnoreCase)) {
                foreach (var link in new string[] {
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Agent Math.lnk"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Agent Math.lnk")
                }) if (File.Exists(link)) File.Delete(link);
                Registry.CurrentUser.DeleteSubKeyTree(RegistryPath, false);
            }
        }
        private static void Shortcut(string path, string executable, string arguments) {
            var shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            try {
                var link = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
                try {
                    var type = link.GetType();
                    type.InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { executable });
                    type.InvokeMember("Arguments", BindingFlags.SetProperty, null, link, new object[] { arguments });
                    type.InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
                } finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(link); }
            } finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell); }
        }
        private static void CleanTemporaryHelper() {
            string directory = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            string tempRoot = Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\') + "\\AgentMath-Uninstall-";
            if (!directory.StartsWith(tempRoot, StringComparison.OrdinalIgnoreCase)) return;
            string self = Assembly.GetExecutingAssembly().Location;
            string command = "Wait-Process -Id " + Process.GetCurrentProcess().Id + " -ErrorAction SilentlyContinue; Remove-Item -LiteralPath '" + self.Replace("'", "''") + "' -Force; Remove-Item -LiteralPath '" + directory.Replace("'", "''") + "'";
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
            Process.Start(new ProcessStartInfo(powershell, "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(command))) { UseShellExecute = false, CreateNoWindow = true });
        }
    }
}
