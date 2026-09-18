// Academy 辩论教练 - 修复补丁外壳（自解压 + 自动定位 + 备份 + 校验）
// 许可：CC BY-NC-SA 4.0（署名 · 非商业性使用 · 相同方式共享）
//
// 与 SfxLauncher.cs（首个安装向导）的分工：
//   SfxLauncher   = 初次安装：让用户选目录，解压整包（约 175MB），跑 setup.bat
//   PatchLauncher = 已装用户升级：**自动找到安装目录**，只解压几十 KB 的改动文件，就地覆盖
//
// 为什么需要它：老用户为了一个 PDF 修复去重下 175MB 安装包是不合理的。
// 补丁包只带改动过的文件（实测约 2MB 压缩后），双击一次即可完成。
//
// 【安全底线】补丁会覆盖程序文件，所以：
//   1. 覆盖前先把原有 app/ 整个备份到 _patch_backup/<时间戳>/
//   2. 每个文件写完立即用 SHA256 校验，对不上就整体回滚
//   3. 任何异常都回滚，绝不留下半新半旧的安装
//
// 【编码约定】本文件用 csc /codepage:65001 编译，所以界面中文可以直写；
// 但**仍然不含任何 C# 字符串转义反斜杠**（换行走 Environment.NewLine、引号走 (char)34），
// 免得哪天有人在别的代码页下编译，转义序列先被吃掉一层。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Academy 辩论教练 修复补丁")]
[assembly: AssemblyDescription("Academy Debate Coach Patch (QFUD)")]
[assembly: AssemblyProduct("Academy 辩论教练")]
[assembly: AssemblyCompany("QFUD")]
[assembly: AssemblyVersion("1.0.0.0")]

namespace AcademyPatch
{
    internal static class Program
    {
        // 与安装版外壳刻意用不同的魔术标记：两者都是「exe + 标记 + zip」拼接，
        // 用同一个标记的话，拿错文件也能解出内容，排查时就分不清了。
        internal static readonly byte[] Magic = Encoding.ASCII.GetBytes("ACADEMY-PATCH-OVERLAY-V1-9D4B7E3A15C8");

        internal static readonly string LogPath = Path.Combine(Path.GetTempPath(), "AcademyBianlunPatch.log");
        internal static readonly string DefaultInstallDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AcademyDebateCoach");

        internal static void Log(string msg)
        {
            try
            {
                File.AppendAllText(LogPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + msg + Environment.NewLine);
            }
            catch { }
        }

        [STAThread]
        private static int Main(string[] args)
        {
            Log("patch launcher started");
            bool silent = false;
            string forcedDir = null;
            string sawDirFlag = null;   // 记录「调用方确实给过 --dir=」（哪怕值是空的）
            foreach (string a in args)
            {
                string s = (a ?? "").Trim();
                if (string.Equals(s, "--silent", StringComparison.OrdinalIgnoreCase)) silent = true;
                else if (s.StartsWith("--dir=", StringComparison.OrdinalIgnoreCase)) { sawDirFlag = s; forcedDir = s.Substring(6).Trim().Trim((char)34); }
            }

            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                string exePath = Application.ExecutablePath;
                string zipPath = Path.Combine(Path.GetTempPath(), "AcademyPatch_" + Process.GetCurrentProcess().Id + ".zip");
                string workDir = Path.Combine(Path.GetTempPath(), "AcademyPatch_" + Process.GetCurrentProcess().Id);

                if (!Unpack(exePath, zipPath, workDir))
                {
                    return Fail(silent, "补丁数据不完整，请重新下载这个补丁文件。");
                }

                PatchInfo info = PatchInfo.Load(workDir);
                if (info == null || !info.IsUsable)
                {
                    Cleanup(zipPath, workDir);
                    return Fail(silent, "补丁包内容异常（缺少 patch.txt 或 payload 目录）。");
                }
                Log("patch info: " + info.Name + " -> v" + info.ToVersion);

                /* --dir= 给了却是空值（调用方参数被拆开、或传了空串）时**不要**退回自动探测：
                   探测到的是「快捷方式指向的目录」，未必是调用方想改的那一个。
                   实测踩过：参数被 PowerShell 拆成 "--dir=" + 路径两段，补丁就静默打到了
                   另一个目录。宁可明确报错，也不要猜。 */
                if (sawDirFlag != null && string.IsNullOrEmpty(forcedDir))
                {
                    return Fail(silent, "--dir= 后面没有给出目录路径。" + Environment.NewLine + Environment.NewLine
                        + "用法：AcademyPatch.exe --silent --dir=" + (char)34 + "某个安装目录" + (char)34 + Environment.NewLine
                        + "（路径含空格或中文时，请把整个 --dir=... 用双引号包起来）");
                }

                /* ★ 调用方**明确**给了 --dir 时，只用它 —— 绝不回退自动探测（实测吃过大亏）：
                   传了一个「不是安装目录」的路径进来（比如参数被 PowerShell 拆成
                   "--dir=" + 路径 两段，拼起来成了一个坏路径），旧逻辑判定「不是安装目录」
                   就默默转去自动探测，结果探测到桌面快捷方式指向的开发目录、把补丁打到了
                   完全不相干的地方，而调用方还以为成功了（exit 0）。
                   「明确指定」和「没指定」是两件不同的事，不能混。 */
                string dir;
                if (!string.IsNullOrEmpty(forcedDir))
                {
                    if (!IsInstallDir(forcedDir))
                    {
                        return Fail(silent, "指定的目录不是辩论教练的安装目录：" + Environment.NewLine
                            + forcedDir + Environment.NewLine + Environment.NewLine
                            + "正确的安装目录里应该能看到 app 和 runtime 两个子文件夹。");
                    }
                    dir = Path.GetFullPath(forcedDir);
                }
                else
                {
                    dir = LocateInstallDir(null, workDir);
                }
                if (dir == null)
                {
                    return Fail(silent, "没有找到辩论教练的安装目录。" + Environment.NewLine + Environment.NewLine
                        + "请点「更改…」手动选中安装文件夹（里面应该有 app 和 runtime 两个子目录）。");
                }
                Log("install dir: " + dir);

                if (silent)
                {
                    PatchApplier applier = new PatchApplier(workDir, dir, info, null);
                    int rc = applier.Run();
                    Cleanup(zipPath, workDir);
                    return rc;
                }

                using (PatchForm form = new PatchForm(workDir, dir, info))
                {
                    Application.Run(form);
                    int rc = form.Result;
                    Cleanup(zipPath, workDir);
                    return rc;
                }
            }
            catch (Exception ex)
            {
                Log("FATAL: " + ex);
                return Fail(silent, "补丁执行失败：" + Environment.NewLine + ex.Message);
            }
        }

        private static int Fail(bool silent, string msg)
        {
            Log("FAIL: " + msg);
            if (!silent) MessageBox.Show(msg, "Academy 辩论教练 修复补丁", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        private static void Cleanup(string zipPath, string workDir)
        {
            try { if (File.Exists(zipPath)) File.Delete(zipPath); } catch { }
            for (int i = 0; i < 6; i++)
            {
                try
                {
                    if (Directory.Exists(workDir)) Directory.Delete(workDir, true);
                    break;
                }
                catch { Thread.Sleep(300); }
            }
        }

        // ---------- 解包：从自身读出「标记 + zip」 ----------
        private static bool Unpack(string exePath, string zipPath, string workDir)
        {
            try
            {
                long offset, length;
                if (!Overlay.Find(exePath, Magic, out offset, out length)) return false;
                Log("overlay offset=" + offset + " length=" + length);

                using (FileStream src = new FileStream(exePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (FileStream dst = new FileStream(zipPath, FileMode.Create, FileAccess.Write))
                {
                    src.Seek(offset + Magic.Length, SeekOrigin.Begin);
                    byte[] buffer = new byte[1024 * 1024];
                    long left = length;
                    while (left > 0)
                    {
                        int n = src.Read(buffer, 0, (int)Math.Min(buffer.Length, left));
                        if (n <= 0) break;
                        dst.Write(buffer, 0, n);
                        left -= n;
                    }
                    if (left != 0) return false;
                }

                if (Directory.Exists(workDir)) Directory.Delete(workDir, true);
                ZipFile.ExtractToDirectory(zipPath, workDir);
                return true;
            }
            catch (Exception ex)
            {
                Log("unpack failed: " + ex);
                return false;
            }
        }

        // ---------- 自动定位安装目录 ----------
        // 顺序：命令行 > 默认位置 > 桌面快捷方式 > 开始菜单快捷方式 > 常见位置
        // 自定义安装目录的用户，快捷方式是最可靠的线索（安装时就是从那里指过去的）
        internal static string LocateInstallDir(string forcedDir, string workDir)
        {
            if (!string.IsNullOrEmpty(forcedDir) && IsInstallDir(forcedDir)) return Path.GetFullPath(forcedDir);

            if (IsInstallDir(DefaultInstallDir)) return DefaultInstallDir;

            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
            string fromDesktop = FromShortcut(Path.Combine(desktop, "Academy辩论教练.lnk"));
            if (fromDesktop != null) return fromDesktop;

            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            string fromMenu = FromShortcut(Path.Combine(programs, "Academy辩论教练", "Academy辩论教练.lnk"));
            if (fromMenu != null) return fromMenu;
            // 开始菜单目录名可能带型号后缀（如 Pro），再扫一层
            try
            {
                if (Directory.Exists(programs))
                {
                    foreach (string d in Directory.GetDirectories(programs, "Academy*"))
                    {
                        foreach (string f in Directory.GetFiles(d, "*.lnk"))
                        {
                            string r = FromShortcut(f);
                            if (r != null) return r;
                        }
                    }
                }
            }
            catch { }

            // 常见位置兜底（不做全盘扫描：太慢，而且用户能看到界面自己改）
            foreach (string root in DriveRoots())
            {
                foreach (string rel in new string[] { "AcademyDebateCoach", "Program Files" + Path.DirectorySeparatorChar + "AcademyDebateCoach", "Programs" + Path.DirectorySeparatorChar + "AcademyDebateCoach" })
                {
                    string p = Path.Combine(root, rel);
                    if (IsInstallDir(p)) return p;
                }
            }
            return null;
        }

        private static IEnumerable<string> DriveRoots()
        {
            DriveInfo[] all = null;
            try { all = DriveInfo.GetDrives(); } catch { }
            if (all == null) yield break;
            foreach (DriveInfo d in all)
            {
                bool ok = false;
                try { ok = d.IsReady && d.DriveType == DriveType.Fixed; } catch { }
                if (ok) yield return d.RootDirectory.FullName;
            }
        }

        // 读 .lnk 的 TargetPath / WorkingDirectory（走 WScript.Shell COM，不需要额外引用）
        internal static string FromShortcut(string lnkPath)
        {
            try
            {
                if (!File.Exists(lnkPath)) return null;
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType == null) return null;
                object shell = Activator.CreateInstance(shellType);
                object lnk = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
                string workDir = Convert.ToString(shellType.InvokeMember("WorkingDirectory", BindingFlags.GetProperty, null, lnk, null));
                string target = Convert.ToString(shellType.InvokeMember("TargetPath", BindingFlags.GetProperty, null, lnk, null));
                // 目标通常是 <安装目录>/runtime/electron/dist/electron.exe，往上退三级
                foreach (string cand in new string[] { workDir, DeriveFromElectron(target) })
                {
                    if (!string.IsNullOrEmpty(cand) && IsInstallDir(cand)) return Path.GetFullPath(cand);
                }
            }
            catch (Exception ex) { Log("shortcut read failed: " + lnkPath + " " + ex.Message); }
            return null;
        }

        private static string DeriveFromElectron(string electronPath)
        {
            try
            {
                if (string.IsNullOrEmpty(electronPath)) return null;
                // <dir>/runtime/electron/dist/electron.exe -> 上溯 4 层到 <dir>
                string d = Path.GetDirectoryName(electronPath);
                for (int i = 0; i < 3 && !string.IsNullOrEmpty(d); i++) d = Path.GetDirectoryName(d);
                return d;
            }
            catch { return null; }
        }

        // 判定「像不像一个安装目录」：必须有 app/server.js 与内置 node
        internal static bool IsInstallDir(string dir)
        {
            try
            {
                if (string.IsNullOrEmpty(dir)) return false;
                string d = dir.Trim().TrimEnd(Path.DirectorySeparatorChar);
                if (!Directory.Exists(d)) return false;
                bool a = File.Exists(Path.Combine(d, Path.Combine("app", "server.js")));
                bool b = File.Exists(Path.Combine(d, Path.Combine("runtime", Path.Combine("node", "node.exe"))));
                return a && b;
            }
            catch { return false; }
        }
    }

    // ---------- 补丁清单 ----------
    internal sealed class PatchInfo
    {
        internal string Name = "Academy 辩论教练 修复补丁";
        internal string ToVersion = "";
        internal string FromVersion = "";
        internal string Notes = "";
        internal string BuiltAt = "";
        internal int FileCount = 0;
        internal long TotalBytes = 0;
        internal string PayloadDir;

        internal bool IsUsable
        {
            get { return !string.IsNullOrEmpty(PayloadDir) && Directory.Exists(PayloadDir); }
        }

        internal static PatchInfo Load(string workDir)
        {
            try
            {
                string manifest = Path.Combine(workDir, "patch.txt");
                if (!File.Exists(manifest)) return null;
                PatchInfo info = new PatchInfo();
                foreach (string raw in File.ReadAllLines(manifest, Encoding.UTF8))
                {
                    string line = (raw ?? "").Trim();
                    if (line.Length == 0 || line.StartsWith("#")) continue;
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    string k = line.Substring(0, eq).Trim().ToLowerInvariant();
                    string v = line.Substring(eq + 1).Trim();
                    switch (k)
                    {
                        case "name": info.Name = v; break;
                        case "toversion": info.ToVersion = v; break;
                        case "fromversion": info.FromVersion = v; break;
                        case "notes": info.Notes = v; break;
                        case "builtat": info.BuiltAt = v; break;
                        case "filecount": info.FileCount = ToInt(v); break;
                        case "totalbytes": info.TotalBytes = ToLong(v); break;
                        case "payload": info.PayloadDir = Path.Combine(workDir, v); break;
                    }
                }
                if (info.PayloadDir == null) info.PayloadDir = Path.Combine(workDir, "payload");
                return info;
            }
            catch (Exception ex) { Program.Log("manifest load failed: " + ex.Message); return null; }
        }

        private static int ToInt(string s) { int n; int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out n); return n; }
        private static long ToLong(string s) { long n; long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out n); return n; }
    }

    // ---------- 找叠加数据 ----------
    internal static class Overlay
    {
        internal static bool Find(string exePath, byte[] magic, out long offset, out long length)
        {
            offset = 0; length = 0;
            using (FileStream fs = new FileStream(exePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                long size = fs.Length;
                if (size < magic.Length + 64) return false;

                // 外壳只有几十 KB，标记必定在前 2MB 内
                long scanLen = Math.Min(size, 2L * 1024L * 1024L);
                byte[] window = new byte[scanLen];
                if (!ReadFully(fs, 0, window)) return false;
                long found = IndexOf(window, magic, 0, (int)(window.Length - magic.Length));
                if (found >= 0) return Validate(fs, size, found, out offset, out length);

                // 兜底：从尾部往前找（万一外壳变大）
                long start = Math.Max(0, size - magic.Length - 8L * 1024L * 1024L);
                byte[] tail = new byte[size - start];
                if (!ReadFully(fs, start, tail)) return false;
                long idx = IndexOf(tail, magic, 0, (int)(tail.Length - magic.Length));
                if (idx >= 0) return Validate(fs, size, start + idx, out offset, out length);
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

        private static bool Validate(FileStream fs, long size, long candidate, out long offset, out long length)
        {
            offset = 0; length = 0;
            long start = candidate + Program.Magic.Length;
            if (start + 4 > size) return false;
            fs.Seek(start, SeekOrigin.Begin);
            byte[] sig = new byte[4];
            if (fs.Read(sig, 0, 4) != 4) return false;
            if (!(sig[0] == 0x50 && sig[1] == 0x4B)) return false;
            offset = candidate;
            length = size - start;
            return true;
        }
    }

    // ---------- 实际打补丁（备份 → 覆盖 → 校验 → 必要时回滚） ----------
    internal sealed class PatchApplier
    {
        private readonly string workDir;
        private readonly string installDir;
        private readonly PatchInfo info;
        private readonly Action<string, int, int> report;
        private List<string> backupTargets;
        // 顶层**文件**（如 LICENSE.md / 使用说明.txt）也要单独备份：
        // 它们没有所属子目录，只备份目录会让这些文件被覆盖后无法还原（实测发现的漏洞）。
        private List<string> backupFiles;
        private List<PatchEntry> backupEntries;   // 回滚依据：逐个文件，不看目录

        internal int Processed;
        internal int Total;
        internal string BackupDir;
        internal Exception Failure;

        internal PatchApplier(string workDir, string installDir, PatchInfo info, Action<string, int, int> report)
        {
            this.workDir = workDir;
            this.installDir = installDir;
            this.info = info;
            this.report = report;
        }

        private void Say(string msg, int cur, int total)
        {
            Program.Log(msg);
            if (report != null) report(msg, cur, total);
        }

        internal int Run()
        {
            try
            {
                Say("正在关闭运行中的辩论教练…", 0, 1);
                StopRunningApp();
                Thread.Sleep(800);

                string listPath = Path.Combine(workDir, "files.sha256");
                if (!File.Exists(listPath)) throw new Exception("补丁包缺少文件清单（files.sha256）。");
                List<PatchEntry> entries = PatchEntry.Load(listPath);
                if (entries.Count == 0) throw new Exception("补丁包的文件清单是空的。");
                Total = entries.Count;

                /* 备份**逐个文件**做，不做整目录备份/还原 —— 这是踩过坑之后改的：
                   早先按顶层目录备份（app/、tools/…），回滚时先 Directory.Delete 整个 app
                   再 CopyDir 还原。只要有一个文件被别的进程占用（实测：独占锁定
                   app/server.js），CopyDir 走到它就抛异常，**整个 app 的还原就地中断**，
                   结果留下一半新一半旧的安装 —— 正是回滚本该避免的情况。
                   逐文件的好处：某个文件还原不了，只影响它自己，其余照常还原。 */
                backupTargets = new List<string>();
                backupFiles = new List<string>();
                string stamp = DateTime.Now.ToString("yyyy-MM-dd_HHmmss", CultureInfo.InvariantCulture);
                BackupDir = Path.Combine(installDir, "_patch_backup", stamp);

                backupEntries = new List<PatchEntry>(entries);
                int bi = 0;
                foreach (PatchEntry e in entries)
                {
                    bi++;
                    string live = Path.Combine(installDir, e.Relative);
                    string top = e.Relative.Split(Path.DirectorySeparatorChar)[0];
                    if (e.Relative.IndexOf(Path.DirectorySeparatorChar) < 0)
                    {
                        if (!backupFiles.Contains(top)) backupFiles.Add(top);
                    }
                    else if (!backupTargets.Contains(top)) backupTargets.Add(top);
                    e.ExistedBefore = File.Exists(live);   // 回滚时据此决定「拷回」还是「删掉」
                    if (!e.ExistedBefore) continue;        // 打补丁前没有 → 无需备份
                    string bak = Path.Combine(BackupDir, e.Relative);
                    try
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(bak));
                        File.Copy(live, bak, true);
                    }
                    catch (Exception ex) { Program.Log("backup failed: " + e.Relative + " " + ex.Message); }
                    if (bi % 25 == 0) Say("正在备份原文件…（" + bi + "/" + entries.Count + "）", bi, entries.Count);
                }
                Say("原文件已备份。", entries.Count, entries.Count);

                int done = 0;
                foreach (PatchEntry e in entries)
                {
                    done++;
                    string src = Path.Combine(workDir, "payload", e.Relative);
                    string dst = Path.Combine(installDir, e.Relative);
                    Say("正在更新 " + Path.GetFileName(e.Relative) + " …（" + done + "/" + entries.Count + "）", done, entries.Count);

                    if (!File.Exists(src)) throw new Exception("补丁文件缺失：" + e.Relative);
                    if (!string.Equals(Sha256Of(src), e.Sha256, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new Exception("补丁包已损坏（" + e.Relative + " 校验不通过），请重新下载。");
                    }

                    string dir = Path.GetDirectoryName(dst);
                    if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                    File.Copy(src, dst, true);

                    // 写完立刻校验：杀软拦截 / 磁盘错误都能在这里被抓住，而不是等用户下次启动才发现
                    if (!string.Equals(Sha256Of(dst), e.Sha256, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new Exception("写入校验失败：" + e.Relative + "（可能被杀毒软件拦截或磁盘错误）");
                    }
                }
                Processed = done;

                try
                {
                    Directory.CreateDirectory(BackupDir);
                    StringBuilder note = new StringBuilder();
                    note.AppendLine("Academy 辩论教练 · 补丁备份");
                    note.AppendLine("补丁：" + info.Name);
                    note.AppendLine("时间：" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture));
                    note.AppendLine("更新文件数：" + entries.Count);
                    note.AppendLine("被替换的目录：" + string.Join("、", backupTargets.ToArray()));
                    note.AppendLine();
                    note.AppendLine("想还原到打补丁之前：把本目录下的同名文件夹覆盖回安装目录即可。");
                    File.WriteAllText(Path.Combine(BackupDir, "README.txt"), note.ToString(), new UTF8Encoding(false));
                }
                catch { }

                Say("修复完成。", entries.Count, entries.Count);
                return 0;
            }
            catch (Exception ex)
            {
                Failure = ex;
                Program.Log("apply failed, rolling back: " + ex);
                Say("出错了，正在自动还原…", 0, 1);
                try
                {
                    int leftOver = Rollback();
                    Program.Log("rollback finished, failed=" + leftOver);
                    // 有文件没能还原时必须让用户知道 —— 不能默默报「已还原」却留着半新半旧
                    if (leftOver > 0)
                    {
                        Failure = new Exception(ex.Message + Environment.NewLine + Environment.NewLine
                            + "另外有 " + leftOver + " 个文件没能自动还原（多半是被占用）。"
                            + "建议重启电脑后，用完整安装包重新安装一次。");
                    }
                }
                catch (Exception rb) { Program.Log("rollback failed: " + rb); }
                return 1;
            }
        }

        /* 逐文件回滚。清单就是权威：每个条目要么「有备份 → 拷回去」，
           要么「原本不存在 → 删掉」。单个文件失败只记日志、继续下一个，
           绝不因为它中断整轮回滚（那正是旧版留下半新半旧安装的原因）。
           返回没能还原的文件数，供上层如实汇报。 */
        internal int Rollback()
        {
            if (backupEntries == null) return 0;
            int failed = 0;
            int n = 0;
            foreach (PatchEntry e in backupEntries)
            {
                n++;
                string live = Path.Combine(installDir, e.Relative);
                string bak = Path.Combine(BackupDir, e.Relative);
                try
                {
                    if (File.Exists(bak))
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(live));
                        File.Copy(bak, live, true);
                    }
                    else if (e.ExistedBefore)
                    {
                        // 备份时它在，现在备份却没了 —— 异常情况，保留现场不动
                        Program.Log("rollback: backup missing for " + e.Relative + ", left as-is");
                        failed++;
                        continue;
                    }
                    else
                    {
                        // 补丁新建的文件：删掉才算还原
                        if (File.Exists(live)) File.Delete(live);
                    }
                }
                catch (Exception ex)
                {
                    Program.Log("rollback failed: " + e.Relative + " " + ex.Message);
                    failed++;
                }
                if (n % 25 == 0) Say("正在还原…（" + n + "/" + backupEntries.Count + "）", n, backupEntries.Count);
            }
            return failed;
        }

        // 用 PowerShell + WMI 关闭：比 Process.MainModule 稳（后者读别的用户/受保护进程会抛异常）
        private void StopRunningApp()
        {
            /* ★ 两条硬规则，都是踩出来的（详见文件末尾注释）：
               ① 脚本正文必须是**纯 ASCII**，安装路径通过命令行参数传进去；
               ② 脚本文件必须带 BOM 写盘。
               早先的写法是把安装路径拼进脚本正文、且不带 BOM —— 而工作区/安装目录几乎
               必然含中文，PowerShell 5.1 对**无 BOM 的 .ps1 按系统 ANSI 解码**，中文路径
               变成乱码，脚本直接语法报错、整段静默失败。后果很隐蔽：补丁照样 exit 0、
               文件照样替换成功，但**旧进程没被关掉，用户重启前一直看着旧界面**。 */
            try
            {
                string ps1 = Path.Combine(Path.GetTempPath(), "academy_patch_stop_" + Process.GetCurrentProcess().Id + ".ps1");
                StringBuilder sb = new StringBuilder();
                sb.AppendLine("$ErrorActionPreference='SilentlyContinue'");
                sb.AppendLine("$dest = $args[0]");
                sb.AppendLine("if (-not $dest) { exit 3 }");
                sb.AppendLine("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains($dest) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }");
                sb.AppendLine("Get-Process electron | Where-Object { $_.Path -and $_.Path.StartsWith($dest) } | ForEach-Object { Stop-Process -Id $_.Id -Force }");
                sb.AppendLine("Start-Sleep -Milliseconds 1500");
                sb.AppendLine("$left = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains($dest) })");
                sb.AppendLine("if ($left.Count -eq 0) { exit 0 } else { exit 1 }");
                // BOM + UTF8：即便正文已纯 ASCII，带 BOM 也让它不依赖系统代码页
                File.WriteAllText(ps1, sb.ToString(), new UTF8Encoding(true));

                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    // 路径走参数（.NET 以 UTF-16 传参，不受代码页影响），不要拼进脚本正文
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -File " + (char)34 + ps1 + (char)34
                        + " " + (char)34 + installDir + (char)34,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                Process p = Process.Start(psi);
                if (p != null)
                {
                    p.WaitForExit(25000);
                    Program.Log("stop-app helper exit=" + p.ExitCode);
                    if (p.ExitCode != 0)
                    {
                        Program.Log("WARNING: 仍有进程占用安装目录，覆盖可能不完整");
                    }
                }
                try { File.Delete(ps1); } catch { }
            }
            catch (Exception ex) { Program.Log("stop app failed: " + ex.Message); }
        }

        internal void RestartApp()
        {
            try
            {
                string vbs = Path.Combine(installDir, "launch.vbs");
                if (File.Exists(vbs))
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = "wscript.exe",
                        Arguments = (char)34 + vbs + (char)34,
                        UseShellExecute = true,
                        WorkingDirectory = installDir
                    });
                }
            }
            catch (Exception ex) { Program.Log("restart failed: " + ex.Message); }
        }

        private static void CopyDir(string src, string dst)
        {
            Directory.CreateDirectory(dst);
            foreach (string f in Directory.GetFiles(src)) File.Copy(f, Path.Combine(dst, Path.GetFileName(f)), true);
            foreach (string d in Directory.GetDirectories(src)) CopyDir(d, Path.Combine(dst, Path.GetFileName(d)));
        }

        internal static string Sha256Of(string path)
        {
            using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (SHA256 sha = SHA256.Create())
            {
                byte[] h = sha.ComputeHash(fs);
                StringBuilder sb = new StringBuilder(h.Length * 2);
                foreach (byte b in h) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }
    }

    // ---------- 清单条目 ----------
    internal sealed class PatchEntry
    {
        internal string Sha256;
        internal string Relative;
        internal bool ExistedBefore;   // 打补丁前该文件是否存在（决定回滚时是「拷回」还是「删掉」）

        internal PatchEntry(string sha, string rel) { Sha256 = sha; Relative = rel; }

        internal static List<PatchEntry> Load(string listPath)
        {
            List<PatchEntry> list = new List<PatchEntry>();
            foreach (string raw in File.ReadAllLines(listPath, Encoding.UTF8))
            {
                string line = (raw ?? "").Trim();
                if (line.Length == 0 || line.StartsWith("#")) continue;
                // 格式：<sha256>  <相对路径>；清单里统一用正斜杠，这里换成本机分隔符
                int sp = line.IndexOf(' ');
                if (sp <= 0) continue;
                string hash = line.Substring(0, sp).Trim();
                string rel = line.Substring(sp).Trim();
                if (hash.Length != 64 || rel.Length == 0) continue;
                list.Add(new PatchEntry(hash, rel.Replace('/', Path.DirectorySeparatorChar)));
            }
            return list;
        }
    }

    // ---------- 界面 ----------
    internal sealed class PatchForm : Form
    {
        private readonly string workDir;
        private readonly PatchInfo info;
        private Panel choosePage;
        private Panel progressPage;
        private TextBox pathBox;
        private Label statusLabel;
        private ProgressBar progressBar;
        private string installDir;
        private PatchApplier applier;
        private bool running;
        private bool restart;

        internal int Result;

        internal PatchForm(string workDir, string detectedDir, PatchInfo info)
        {
            this.workDir = workDir;
            this.info = info;
            this.installDir = detectedDir;

            Text = "Academy 辩论教练 · 修复补丁";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(600, 396);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            choosePage = BuildChoosePage();
            progressPage = BuildProgressPage();
            Controls.Add(choosePage);
            Controls.Add(progressPage);
            progressPage.Visible = false;

            statusLabel = (Label)progressPage.Controls["statusLabel"];
            progressBar = (ProgressBar)progressPage.Controls["progressBar"];
        }

        private Panel BuildChoosePage()
        {
            Panel p = new Panel { Dock = DockStyle.Fill };

            Label title = new Label
            {
                AutoSize = true,
                Location = new Point(24, 16),
                Font = new Font("Microsoft YaHei UI", 13F, FontStyle.Bold),
                Text = "修复补丁"
            };
            Label sub = new Label
            {
                AutoSize = false,
                Location = new Point(26, 52),
                Size = new Size(548, 22),
                Font = new Font("Microsoft YaHei UI", 9.5F),
                ForeColor = Color.FromArgb(60, 90, 160),
                Text = info.Name + (info.ToVersion.Length > 0 ? "　→　版本 " + info.ToVersion : "")
            };
            Label cap = new Label
            {
                AutoSize = true,
                Location = new Point(26, 86),
                Font = new Font("Microsoft YaHei UI", 9F),
                Text = "安装位置："
            };
            pathBox = new TextBox
            {
                Location = new Point(26, 108),
                Size = new Size(430, 26),
                Font = new Font("Microsoft YaHei UI", 9F),
                Text = installDir
            };
            Button browse = new Button
            {
                Location = new Point(464, 107),
                Size = new Size(110, 28),
                Text = "更改…"
            };
            browse.Click += OnBrowse;

            Label notesCap = new Label
            {
                AutoSize = true,
                Location = new Point(26, 146),
                Font = new Font("Microsoft YaHei UI", 9F),
                Text = "本次修复："
            };
            TextBox notes = new TextBox
            {
                Location = new Point(26, 168),
                Size = new Size(548, 118),
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                Font = new Font("Microsoft YaHei UI", 9F),
                BackColor = Color.FromArgb(248, 249, 252),
                Text = info.Notes
            };
            Label hint = new Label
            {
                AutoSize = false,
                Location = new Point(26, 294),
                Size = new Size(548, 20),
                Font = new Font("Microsoft YaHei UI", 8.5F),
                ForeColor = Color.FromArgb(130, 130, 130),
                Text = "覆盖前会自动备份原文件，出问题会自行还原。你的对话记录和资料不会被动。"
            };

            Button go = new Button
            {
                Location = new Point(342, 340),
                Size = new Size(120, 34),
                Text = "开始修复"
            };
            go.Click += OnApplyClick;
            Button quit = new Button
            {
                Location = new Point(472, 340),
                Size = new Size(102, 34),
                Text = "取消"
            };
            quit.Click += delegate { Result = 2; Close(); };

            p.Controls.Add(title);
            p.Controls.Add(sub);
            p.Controls.Add(cap);
            p.Controls.Add(pathBox);
            p.Controls.Add(browse);
            p.Controls.Add(notesCap);
            p.Controls.Add(notes);
            p.Controls.Add(hint);
            p.Controls.Add(go);
            p.Controls.Add(quit);
            return p;
        }

        private Panel BuildProgressPage()
        {
            Panel p = new Panel { Dock = DockStyle.Fill };

            Label st = new Label
            {
                Name = "statusLabel",
                AutoSize = false,
                Location = new Point(28, 30),
                Size = new Size(548, 24),
                Font = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold),
                Text = "正在准备…"
            };
            Label cap = new Label
            {
                AutoSize = true,
                Location = new Point(28, 74),
                Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold),
                Text = "安装位置："
            };
            Label path = new Label
            {
                Name = "pathLabel",
                AutoSize = false,
                Location = new Point(28, 96),
                Size = new Size(548, 22),
                Font = new Font("Microsoft YaHei UI", 9F),
                ForeColor = Color.FromArgb(60, 90, 160),
                AutoEllipsis = true,
                Text = ""
            };
            Label keep = new Label
            {
                AutoSize = true,
                Location = new Point(28, 132),
                Font = new Font("Microsoft YaHei UI", 8.5F),
                ForeColor = Color.FromArgb(120, 120, 120),
                Text = "正在更新文件，请不要关闭这个窗口。"
            };
            ProgressBar pb = new ProgressBar
            {
                Name = "progressBar",
                Style = ProgressBarStyle.Continuous,
                Minimum = 0,
                Maximum = 100,
                Location = new Point(28, 162),
                Size = new Size(548, 22)
            };

            p.Controls.Add(st);
            p.Controls.Add(cap);
            p.Controls.Add(path);
            p.Controls.Add(keep);
            p.Controls.Add(pb);
            return p;
        }

        private void OnBrowse(object sender, EventArgs e)
        {
            using (FolderBrowserDialog dlg = new FolderBrowserDialog())
            {
                dlg.Description = "选中辩论教练的安装文件夹（里面应该能看到 app 和 runtime）";
                dlg.ShowNewFolderButton = false;
                try { if (Directory.Exists(pathBox.Text)) dlg.SelectedPath = pathBox.Text; } catch { }
                if (dlg.ShowDialog(this) == DialogResult.OK && !string.IsNullOrEmpty(dlg.SelectedPath))
                {
                    pathBox.Text = dlg.SelectedPath;
                }
            }
        }

        private void OnApplyClick(object sender, EventArgs e)
        {
            string dir = (pathBox.Text ?? "").Trim().Trim((char)34);
            if (!Program.IsInstallDir(dir))
            {
                MessageBox.Show(
                    "这个文件夹看起来不是辩论教练的安装目录。" + Environment.NewLine + Environment.NewLine
                    + "正确的文件夹里应该能看到 app 和 runtime 两个子目录。" + Environment.NewLine + Environment.NewLine
                    + "现在选的是：" + Environment.NewLine + dir,
                    "Academy 辩论教练 · 修复补丁", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            installDir = Path.GetFullPath(dir);
            ((Label)progressPage.Controls["pathLabel"]).Text = installDir;
            choosePage.Visible = false;
            progressPage.Visible = true;
            running = true;
            Thread worker = new Thread(RunPatch);
            worker.IsBackground = true;
            worker.Start();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (running)
            {
                e.Cancel = true;
                MessageBox.Show("正在更新文件，请不要关闭这个窗口。", "Academy 辩论教练 · 修复补丁", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            base.OnFormClosing(e);
        }

        private void RunPatch()
        {
            applier = new PatchApplier(workDir, installDir, info, Report);
            int rc = applier.Run();
            Result = rc;

            BeginInvoke((MethodInvoker)delegate
            {
                running = false;
                if (rc == 0)
                {
                    DialogResult r = MessageBox.Show(
                        "修复完成！" + Environment.NewLine + Environment.NewLine
                        + "更新了 " + applier.Processed + " 个文件。" + Environment.NewLine
                        + "原文件已备份到安装目录的 _patch_backup 里。" + Environment.NewLine + Environment.NewLine
                        + "现在打开辩论教练吗？",
                        "Academy 辩论教练 · 修复补丁", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                    restart = (r == DialogResult.Yes);
                    Close();
                }
                else
                {
                    string msg = "修复没有成功，已经自动还原成打补丁之前的样子。" + Environment.NewLine + Environment.NewLine
                        + (applier.Failure != null ? applier.Failure.Message : "未知错误") + Environment.NewLine + Environment.NewLine
                        + "可以试试：关闭杀毒软件后重试，或用完整的安装包重新安装（数据不会丢）。" + Environment.NewLine + Environment.NewLine
                        + "详细日志：" + Program.LogPath;
                    MessageBox.Show(msg, "Academy 辩论教练 · 修复补丁", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    Close();
                }
            });
        }

        private void Report(string msg, int cur, int total)
        {
            try
            {
                if (!IsHandleCreated || IsDisposed) return;
                BeginInvoke((MethodInvoker)delegate
                {
                    statusLabel.Text = msg;
                    if (total > 0)
                    {
                        int pct = (int)Math.Round(100.0 * cur / total);
                        if (pct < 0) pct = 0;
                        if (pct > 100) pct = 100;
                        progressBar.Value = pct;
                    }
                });
            }
            catch { }
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            base.OnFormClosed(e);
            if (restart && applier != null) applier.RestartApp();
        }
    }
}
