// Academy 辩论教练 - 安装版外壳（自解压启动器）
// 许可：CC BY-NC-SA 4.0（署名 · 非商业性使用 · 相同方式共享）
// 编译：csc /target:winexe ...
//
// 两阶段向导：
//   1) 选择安装位置（可浏览 / 恢复默认）+ 是否创建桌面、开始菜单快捷方式 -> 点「开始安装」
//   2) 解压安装包 -> 调用 setup.bat（传入目标目录与快捷方式开关）-> 报告安装位置
//
// 【编码约定】界面里的中文一律写成字面反斜杠-u 转义，不要改成直写中文：
// csc 未加 /codepage 时按系统 ANSI 读源文件，直写中文会编译成乱码。
// 同理，本文件刻意不含任何 C# 字符串转义反斜杠（换行用 Environment.NewLine，引号用 (char)34）。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Academy \u8FA9\u8BBA\u6559\u7EC3 \u5B89\u88C5\u5411\u5BFC")]
[assembly: AssemblyDescription("Academy Debate Coach Setup (QFUD)")]
[assembly: AssemblyProduct("Academy 辩论教练")]
[assembly: AssemblyCompany("QFUD")]
[assembly: AssemblyVersion("2.0.0.0")]

namespace AcademySetup
{
    internal static class Program
    {
        internal static readonly byte[] Magic = Encoding.ASCII.GetBytes("ACADEMY-SETUP-OVERLAY-V1-7F3A9C21B64E");

        // 默认安装目录，与 setup.bat 的默认 DEST 保持一致
        internal static string DefaultInstallDir
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "AcademyDebateCoach");
            }
        }

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
            using (Mutex mutex = new Mutex(true, "Local" + Path.DirectorySeparatorChar + "AcademyBianlunCoachSetup", out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show("\u5B89\u88C5\u7A0B\u5E8F\u5DF2\u7ECF\u5728\u8FD0\u884C\uFF0C\u8BF7\u7B49\u5F85\u5F53\u524D\u5B89\u88C5\u5B8C\u6210\u3002", "Academy \u8FA9\u8BBA\u6559\u7EC3 \u5B89\u88C5\u5411\u5BFC", MessageBoxButtons.OK, MessageBoxIcon.Information);
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
        // 注意：这些字段由构造函数间接调用 BuildChoosePage/BuildProgressPage 赋值，
        // 因此不能声明为 readonly（CS0191）。
        private Panel  choosePage;
        private Panel  progressPage;
        private TextBox pathBox;
        private CheckBox chkDesktop;
        private CheckBox chkMenu;
        private Label statusLabel;
        private ProgressBar progressBar;
        private string extractDir;
        private string installDir;
        private bool finished;

        public SetupForm()
        {
            Text = "Academy \u8FA9\u8BBA\u6559\u7EC3 \u5B89\u88C5\u5411\u5BFC";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(580, 330);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            choosePage = BuildChoosePage();
            progressPage = BuildProgressPage();
            Controls.Add(choosePage);
            Controls.Add(progressPage);
            progressPage.Visible = false;

            statusLabel = (Label)progressPage.Controls["statusLabel"];
            progressBar = (ProgressBar)progressPage.Controls["progressBar"];
        }

        // ---------- 第一阶段：选择安装位置 ----------
        private Panel BuildChoosePage()
        {
            Panel p = new Panel { Dock = DockStyle.Fill };

            Label title = new Label
            {
                AutoSize = true,
                Location = new Point(24, 18),
                Font = new Font("Microsoft YaHei UI", 13F, FontStyle.Bold),
                Text = "\u9009\u62E9\u5B89\u88C5\u4F4D\u7F6E"
            };
            Label intro = new Label
            {
                AutoSize = false,
                Location = new Point(26, 56),
                Size = new Size(528, 42),
                Font = new Font("Microsoft YaHei UI", 9F),
                Text = "\u7A0B\u5E8F\u4F1A\u88C5\u5230\u4E0B\u9762\u8FD9\u4E2A\u6587\u4EF6\u5939\u3002\u53EF\u4EE5\u76F4\u63A5\u88C5\uFF0C\u6216\u70B9\u300C\u66F4\u6539\u2026\u300D\u81EA\u5DF1\u6311\u4E00\u4E2A\u3002"
            };
            Label cap = new Label
            {
                AutoSize = true,
                Location = new Point(26, 106),
                Font = new Font("Microsoft YaHei UI", 9F),
                Text = "\u5B89\u88C5\u4F4D\u7F6E\uFF1A"
            };
            pathBox = new TextBox
            {
                Location = new Point(26, 128),
                Size = new Size(414, 26),
                Font = new Font("Microsoft YaHei UI", 9F),
                Text = Program.DefaultInstallDir
            };
            Button browse = new Button
            {
                Location = new Point(448, 127),
                Size = new Size(106, 28),
                Text = "\u66F4\u6539\u2026"
            };
            browse.Click += OnBrowse;

            Button reset = new Button
            {
                Location = new Point(26, 162),
                Size = new Size(106, 26),
                Text = "\u6062\u590D\u9ED8\u8BA4"
            };
            reset.Click += delegate { pathBox.Text = Program.DefaultInstallDir; };

            chkDesktop = new CheckBox
            {
                Location = new Point(26, 204),
                AutoSize = true,
                Checked = true,
                Font = new Font("Microsoft YaHei UI", 9F),
                Text = "\u5728\u684C\u9762\u521B\u5EFA\u5FEB\u6377\u65B9\u5F0F"
            };
            chkMenu = new CheckBox
            {
                Location = new Point(26, 230),
                AutoSize = true,
                Checked = true,
                Font = new Font("Microsoft YaHei UI", 9F),
                Text = "\u5728\u5F00\u59CB\u83DC\u5355\u521B\u5EFA\u5FEB\u6377\u65B9\u5F0F"
            };
            Label hint = new Label
            {
                AutoSize = true,
                Location = new Point(300, 206),
                Font = new Font("Microsoft YaHei UI", 8.5F),
                ForeColor = Color.FromArgb(130, 130, 130),
                Text = "\u9700\u8981\u7EA6 546 MB \u78C1\u76D8\u7A7A\u95F4"
            };

            Button go = new Button
            {
                Location = new Point(340, 276),
                Size = new Size(118, 34),
                Text = "\u5F00\u59CB\u5B89\u88C5"
            };
            go.Click += OnInstallClick;
            Button quit = new Button
            {
                Location = new Point(466, 276),
                Size = new Size(88, 34),
                Text = "\u53D6\u6D88"
            };
            quit.Click += delegate { Close(); };

            p.Controls.Add(title);
            p.Controls.Add(intro);
            p.Controls.Add(cap);
            p.Controls.Add(pathBox);
            p.Controls.Add(browse);
            p.Controls.Add(reset);
            p.Controls.Add(chkDesktop);
            p.Controls.Add(chkMenu);
            p.Controls.Add(hint);
            p.Controls.Add(go);
            p.Controls.Add(quit);
            return p;
        }

        // ---------- 第二阶段：进度 ----------
        private Panel BuildProgressPage()
        {
            Panel p = new Panel { Dock = DockStyle.Fill };

            Label st = new Label
            {
                Name = "statusLabel",
                AutoSize = true,
                Location = new Point(28, 30),
                Font = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold),
                Text = "\u6B63\u5728\u51C6\u5907\u5B89\u88C5\uFF0C\u8BF7\u7A0D\u5019\u2026"
            };
            Label detail = new Label
            {
                AutoSize = true,
                Location = new Point(28, 70),
                Font = new Font("Microsoft YaHei UI", 9F),
                Text = "\u9996\u6B21\u5B89\u88C5\u9700\u8981\u89E3\u538B\u5E76\u590D\u5236\u7A0B\u5E8F\u6587\u4EF6\uFF0C\u5927\u7EA6 1~3 \u5206\u949F\u3002"
            };
            Label cap = new Label
            {
                AutoSize = true,
                Location = new Point(28, 104),
                Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold),
                Text = "\u5B89\u88C5\u4F4D\u7F6E\uFF1A"
            };
            Label path = new Label
            {
                Name = "pathLabel",
                AutoSize = false,
                Location = new Point(28, 126),
                Size = new Size(524, 22),
                Font = new Font("Microsoft YaHei UI", 9F),
                ForeColor = Color.FromArgb(60, 90, 160),
                AutoEllipsis = true,
                Text = ""
            };
            Label keep = new Label
            {
                AutoSize = true,
                Location = new Point(28, 158),
                Font = new Font("Microsoft YaHei UI", 8.5F),
                ForeColor = Color.FromArgb(120, 120, 120),
                Text = "\u5B89\u88C5\u6B63\u5728\u5168\u901F\u8FDB\u884C\uFF0C\u8BF7\u4E0D\u8981\u5173\u95ED\u6B64\u7A97\u53E3\u3002"
            };
            ProgressBar pb = new ProgressBar
            {
                Name = "progressBar",
                Style = ProgressBarStyle.Marquee,
                MarqueeAnimationSpeed = 28,
                Location = new Point(28, 192),
                Size = new Size(524, 24)
            };

            p.Controls.Add(st);
            p.Controls.Add(detail);
            p.Controls.Add(cap);
            p.Controls.Add(path);
            p.Controls.Add(keep);
            p.Controls.Add(pb);
            return p;
        }

        // ---------- 浏览目录 ----------
        private void OnBrowse(object sender, EventArgs e)
        {
            using (FolderBrowserDialog dlg = new FolderBrowserDialog())
            {
                dlg.Description = "\u9009\u62E9 Academy \u8FA9\u8BBA\u6559\u7EC3\u7684\u5B89\u88C5\u4F4D\u7F6E";
                dlg.ShowNewFolderButton = true;
                try
                {
                    if (Directory.Exists(pathBox.Text)) dlg.SelectedPath = pathBox.Text;
                }
                catch { }
                if (dlg.ShowDialog(this) == DialogResult.OK && !string.IsNullOrEmpty(dlg.SelectedPath))
                {
                    string sel = dlg.SelectedPath.TrimEnd(Path.DirectorySeparatorChar);
                    // 用户多半选的是一个已有文件夹：默认在其下建 AcademyDebateCoach 子目录，
                    // 避免把上千个程序文件直接铺进用户自己的文件夹里
                    if (string.Equals(Path.GetFileName(sel), "AcademyDebateCoach", StringComparison.OrdinalIgnoreCase))
                    {
                        pathBox.Text = sel;
                    }
                    else
                    {
                        pathBox.Text = Path.Combine(sel, "AcademyDebateCoach");
                    }
                }
            }
        }

        // ---------- 校验 + 开始安装 ----------
        private void OnInstallClick(object sender, EventArgs e)
        {
            string dir = (pathBox.Text ?? "").Trim().Trim((char)34);
            if (dir.Length == 0)
            {
                MessageBox.Show("\u8BF7\u586B\u5199\u6216\u9009\u62E9\u4E00\u4E2A\u5B89\u88C5\u4F4D\u7F6E\u3002", "Academy \u8FA9\u8BBA\u6559\u7EC3 \u5B89\u88C5\u5411\u5BFC", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            try { dir = Path.GetFullPath(dir); } catch { }

            string root = Path.GetPathRoot(dir);
            if (!string.IsNullOrEmpty(root) &&
                string.Equals(dir.TrimEnd(Path.DirectorySeparatorChar), root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            {
                MessageBox.Show("\u8FD9\u4E2A\u4F4D\u7F6E\u4E0D\u80FD\u5B89\u88C5\uFF1A" + Environment.NewLine + dir + Environment.NewLine + Environment.NewLine + "\u8BF7\u4E0D\u8981\u53EA\u9009\u5230\u76D8\u7B26\u6839\u76EE\u5F55\uFF08\u4F8B\u5982 C: \u6216 D:\uFF09\uFF0C\u6362\u4E00\u4E2A\u6587\u4EF6\u5939\u8BD5\u8BD5\u3002",
                    "Academy \u8FA9\u8BBA\u6559\u7EC3 \u5B89\u88C5\u5411\u5BFC", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            try
            {
                Directory.CreateDirectory(dir);
                string probe = Path.Combine(dir, ".academy_write_test");
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
            }
            catch (Exception ex)
            {
                MessageBox.Show("\u8FD9\u4E2A\u6587\u4EF6\u5939\u6CA1\u6709\u5199\u5165\u6743\u9650\uFF0C\u6216\u65E0\u6CD5\u521B\u5EFA\uFF1A" + Environment.NewLine + dir + Environment.NewLine + Environment.NewLine + ex.Message + Environment.NewLine + Environment.NewLine + "\u8BF7\u6362\u4E00\u4E2A\u4F4D\u7F6E\uFF0C\u6BD4\u5982\u5728 D: \u76D8\u4E0B\u65B0\u5EFA\u4E00\u4E2A\u6587\u4EF6\u5939\u3002",
                    "Academy \u8FA9\u8BBA\u6559\u7EC3 \u5B89\u88C5\u5411\u5BFC", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            try
            {
                DriveInfo di = new DriveInfo(Path.GetPathRoot(dir));
                if (di.IsReady && di.AvailableFreeSpace < 600L * 1024L * 1024L)
                {
                    MessageBox.Show("\u78C1\u76D8\u7A7A\u95F4\u4E0D\u8DB3\uFF1A\u6240\u9009\u4F4D\u7F6E\u81F3\u5C11\u9700\u8981 600 MB \u53EF\u7528\u7A7A\u95F4\u3002", "Academy \u8FA9\u8BBA\u6559\u7EC3 \u5B89\u88C5\u5411\u5BFC", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
            }
            catch { }

            installDir = dir;
            ((Label)progressPage.Controls["pathLabel"]).Text = dir;
            choosePage.Visible = false;
            progressPage.Visible = true;
            Thread worker = new Thread(RunInstall);
            worker.IsBackground = true;
            worker.Start();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (progressPage.Visible && !finished)
            {
                e.Cancel = true;
                MessageBox.Show("\u5B89\u88C5\u6B63\u5728\u5168\u901F\u8FDB\u884C\uFF0C\u8BF7\u4E0D\u8981\u5173\u95ED\u6B64\u7A97\u53E3\u3002", "Academy \u8FA9\u8BBA\u6559\u7EC3 \u5B89\u88C5\u5411\u5BFC", MessageBoxButtons.OK, MessageBoxIcon.Information);
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
                Program.Log("installDir=" + installDir);
                SetStatus("\u6B63\u5728\u89E3\u538B\u5B89\u88C5\u5305\u2026");
                long offset;
                long length;
                if (!FindOverlay(exePath, out offset, out length))
                {
                    throw new Exception("\u5B89\u88C5\u5305\u6570\u636E\u4E0D\u5B8C\u6574\uFF0C\u8BF7\u91CD\u65B0\u4E0B\u8F7D\u5B89\u88C5\u7A0B\u5E8F\u3002");
                }
                Program.Log("overlay offset=" + offset + " length=" + length);

                zipPath = Path.Combine(Path.GetTempPath(), "AcademyBianlun_" + Process.GetCurrentProcess().Id + ".zip");
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
                    if (left != 0) throw new Exception("\u5B89\u88C5\u5305\u6570\u636E\u8BFB\u53D6\u4E0D\u5B8C\u6574\u3002");
                }

                extractDir = Path.Combine(Path.GetTempPath(), "AcademyBianlun_" + Process.GetCurrentProcess().Id);
                if (Directory.Exists(extractDir)) Directory.Delete(extractDir, true);
                SetStatus("\u6B63\u5728\u89E3\u538B\u7A0B\u5E8F\u6587\u4EF6\u2026");
                ZipFile.ExtractToDirectory(zipPath, extractDir);
                try { File.Delete(zipPath); } catch { }
                zipPath = null;

                SetStatus("\u6B63\u5728\u5B89\u88C5\u7A0B\u5E8F\u6587\u4EF6\u2026");

                char Q = (char)34;
                string bat = Path.Combine(extractDir, "setup.bat");
                StringBuilder args = new StringBuilder();
                args.Append("/c ").Append(Q).Append(Q).Append(bat).Append(Q).Append(" ").Append(Q).Append(installDir).Append(Q);
                // 两个开关都显式传：不勾时传 nodesktop/nomenu，
                // 否则 setup.bat 分不清「用户取消勾选」和「调用方没表态」
                args.Append(chkDesktop.Checked ? " desktop" : " nodesktop");
                args.Append(chkMenu.Checked ? " menu" : " nomenu");
                args.Append(Q);

                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = args.ToString(),
                    WorkingDirectory = extractDir,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                Program.Log("starting setup.bat: " + psi.Arguments);
                Process p = Process.Start(psi);
                if (p == null) throw new Exception("\u65E0\u6CD5\u542F\u52A8\u5B89\u88C5\u7A0B\u5E8F\u3002");
                p.WaitForExit();
                Program.Log("setup.bat exit=" + p.ExitCode);
                if (p.ExitCode != 0)
                {
                    throw new Exception(
                        "\u5B89\u88C5\u5931\u8D25\uFF08\u9519\u8BEF\u7801 " + p.ExitCode + ")" + Environment.NewLine + Environment.NewLine +
                        "\u76EE\u6807\u4F4D\u7F6E\uFF1A" + installDir + Environment.NewLine + Environment.NewLine +
                        "\u8BF7\u5173\u95ED\u6740\u6BD2\u8F6F\u4EF6\u540E\u91CD\u8BD5\uFF0C\u6216\u628A\u672C\u7A0B\u5E8F\u540C\u76EE\u5F55\u7684 zip \u89E3\u538B\u540E\uFF0C\u53CC\u51FB\u300C\u4E00\u952E\u5B89\u88C5.bat\u300D\u3002");
                }

                BeginInvoke((MethodInvoker)delegate
                {
                    Program.Log("install success");
                    finished = true;
                    Close();

                    string msg = "\u5B89\u88C5\u5B8C\u6210\uFF01" + Environment.NewLine + Environment.NewLine +
                                 "\u5DF2\u5B89\u88C5\u5230\uFF1A" + Environment.NewLine + installDir + Environment.NewLine + Environment.NewLine;
                    msg += chkDesktop.Checked ? "\u4EE5\u540E\u53CC\u51FB\u684C\u9762\u4E0A\u7684\u300CAcademy \u8FA9\u8BBA\u6559\u7EC3\u300D\u56FE\u6807\u5373\u53EF\u4F7F\u7528\u3002" + Environment.NewLine : "\uFF08\u4F60\u9009\u4E86\u4E0D\u5728\u684C\u9762\u653E\u5FEB\u6377\u65B9\u5F0F\uFF0C\u4EE5\u540E\u53EF\u4ECE\u5F00\u59CB\u83DC\u5355\u6253\u5F00\uFF09" + Environment.NewLine;
                    msg += "\u4E0D\u60F3\u7528\u4E86\uFF1F\u5F00\u59CB\u83DC\u5355\u91CC\u6709\u300C\u5378\u8F7D\u300D\uFF0C\u5378\u8F7D\u524D\u4F1A\u81EA\u52A8\u5907\u4EFD\u4F60\u7684\u6570\u636E\u3002" + Environment.NewLine + Environment.NewLine + "\u8981\u73B0\u5728\u6253\u5F00\u5B89\u88C5\u6587\u4EF6\u5939\u770B\u770B\u5417\uFF1F";

                    DialogResult openIt = MessageBox.Show(msg, "Academy \u8FA9\u8BBA\u6559\u7EC3 \u5B89\u88C5\u5411\u5BFC", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                    if (openIt == DialogResult.Yes)
                    {
                        try
                        {
                            if (Directory.Exists(installDir))
                            {
                                Process.Start(new ProcessStartInfo
                                {
                                    FileName = "explorer.exe",
                                    Arguments = Q + installDir + Q,
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
                    MessageBox.Show(ex.Message, "Academy \u8FA9\u8BBA\u6559\u7EC3 \u5B89\u88C5\u5411\u5BFC", MessageBoxButtons.OK, MessageBoxIcon.Error);
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

                long scanLen = Math.Min(size, 2L * 1024L * 1024L);
                byte[] window = new byte[scanLen];
                if (!ReadFully(fs, 0, window)) return false;
                long found = IndexOf(window, magic, 0, window.Length - magic.Length);
                if (found >= 0) return ValidateOffset(fs, size, found, out offset, out length);

                long windowStart = Math.Max(0, size - magic.Length - 8L * 1024L * 1024L);
                int windowLen = (int)(size - windowStart);
                window = new byte[windowLen];
                if (!ReadFully(fs, windowStart, window)) return false;
                long idx = IndexOf(window, magic, 0, windowLen - magic.Length);
                if (idx >= 0) return ValidateOffset(fs, size, windowStart + idx, out offset, out length);
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
            if (!(sig[0] == 0x50 && sig[1] == 0x4B)) return false;
            offset = candidate;
            length = size - zipStart;
            return true;
        }
    }
}
