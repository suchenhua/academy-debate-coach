// Academy 辩论教练 - 安装版外壳（自解压启动器）
// 许可：CC BY-NC-SA 4.0（署名 · 非商业性使用 · 相同方式共享）
// 编译：csc /target:winexe ...
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Academy 辩论教练 安装向导")]
[assembly: AssemblyDescription("Academy Debate Coach Setup (QFUD)")]
[assembly: AssemblyProduct("Academy 辩论教练")]
[assembly: AssemblyCompany("QFUD")]
[assembly: AssemblyVersion("1.9.0.0")]

namespace AcademySetup
{
    internal static class Program
    {
        // 追加数据分隔标记：stub.exe + Magic + payload.zip
        internal static readonly byte[] Magic = Encoding.ASCII.GetBytes("ACADEMY-SETUP-OVERLAY-V1-7F3A9C21B64E");

        internal static void Log(string msg)
        {
            try
            {
                File.AppendAllText(
                    Path.Combine(Path.GetTempPath(), "AcademyBianlunSetup.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + msg + Environment.NewLine);
            }
            catch { }
        }

        [STAThread]
        private static int Main()
        {
            Log("setup launcher started");
            bool createdNew;
            using (Mutex mutex = new Mutex(true, @"Local\AcademyBianlunCoachSetup", out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show(
                        "\u5b89\u88c5\u7a0b\u5e8f\u5df2\u7ecf\u5728\u8fd0\u884c\uff0c\u8bf7\u7b49\u5f85\u5f53\u524d\u5b89\u88c5\u5b8c\u6210\u3002",
                        "Academy \u8fa9\u8bba\u6559\u7ec3 \u5b89\u88c5\u5411\u5bfc",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                    return 0;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new SetupForm());
                return 0;
            }
        }
    }

    internal sealed class SetupForm : Form
    {
        private readonly Label statusLabel;
        private readonly ProgressBar progressBar;
        private string extractDir;
        private bool finished;

        // 安装目标目录。必须与 setup.bat 里的 DEST=%LOCALAPPDATA%\AcademyDebateCoach 保持一致：
        // setup.bat 是真正的安装执行者，这里只用于「显示给用户看」和「装完打开文件夹」。
        internal static string InstallDir
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "AcademyDebateCoach");
            }
        }

        public SetupForm()
        {
            Text = "Academy \u8fa9\u8bba\u6559\u7ec3 \u5b89\u88c5\u5411\u5bfc";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(560, 250);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            statusLabel = new Label
            {
                AutoSize = true,
                Location = new Point(28, 28),
                Font = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold),
                Text = "\u6b63\u5728\u51c6\u5907\u5b89\u88c5\uff0c\u8bf7\u7a0d\u5019\u2026"
            };
            var detailLabel = new Label
            {
                AutoSize = true,
                Location = new Point(28, 66),
                Font = new Font("Microsoft YaHei UI", 9F),
                Text = "\u9996\u6B21\u5B89\u88C5\u9700\u8981\u89E3\u538B\u5E76\u590D\u5236\u7A0B\u5E8F\u6587\u4EF6\uFF0C\u5927\u7EA6 1~3 \u5206\u949F\u3002"
            };
            // 让用户一眼看到装到哪 —— 之前只写「正在解压」，装完完全不知道装在哪了
            var pathCaption = new Label
            {
                AutoSize = true,
                Location = new Point(28, 94),
                Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold),
                Text = "\u5B89\u88C5\u4F4D\u7F6E\uFF1A"
            };
            var pathLabel = new Label
            {
                AutoSize = false,
                Location = new Point(28, 116),
                Size = new Size(504, 20),
                Font = new Font("Microsoft YaHei UI", 9F),
                ForeColor = Color.FromArgb(60, 90, 160),
                AutoEllipsis = true,
                Text = InstallDir
            };
            var keepLabel = new Label
            {
                AutoSize = true,
                Location = new Point(28, 146),
                Font = new Font("Microsoft YaHei UI", 8.5F),
                ForeColor = Color.FromArgb(120, 120, 120),
                Text = "\u5B89\u88C5\u6B63\u5728\u5168\u901F\u8FDB\u884C\uFF0C\u8BF7\u4E0D\u8981\u5173\u95ED\u6B64\u7A97\u53E3\u3002"
            };
            progressBar = new ProgressBar
            {
                Style = ProgressBarStyle.Marquee,
                MarqueeAnimationSpeed = 28,
                Location = new Point(28, 178),
                Size = new Size(504, 24)
            };
            Controls.Add(statusLabel);
            Controls.Add(detailLabel);
            Controls.Add(pathCaption);
            Controls.Add(pathLabel);
            Controls.Add(keepLabel);
            Controls.Add(progressBar);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            Thread worker = new Thread(RunInstall);
            worker.IsBackground = true;
            worker.Start();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!finished)
            {
                e.Cancel = true;
                MessageBox.Show(
                    "\u5b89\u88c5\u6b63\u5728\u8fdb\u884c\uff0c\u8bf7\u4e0d\u8981\u5173\u95ed\u6b64\u7a97\u53e3\u3002",
                    "Academy \u8fa9\u8bba\u6559\u7ec3 \u5b89\u88c5\u5411\u5bfc",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            base.OnFormClosing(e);
        }

        private void SetStatus(string text)
        {
            if (IsHandleCreated && !IsDisposed)
            {
                BeginInvoke((MethodInvoker)delegate { statusLabel.Text = text; });
            }
        }

        private void RunInstall()
        {
            extractDir = null;
            string zipPath = null;
            try
            {
                string exePath = Application.ExecutablePath;
                Program.Log("exe=" + exePath);
                SetStatus("\u6b63\u5728\u89e3\u538b\u5b89\u88c5\u5305\u2026");
                long offset;
                long length;
                if (!FindOverlay(exePath, out offset, out length))
                {
                    throw new Exception("\u5b89\u88c5\u5305\u6570\u636e\u4e0d\u5b8c\u6574\uff0c\u8bf7\u91cd\u65b0\u4e0b\u8f7d\u5b89\u88c5\u7a0b\u5e8f\u3002");
                }
                Program.Log("overlay offset=" + offset + " length=" + length);

                zipPath = Path.Combine(Path.GetTempPath(), "AcademyBianlun_" + Process.GetCurrentProcess().Id + ".zip");
                Program.Log("zip=" + zipPath);
                using (FileStream src = new FileStream(exePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (FileStream dst = new FileStream(zipPath, FileMode.Create, FileAccess.Write))
                {
                    src.Seek(offset + Program.Magic.Length, SeekOrigin.Begin);
                    byte[] buffer = new byte[1024 * 1024];
                    long left = length;
                    while (left > 0)
                    {
                        int n = src.Read(buffer, 0, (int)Math.Min(buffer.Length, left));
                        if (n <= 0) break;
                        dst.Write(buffer, 0, n);
                        left -= n;
                    }
                    if (left != 0)
                    {
                        throw new Exception("\u5b89\u88c5\u5305\u6570\u636e\u8bfb\u53d6\u4e0d\u5b8c\u6574\u3002");
                    }
                }

                extractDir = Path.Combine(Path.GetTempPath(), "AcademyBianlun_" + Process.GetCurrentProcess().Id);
                Program.Log("extractDir=" + extractDir);
                if (Directory.Exists(extractDir))
                {
                    Directory.Delete(extractDir, true);
                }
                Program.Log("zip copied bytes=" + new FileInfo(zipPath).Length);
                SetStatus("\u6b63\u5728\u89e3\u538b\u7a0b\u5e8f\u6587\u4ef6\u2026");
                ZipFile.ExtractToDirectory(zipPath, extractDir);
                Program.Log("extract done, entries=" + Directory.GetFileSystemEntries(extractDir).Length);
                try { File.Delete(zipPath); } catch { }
                zipPath = null;

                SetStatus("\u6B63\u5728\u5B89\u88C5\u7A0B\u5E8F\u6587\u4EF6\u2026\uFF08\u590D\u5236\u5230\u4E0A\u65B9\u76EE\u5F55\uFF09");
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = Path.Combine(extractDir, "setup.bat"),
                    WorkingDirectory = extractDir,
                    UseShellExecute = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                Program.Log("starting setup.bat");
                Process p = Process.Start(psi);
                if (p == null)
                {
                    throw new Exception("\u65e0\u6cd5\u542f\u52a8\u5b89\u88c5\u7a0b\u5e8f\u3002");
                }
                p.WaitForExit();
                Program.Log("setup.bat exit=" + p.ExitCode);
                if (p.ExitCode != 0)
                {
                    throw new Exception(
                        "\u5B89\u88C5\u5931\u8D25\uFF08\u9519\u8BEF\u7801 " + p.ExitCode + "\uFF09\u3002\r\n\r\n" +
                        "\u76EE\u6807\u4F4D\u7F6E\uFF1A" + InstallDir + "\r\n\r\n" +
                        "\u8BF7\u5173\u95ED\u6740\u6BD2\u8F6F\u4EF6\u540E\u91CD\u8BD5\uFF0C" +
                        "\u6216\u628A\u672C\u7A0B\u5E8F\u540C\u76EE\u5F55\u7684 zip \u89E3\u538B\u540E" +
                        "\u53CC\u51FB\u201C\u4E00\u952E\u5B89\u88C5.bat\u201D\u3002");
                }

                BeginInvoke((MethodInvoker)delegate
                {
                    Program.Log("install success");
                    finished = true;
                    Close();
                    DialogResult openIt = MessageBox.Show(
                        "\u5B89\u88C5\u5B8C\u6210\uFF01\r\n\r\n\u5DF2\u5B89\u88C5\u5230\uFF1A\r\n" + InstallDir + "\r\n\r\n" +
                        "\u4EE5\u540E\u53CC\u51FB\u684C\u9762\u4E0A\u7684\u300CAcademy \u8FA9\u8BBA\u6559\u7EC3\u300D\u56FE\u6807\u5373\u53EF\u4F7F\u7528\u3002\r\n" +
                        "\u4E0D\u60F3\u7528\u4E86\uFF1F\u5F00\u59CB\u83DC\u5355\u91CC\u6709\u300C\u5378\u8F7D\u300D\uFF0C\u5378\u8F7D\u524D\u4F1A\u81EA\u52A8\u5907\u4EFD\u4F60\u7684\u6570\u636E\u3002\r\n\r\n" +
                        "\u8981\u73B0\u5728\u6253\u5F00\u5B89\u88C5\u6587\u4EF6\u5939\u770B\u770B\u5417\uFF1F",
                        "Academy \u8FA9\u8BBA\u6559\u7EC3 \u5B89\u88C5\u5411\u5BFC",
                        MessageBoxButtons.YesNo,
                        MessageBoxIcon.Information);
                    if (openIt == DialogResult.Yes)
                    {
                        try
                        {
                            if (Directory.Exists(InstallDir))
                            {
                                Process.Start(new ProcessStartInfo
                                {
                                    FileName = "explorer.exe",
                                    Arguments = "\"" + InstallDir + "\"",
                                    UseShellExecute = true
                                });
                            }
                        }
                        catch (Exception ex2) { Program.Log("open folder failed: " + ex2.Message); }
                    }
                });
            }
            catch (Exception ex)
            {
                Program.Log("ERROR: " + ex);
                BeginInvoke((MethodInvoker)delegate
                {
                    MessageBox.Show(
                        ex.Message,
                        "Academy \u8fa9\u8bba\u6559\u7ec3 \u5b89\u88c5\u5411\u5bfc",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                    finished = true;
                    Close();
                });
            }
            finally
            {
                if (!string.IsNullOrEmpty(zipPath)) { try { File.Delete(zipPath); } catch { } }
                if (!string.IsNullOrEmpty(extractDir))
                {
                    for (int i = 0; i < 10; i++)
                    {
                        try { Directory.Delete(extractDir, true); Program.Log("cleanup ok"); break; }
                        catch { Thread.Sleep(500); }
                    }
                }
                Program.Log("launcher finished");
            }
        }

        private static bool FindOverlay(string exePath, out long offset, out long length)
        {
            offset = 0;
            length = 0;
            byte[] magic = Program.Magic;
            using (FileStream fs = new FileStream(exePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                long size = fs.Length;
                if (size < magic.Length + 64) return false;

                // 分隔标记紧跟在 stub 之后（文件开头 2MB 内）；先正向扫描。
                // 如未来布局变化，再退回扫描文件末尾 8MB。
                long scanLen = Math.Min(size, 2L * 1024L * 1024L);
                byte[] window = new byte[scanLen];
                if (!ReadFully(fs, 0, window))
                {
                    return false;
                }
                long found = IndexOf(window, magic, 0, window.Length - magic.Length);
                if (found >= 0)
                {
                    return ValidateOffset(fs, size, found, out offset, out length);
                }

                long windowStart = Math.Max(0, size - magic.Length - 8L * 1024L * 1024L);
                int windowLen = (int)(size - windowStart);
                window = new byte[windowLen];
                if (!ReadFully(fs, windowStart, window))
                {
                    return false;
                }
                long idx = IndexOf(window, magic, 0, windowLen - magic.Length);
                if (idx >= 0)
                {
                    return ValidateOffset(fs, size, windowStart + idx, out offset, out length);
                }
            }
            return false;
        }

        private static bool ReadFully(FileStream fs, long position, byte[] buffer)
        {
            fs.Seek(position, SeekOrigin.Begin);
            int read = 0;
            while (read < buffer.Length)
            {
                int n = fs.Read(buffer, read, buffer.Length - read);
                if (n <= 0) return false;
                read += n;
            }
            return true;
        }

        private static long IndexOf(byte[] data, byte[] needle, int start, int end)
        {
            for (int i = start; i <= end; i++)
            {
                bool match = true;
                for (int j = 0; j < needle.Length; j++)
                {
                    if (data[i + j] != needle[j]) { match = false; break; }
                }
                if (match) return i;
            }
            return -1;
        }

        private static bool ValidateOffset(FileStream fs, long size, long candidate, out long offset, out long length)
        {
            offset = 0;
            length = 0;
            long zipStart = candidate + Program.Magic.Length;
            if (zipStart + 4 > size) return false;
            fs.Seek(zipStart, SeekOrigin.Begin);
            byte[] sig = new byte[4];
            if (fs.Read(sig, 0, 4) != 4) return false;
            if (!(sig[0] == 0x50 && sig[1] == 0x4B)) return false; // PK
            offset = candidate;
            length = size - zipStart;
            return true;
        }
    }
}
