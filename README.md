# Academy 辩论教练 · 本地桌面版（逻敏 v2.0.0）

> 当前发行版本：**v2.0.0**　|　App 内可在「⚙ 设置 → ℹ️ 关于应用」查看版本、开源许可与联系方式

> 📄 本知识库由 QFUD（驻青四校联合辩论培训计划）整理发布，
> 采用 知识共享署名-非商业性使用-相同方式共享 4.0 国际 (CC BY-NC-SA 4.0) 许可。
> 详情：https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh

> 华语辩论全链路 AI 教练：**备赛 · 复盘 · 评判**。封装 DSH 极简 Agent 内核 +
> 逻敏方法论知识库（蒸馏方法论），**解压即用，无需安装任何环境**。

---

## 一、这是什么

一个本地运行的辩论 AI 教练桌面应用：

| 组件 | 说明 |
|------|------|
| `runtime/node/` | 内置 Node.js v22，目标电脑无需安装 |
| `runtime/dsh/` | DeepSeek Harness 扁平内核，零链接可整体移动 |
| `app/server.js` | 本地 HTTP 服务 + Agent 封装层 |
| `app/docx.js` | 零依赖 Markdown → Word 生成器 |
| `app/ocr-win.js` | 本地 OCR（调用 Windows 自带识别引擎，图片入库时转文字，不出本机） |
| `app/md-reader-window.js` + `app/md-reader/` | 独立轻量阅读窗：双击 .md/.txt/.srt 直开小窗，不启动整套 App；一键跳完整版 |
| `app/electron-main.js` | 主窗口（完整版）；与轻量阅读窗彼此独立、可同时运行 |
| `app/public/` | HTML 前端（聊天界面、API Key 设置、工具箱页） |
| `knowledge/` `protocols/` `prep-coach/` 等 | 逻敏方法论知识库（17 篇方法论 + 模板 + 24 位辩手风格卡） |

## 二、快速开始（面向小白）

1. 解压发布包到任意目录（建议不要放 C 盘系统目录）
2. 双击 **`start.bat`**（安装版则双击桌面「Academy辩论教练」图标）
3. 弹出独立桌面窗口「逻敏 · Academy 辩论教练」——无浏览器标签栏 / 地址栏，**关窗即退出**
4. 首次使用：点右上角「⚙ 设置」，选择 API 服务商（DeepSeek / 硅基流动 / Moonshot / 智谱 / 自定义 OpenAI 兼容地址），填入 API Key 和模型名
5. 左侧选择「备赛 / 复盘 / 评判 / 自由问答」，输入任务，`Ctrl+Enter` 发送
6. 点「⬇ 导出当前会话」→ 下拉菜单选格式，整场对话可导出为 Word / Markdown / PDF
7. 没有黑窗口：程序跑在独立桌面窗口里，关闭窗口即退出

> **技能 / 插件**：设置 →「🧩 技能 / 插件」可导入用户自装 `.md` 技能（YAML frontmatter 需含 name + description）。
> 技能存放 `data/.dsh/skills/`（DSH 内核自动扫描目录），每次任务会把启用的技能清单注入任务单。
> **产物空间**：Agent 的长交付（备赛包/复盘/数据表等）可写入 `data/deliverables/`（文本类 .md/.csv/.txt），
> 顶部「📦 产物」面板可预览、转 Word/Excel/PDF（内置零依赖转档：md/txt→docx、csv→xlsx、md/txt/csv→pdf，
> PDF 走本机 Electron 打印，不联网、不依赖外部软件），并导出到任意文件夹。
## 三、Agent 是如何工作的

- 每次发送任务，`server.js` 写入 `data/tasks/*.md`，用内置 node 启动 DSH headless
- DSH 工作目录 = 本 App 根目录 → 自动加载 AGENTS.md，发现 `.dsh/skills/` 技能
- Agent 按 `protocols/必读加载协议.md` 强制加载对应 SKILL/模板再动笔
- 流式输出：服务端实时 tail 模型增量并推给前端逐字显示
- **自由 API**：设置里可配置任意 OpenAI 兼容接口
- **独立搜索服务**（默认 0 扣费）：内置端侧搜索（DuckDuckGo/必应），零配置；仅手动填入搜索 API Key 才切换官方搜索
- `DSH_HOME` 隔离在 `data/.dsh`，API Key 只通过子进程环境变量传递，不落任何云端

## 四、一键打包（给维护者）

双击 **`一键打包.bat`** → 产出 `dist/Academy-Bianlun-Coach-portable.zip`。

打包脚本会：
1. 校验/补齐 `runtime/dsh` + `runtime/node` + `runtime/electron`
2. 执行 `tools/refresh-knowledge.js` 刷新知识库 + `tools/sanitize-open-source.js` 开源合规检查
3. 用 Windows 自带 tar 打 zip 并校验

打包时**不会**包含 `data/`（API Key、会话记录、任务缓存），每次分发都是干净包。

## 五、许可与来源

- 当前发行版本：**v2.0.0**
- 本应用知识库采用 **CC BY-NC-SA 4.0** 许可，完整声明见 `LICENSE.md`
- 方法论体系改编自开源项目 [debate-coach《辩论筑基》](https://github.com/MoonTzai/debate-coach)（精靈Moon著）
- 教练质询协议改编自 [grill-me](https://github.com/mattpocock/skills/tree/main/skills/productivity/grill-me)（Matt Pocock，MIT License）
- 内容均为公开赛事/出版物/开源项目整理改编；如有版权问题欢迎提交 Issue

## 六、隐私说明

- API Key 仅存于本地 `data/config.json`，通过子进程环境变量传递，不上传任何云
- `data/` 目录不参与打包分发
- 本地会话记录仅保存在本机 `data/sessions`

## 七、联系我们

- **QQ 交流群：386631298**（使用问题、报 bug、提建议、版本更新同步）
- 也可在 App 内「⚙ 设置 → ℹ️ 关于应用」查看本页信息与版本号