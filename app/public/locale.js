/* Academy 辩论教练 · 界面语言：简体 / 繁体 / English
 * 简繁：内置常用字映射（覆盖界面文案），不含词级歧义处理。
 * English：整节点精确匹配词条表 EN_UI 覆盖替换（仅界面外壳；长帮助文本与 AI 内容保持中文）。
 * 转换范围：仅界面静态文本（.msg 消息内容、输入框值除外）。
 */
'use strict';

const S2T = {"设":"設","备":"備","赛":"賽","盘":"盤","询":"詢","质":"質","应":"應","实":"實","验":"驗","训":"訓","环":"環","节":"節","评":"評","审":"審","写":"寫","说":"說","话":"話","术":"術","对":"對","双":"雙","单":"單","观":"觀","读":"讀","发":"發","库":"庫","历":"歷","忆":"憶","帮":"幫","网":"網","输":"輸","语":"語","请":"請","传":"傳","载":"載","开":"開","关":"關","闭":"閉","启":"啟","动":"動","费":"費","账":"賬","号":"號","码":"碼","链":"鏈","级":"級","选":"選","择":"擇","项":"項","里":"裡","内":"內","钟":"鐘","确":"確","认":"認","无":"無","经":"經","个":"個","么":"麼","为":"為","于":"於","从":"從","让":"讓","数":"數","据":"據","构":"構","键":"鍵","纲":"綱","逻":"邏","辑":"輯","驳":"駁","击":"擊","调":"調","来":"來","当":"當","题":"題","场":"場","队":"隊","众":"眾","业":"業","译":"譯","结":"結","论":"論","辩":"辯","证":"證","战":"戰","争":"爭","标":"標","准":"準","优":"優","点":"點","预":"預","规":"規","则":"則","讲":"講","衔":"銜","复":"複","贴":"貼","删":"刪","档":"檔","录":"錄","记":"記","购":"購","买":"買","联":"聯","资":"資","进":"進","称":"稱","签":"簽","条":"條","总":"總","计":"計","务":"務","云":"雲","连":"連","线":"線","断":"斷","绿":"綠","蓝":"藍","红":"紅","黄":"黃","圆":"圓","块":"塊","边":"邊","顶":"頂","后":"後","间":"間","组":"組","员":"員","参":"參","与":"與","览":"覽","图":"圖","频":"頻","视":"視","诉":"訴","侧":"側","栏":"欄","滚":"滾","针":"針","夹":"夾","径":"徑","编":"編","寻":"尋","类":"類","别":"別","筛":"篩","过":"過","滤":"濾","转":"轉","页":"頁","错":"錯","误":"誤","强":"強","显":"顯","隐":"隱","换":"換","异":"異","检":"檢","测":"測","试":"試","稳":"穩","详":"詳","细":"細","简":"簡","杂":"雜","础":"礎","专":"專","属":"屬","变":"變","脚":"腳","注":"註","释":"釋","执":"執","须":"須","华":"華","门":"門","问":"問","闻":"聞","阁":"閣","国":"國","团":"團","园":"園","导":"導","艺":"藝","价":"價","亿":"億","仪":"儀","伤":"傷","伟":"偉","伦":"倫","体":"體","余":"餘","作":"作","你":"你","们":"們","卫":"衛","卖":"賣","义":"義","乌":"烏","乡":"鄉","习":"習","书":"書","乱":"亂","事":"事","二":"二","亏":"虧","互":"互","亚":"亞","产":"產","亲":"親","会":"會","伞":"傘","伪":"偽","佛":"佛","佣":"傭","侠":"俠","侣":"侶","侦":"偵","侨":"僑","侩":"儈","侪":"儕","侬":"儂","俊":"俊","俣":"俁","俦":"儔","俨":"儼","俩":"倆","俪":"儷","俭":"儉","债":"債","值":"值","倾":"傾","假":"假","偌":"偌","偃":"偃","倘":"倘","偎":"偎","偏":"偏","偕":"偕","做":"做","停":"停","健":"健","偶":"偶","偷":"偷","偬":"傯","偻":"僂","偾":"僨","偿":"償","傀":"傀","傥":"儻","傧":"儐","储":"儲","傩":"儺","催":"催","傲":"傲","傻":"傻","像":"像","僭":"僭","僚":"僚","僮":"僮","僵":"僵","僻":"僻","侏":"侏","侑":"侑","侔":"侔","侘":"侘","侚":"侚","侥":"僥","侭":"儘","侯":"侯"};

const T2S = {};
for (const k in S2T) T2S[S2T[k]] = k;

function convHan(text, map) {
  if (!text) return text;
  let out = '';
  for (const ch of text) out += (map[ch] || ch);
  return out;
}

const ACADEMY_LOCALE_KEY = 'academy.locale.v1';
function academyLocale() {
  try {
    const v = localStorage.getItem(ACADEMY_LOCALE_KEY);
    return v === 'zh-TW' ? 'zh-TW' : v === 'en' ? 'en' : 'zh-CN';
  } catch (_) { return 'zh-CN'; }
}

/* —— English 词条表：键 = 节点去空白后的完整中文，值 = 英文 —— */
const EN_UI = {
  "逻敏 · Academy 辩论教练": "Logisme · Academy Debate Coach",
  "华语辩论全链路 AI 教练 · 备赛 / 复盘 / 评判": "The full-pipeline Chinese debate AI coach · Prep / Review / Judging",
  "检测引擎中…": "Detecting engine…",
  "引擎检测中…": "Detecting engine…",
  "引擎已启动，正在加载知识库…": "Engine started — loading the knowledge base…",
  "设置": "Settings",
  "新建对话": "New chat",
  "打开工具箱": "Open toolbox",
  "收起 / 展开侧边栏": "Collapse / expand sidebar",
  "收起侧边栏": "Collapse sidebar",
  "展开侧边栏": "Expand sidebar",
  "自由问答": "Free chat",
  "备赛": "Prep",
  "复盘": "Review",
  "评判": "Judge",
  "直接提问：辩题分析、方法论、辩手风格、赛制规则，都可以问。": "Ask anything: motion analysis, methodology, debating styles, formats.",
  "立论 · 质询 · 攻防 · 一辩稿。请写明：辩题、持方、赛制、需要交付的内容。": "Constructives · cross-ex · clashes · first speech. State: motion, side, format, deliverables.",
  "粘贴比赛文字稿（txt/md/srt 或直接粘贴），逐帧纠偏、给替代表述。": "Paste a match transcript (txt/md/srt) for frame-by-frame fixes and better phrasing.",
  "三票制评分 + 九段式述票。需提供带明确发言人的完整文字转写——腾讯会议转写几乎无可替代。": "Three-ballot scoring + nine-part verdict speech. Needs a full transcript with speaker labels.",
  "对话历史 · 自由问答": "History · Free chat",
  "对话历史 · 备赛": "History · Prep",
  "对话历史 · 复盘": "History · Review",
  "对话历史 · 评判": "History · Judge",
  "早上好，今天想辩点什么？": "Good morning — what shall we debate today?",
  "中午好，今天想辩点什么？": "Good afternoon — what shall we debate today?",
  "下午好，今天想辩点什么？": "Good afternoon — what shall we debate today?",
  "晚上好，今天想辩点什么？": "Good evening — what shall we debate today?",
  "夜深了，今天想辩点什么？": "It's late — what shall we debate today?",
  "自由问答模式": "Free Chat Mode",
  "备赛模式": "Prep Mode",
  "复盘模式": "Review Mode",
  "评判模式": "Judge Mode",
  "欢迎使用逻敏 · 辩论教练": "Welcome to Logisme · Debate Coach",
  "欢迎使用逻敏辩论教练！": "Welcome to Logisme Debate Coach!",
  "开始使用 →": "Get started →",
  "开始配置 →": "Set up →",
  "对话历史": "Chat history",
  "新对话": "New chat",
  "未命名": "Untitled",
  "未命名对话": "Untitled chat",
  "当前模式暂无历史（保存在本机浏览器）": "No chats in this mode yet (stored in this browser).",
  "正在载入全部对话…": "Loading all chats…",
  "没有匹配的内容": "Nothing matches.",
  "清空": "Clear",
  "清空本地历史": "Clear local history",
  "搜索全部对话内容…": "Search all chats…",
  "清除搜索": "Clear search",
  "全部": "All",
  "输入辩题、比赛文字稿或任何辩论问题…（Ctrl+Enter 发送）": "Ask about a motion, paste a transcript… (Ctrl+Enter to send)",
  "输入辩题、比赛文字稿或任何辩论问题…（Enter 发送）": "Ask about a motion, paste a transcript… (Enter to send)",
  "评判 · 粘贴带明确发言人的完整文字转写——腾讯会议转写自带逐句发言人标注，几乎无可替代（Ctrl+Enter 发送）": "Judge · paste a full transcript with speaker labels (Ctrl+Enter to send)",
  "评判 · 粘贴带明确发言人的完整文字转写——腾讯会议转写自带逐句发言人标注，几乎无可替代（Enter 发送）": "Judge · paste a full transcript with speaker labels (Enter to send)",
  "回到最新内容": "Back to latest",
  "上传资料：Word / PDF / txt / md / srt（可多选）": "Attach files: Word / PDF / txt / md / srt (multiple allowed)",
  "模型": "Model",
  "切换当前使用的 AI 配置（对话中随时切换）": "Switch the AI profile in use (anytime during chat)",
  "本对话累计 Token 用量（无数据时显示占位）": "Cumulative token usage of this chat",
  "个人资料库：上传自己的备赛包/文字稿，备赛复盘时自动检索引用": "Personal library: your prep packs & transcripts, auto-cited in prep/review",
  "产物空间：Agent 输出的文件（md/csv/…），可转 Word/Excel/PDF 并导出到任意文件夹": "Deliverables: files produced by the Agent — convert to Word/Excel/PDF, export anywhere",
  "查看/管理长程记忆": "View / manage long-term memory",
  "导出当前会话，可选 Word / Markdown / PDF 格式": "Export this session as Word / Markdown / PDF",
  "导出当前会话": "Export session",
  "导出 Word": "Export Word",
  "点此配置": "Set it up here",
  "通用": "General",
  "联网搜索": "Web search",
  "高级": "Advanced",
  "高级选项（使用其他模型服务商）": "Advanced options (other providers)",
  "技能 / 插件": "Skills / plugins",
  "使用统计": "Usage stats",
  "任务记录": "Task log",
  "关于应用": "About",
  "数据备份": "Data backup",
  "个人数据备份": "Personal data backup",
  "外观": "Appearance",
  "浅色": "Light",
  "深色": "Dark",
  "跟随系统": "Follow system",
  "界面语言": "Interface language",
  "对话字体大小": "Chat font size",
  "默认": "Default",
  "恢复默认 15px": "Reset to 15px",
  "恢复默认": "Reset to default",
  "新手引导": "Onboarding guide",
  "重新查看引导": "Re-open the guide",
  "工作步骤展示": "Work steps display",
  "对话流里 Agent 工作步骤的展示粒度：": "How granularly the Agent's work steps appear in chat:",
  "简洁": "Concise",
  "标准": "Standard",
  "详细": "Detailed",
  "完全展开": "Fully expanded",
  "只显示正在走的这一步；": "shows only the current step;",
  "列出每步名称；": "lists every step name;",
  "带上参数/结果摘要；": "adds argument/result summaries;",
  "参数与结果分行全展示。": "shows every argument and result on its own line.",
  "繁忙时的发送行为": "Sending while busy",
  "Agent 还在处理时再发消息：": "If you send while the Agent is still working:",
  "排队发送": "Queue",
  "插话发送": "Interrupt",
  "按先后顺序等待；": "waits in order;",
  "先暂停当前任务、清空等待队列，让新消息优先开始。被打断/移开的任务不丢，任务记录里会标注原因。": "pauses the current run and clears the queue so the new message starts first; interrupted runs stay in the task log with a reason.",
  "发送消息": "Send message",
  "微信式发送热键：": "WeChat-style send hotkey:",
  "Ctrl + Enter 发送": "Ctrl + Enter sends",
  "Enter 发送": "Enter sends",
  "记忆管理": "Memory",
  "自动学习": "Auto-learn",
  "自动引用": "Auto-cite",
  "候选审阅": "Candidate review",
  "开启后，每次任务会自动把相关记忆注入上下文。关闭后记忆仍然保留、可在记忆中心查看，但不再影响回答。": "When on, relevant memories are injected into every run's context. When off they are kept and viewable, but never affect answers.",
  "批准或否决": "Approve or veto",
  "开启时会先弹出确认，从下一条消息起生效。": "Turning it on asks for confirmation, effective from the next message.",
  "当前与排队": "Current & queued",
  "最近运行": "Recent runs",
  "排队上限 3 个；排队中的任务可撤回。运行记录保留最近 200 条。": "Up to 3 queued runs; queued tasks can be withdrawn. The log keeps the latest 200 runs.",
  "还没有运行记录。": "No runs yet.",
  "取消": "Cancel",
  "确定": "OK",
  "保存": "Save",
  "删除": "Delete",
  "编辑": "Edit",
  "复制": "Copy",
  "刷新": "Refresh",
  "停止": "Stop",
  "创建": "Create",
  "搜索": "Search",
  "导出": "Export",
  "打开文件": "Open file",
  "打开目录": "Open folder",
  "预览": "Preview",
  "转 Word": "To Word",
  "转 Excel": "To Excel",
  "存 PDF": "Save as PDF",
  "文件": "Files",
  "文档": "Docs",
  "表格": "Spreadsheets",
  "任务": "Task",
  "收藏": "Favorites",
  "已保存配置": "Saved profiles",
  "新建": "New",
  "配置名称": "Profile name",
  "配置名称（可选）": "Profile name (optional)",
  "服务商": "Provider",
  "API Key（没有就留空）": "API Key (leave empty to keep)",
  "粘贴你的 sk-... Key": "Paste your sk-... key",
  "留空表示不修改已保存的 Key": "Leave empty to keep the saved key",
  "获取模型": "Fetch models",
  "模型名": "Model name",
  "保存配置": "Save profile",
  "测试连接": "Test connection",
  "测试并保存": "Test & save",
  "清除 Key": "Clear key",
  "API 地址（OpenAI 兼容）": "API base URL (OpenAI-compatible)",
  "（加载中…）": "(loading…)",
  "自定义接口…": "Custom endpoint…",
  "自定义配置": "Custom profile",
  "我的配置": "My profiles",
  "DeepSeek 官方（推荐）": "DeepSeek official (recommended)",
  "DeepSeek 官方": "DeepSeek official",
  "DeepSeek 开放平台": "DeepSeek open platform",
  "硅基流动": "SiliconFlow",
  "智谱 GLM": "Zhipu GLM",
  "基础检索（免费）": "Basic search (free)",
  "深度检索（推荐）": "Deep search (recommended)",
  "联网搜索质量": "Web search quality",
  "自定义搜索服务": "Custom search service",
  "试检索": "Try a search",
  "检索中…": "Searching…",
  "输入关键词试检索，看会召回哪些资料（回车检索）": "Type a keyword to preview recall (Enter to search)",
  "记忆中心": "Memory center",
  "长期记忆": "Long-term memory",
  "每日流水": "Daily log",
  "清空全部记忆": "Clear all memories",
  "添加": "Add",
  "搜索全部记忆（长期 + 流水）": "Search all memory (long-term + daily)",
  "要长期记住的内容，如判准、偏好、基准…": "Things to remember long-term: criteria, preferences, baselines…",
  "标题（留空则自动用时间戳）": "Title (blank = auto timestamp)",
  "每条记忆都可以编辑或删除": "Every memory can be edited or deleted.",
  "批准入库": "Approve",
  "已加入否决清单": "Added to the veto list",
  "已批准入库": "Approved into memory",
  "全部记忆已清空": "All memories cleared",
  "资料库": "Library",
  "产物空间": "Deliverables",
  "存入资料库": "Save to library",
  "粘贴文本": "Paste text",
  "选择文件": "Choose files",
  "选择文件夹": "Choose folder",
  "筛选文件名…": "Filter files…",
  "筛选辩题…": "Filter motions…",
  "＋ 新建辩题": "+ New motion",
  "编辑辩题": "Edit motion",
  "辩题名称": "Motion name",
  "没有匹配的辩题。": "No motions match.",
  "已创建辩题档案": "Motion profile created",
  "已删除辩题归档": "Motion profile deleted",
  "先填上辩题": "Fill in the motion first",
  "持方": "Side",
  "辩题": "Motion",
  "资料，🔍 可联网搜资料": "Materials · search the web with 🔍",
  "总对话数": "Chats",
  "总消息数": "Messages",
  "活跃天数": "Active days",
  "聊天热力图": "Chat heatmap",
  "对话轮次": "Turns",
  "累计 Token": "Total tokens",
  "按模型": "By model",
  "缓存命中率": "Cache hit rate",
  "缓存节省 Token": "Tokens saved by cache",
  "输入 Token": "Input tokens",
  "输出 Token": "Output tokens",
  "思考过程": "Reasoning",
  "推理": "Reasoning",
  "运行内核：DeepSeek Harness（DSH）极简 Agent 内核 + 内置 Node.js + Electron": "Runtime: DeepSeek Harness (DSH) minimal agent kernel + bundled Node.js + Electron",
  "开源许可": "Open-source license",
  "隐私说明": "Privacy",
  "联系我们": "Contact us",
  "微信公众号": "WeChat official account",
  "QQ 交流群": "QQ group",
  "本地运行": "Runs locally",
  "数据位置": "Data location",
  "一键导出全部数据": "Export all data",
  "从备份文件导入": "Import from a backup file",
  "整理发布 · 作品名 logisme-debate-coach": "Published by QFUD · work: logisme-debate-coach",
  "就绪": "Ready",
  "未配置 API Key": "API key not set",
  "已取消": "Cancelled",
  "排队": "Queued",
  "保存中…": "Saving…",
  "保存失败": "Save failed",
  "正在停止…": "Stopping…",
  "正在压缩上下文…": "Compressing context…",
  "正在导入…": "Importing…",
  "正在打包数据…": "Packaging data…",
  "正在验证…": "Verifying…",
  "测试中…": "Testing…",
  "正在获取模型列表…": "Fetching model list…",
  "已复制到剪贴板": "Copied to clipboard",
  "已保存": "Saved",
  "已删除": "Deleted",
  "已收藏": "Starred",
  "取消收藏": "Unstarred",
  "验证通过，已保存！": "Verified and saved!",
  "找不到这个对话": "Chat not found",
  "这个对话已不在本机": "This chat is no longer on this device",
  "打开对话": "Open chat",
  "查看原文": "View original",
  "重命名": "Rename",
  "改名": "Rename",
  "删除这套配置？": "Delete this profile?",
  "压缩上下文": "Compress context",
  "重答": "Retry",
  "把当前对话压缩成摘要，释放上下文空间": "Compress this chat into a summary to free context",
  "按同一句提问重新生成这条回复": "Regenerate this reply from the same question",
  "当前会话仍在生成，无法切换模式": "Still generating — can't switch modes now",
  "有任务正在运行，请稍后再压缩": "A run is in progress — compress later",
  "当前对话太短，不需要压缩": "This chat is too short to compress",
  "研究台": "Research desk",
  "简易流水单": "Simple flow sheet",
  "辩案工作台": "Case workbench",
  "还没有内容": "Nothing here yet",
  "没有可保存的文件": "No files to save",
  "没有可导出的内容": "Nothing to export",
  "移除附件": "Remove attachment",
  "工具箱": "Toolbox",
  "任务撤下": "withdrawn",
  "已恢复默认字号 15px": "Chat font reset to 15px",
};


/* Phase 5.4：补齐词典 + 动态文案规则。EN_EXTRA 并入 EN_UI；EN_RULES 按序做正则替换，
   输出不含汉字，因此对 MutationObserver 的重复调用保持幂等。 */
const EN_EXTRA = {
  // —— 设置 / 通用 ——
  "开（默认）": "On (default)",
  "关（默认）": "Off (default)",
  "开": "On",
  "关": "Off",
  "已开启（下一条消息起生效）": "Enabled (from the next message)",
  "已关闭": "Disabled",
  "设置失败：": "Setting failed: ",
  "已保存修改": "Saved",
  "保存失败：": "Save failed: ",
  "失败：": "Failed: ",
  "未知错误": "Unknown error",
  "请求失败": "Request failed",
  "不支持旧版 .doc，请用 Word 另存为 .docx 后再上传": "Legacy .doc is not supported — save it as .docx in Word first",
  "支持格式：Word(.docx) / PDF / txt / md / srt": "Supported: Word (.docx) / PDF / txt / md / srt",
  "文件过大（超过 20MB）": "File too large (>20MB)",
  "一次最多上传 10 个文件": "Up to 10 files per upload",
  "先给这份资料起个名字": "Give this document a name first",
  "正文是空的": "The body is empty",
  "标题和内容不能都为空": "Title and content cannot both be empty",
  "请输入": "Enter",
  "（可留空）": "(optional)",
  "这一项不能为空": "This field is required",
  "（未命名）": "(unnamed)",
  "（无）": "(none)",
  "（无内容）": "(no content)",
  "留空自动命名": "Leave blank to name automatically",
  "显示/隐藏": "Show / hide",
  "回到底部": "Back to bottom",
  "发送": "Send",
  "AI 模型": "AI model",
  "文档处理（扩展）": "Document processing (extended)",
  "第三方来源与致谢": "Third-party sources & credits",
  "复制群号": "Copy group ID",
  "复制原文": "Copy text",
  "复制微信号": "Copy WeChat ID",
  "— 请选择 —": "— Select —",
  "推荐": "Recommended",
  "＋ 自定义接口": "+ Custom endpoint",
  "GET（关键词放地址里）": "GET (query in URL)",
  "POST（关键词放请求体）": "POST (query in body)",
  "请求方式": "Request method",
  "请求地址模板": "URL template",
  "结果数组路径": "Results array path",
  "标题字段": "Title field",
  "链接字段": "Link field",
  "摘要字段（可空）": "Snippet field (optional)",
  "测试一下": "Test it",
  "🔌 测试一下": "🔌 Test it",
  "🔌 测试并保存": "🔌 Test & save",
  "正在连接 ": "Connecting to ",
  "启用时必须填「请求地址模板」": "A URL template is required when enabled",
  "先填「请求地址模板」再测试": "Fill in the URL template before testing",
  "正在用「辩论」试搜一次…": "Trying a test search for “debate”…",
  "测试失败": "Test failed",
  "已启用": "Enabled",
  "启用": "Enable",
  "停用": "Disable",
  "已停用": "Disabled",
  "（已启用，下次搜索生效）": "(enabled, applies to the next search)",
  "（未启用）": "(not enabled)",
  "（尚未加载）": "(not loaded yet)",
  "从服务商获取的模型列表": "Model list fetched from the provider",
  "填好 Key 后点「获取模型」自动拉取；也可手动输入": "Fetch models after saving a Key, or type one manually",
  // —— 状态条 / 队列 ——
  "引擎缺失": "Engine missing",
  "Agent 运行中": "Agent running",
  "当前空闲": "Idle",
  "对话": "Chat",
  "搜索建议": "Search tips",
  "证据检证": "Evidence check",
  "资料溯源": "Source tracing",
  "撤回": "Withdraw",
  "已撤回": "Withdrawn",
  "撤回失败：": "Withdraw failed: ",
  "取消失败：": "Cancel failed: ",
  "已插话：正在暂停当前任务，你的消息马上开始…": "Interrupted: pausing the current run so your message starts…",
  "工作步骤展示：": "Work steps display: ",
  // —— 步骤条 ——
  "进行中": "In progress",
  "已完成": "Done",
  "进行中 · 共 ": "In progress · ",
  " 步": " steps",
  "参数 ": "Args ",
  // —— 产物 / 辩题 / 收藏 / 资料库 ——
  "存产物": "Save deliverable",
  "导出到文件夹": "Export to folder",
  "所在文件夹": "In folder",
  "预览：": "Preview: ",
  "加载中…": "Loading…",
  "已生成：": "Generated: ",
  "转换失败：": "Conversion failed: ",
  "已导出：": "Exported: ",
  "导出失败：": "Export failed: ",
  "导出失败": "Export failed",
  "浏览器模式下无法打开文件夹": "Opening folders is unavailable in browser mode",
  "浏览器模式不可用": "Unavailable in browser mode",
  "未知": "Unknown",
  "这个分类下没有匹配的文件。": "No matching files in this category.",
  "删除产物「": "Delete the deliverable “",
  "」？": "”?",
  "删除失败：": "Delete failed: ",
  "还没有快照——开始一次对话后自动生成。": "No snapshots yet — they are created automatically once you start a chat.",
  "还原到这里": "Restore to this point",
  "已还原：": "Restored: ",
  "还原失败：": "Restore failed: ",
  "读取失败": "Read failed",
  "读取失败：": "Read failed: ",
  "读取中…": "Reading…",
  "跳到这个辩题下最近的一次对话": "Jump to the latest chat for this motion",
  "（未命名辩题）": "(unnamed motion)",
  "（对话已删除）": "(chat deleted)",
  "辩题名称不能为空": "Motion name is required",
  "已更新": "Updated",
  "更新失败：": "Update failed: ",
  "创建失败：": "Create failed: ",
  "这个辩题下没有可打开的对话": "No openable chat under this motion",
  "只删除这条辩题索引，对话和产物文件都会保留": "Only this motion index is deleted; chats and files are kept",
  "还没有自己的技能。点上方「导入技能文件」或「新建」添加。": "No skills yet. Add one with “Import skill” or “+ New” above.",
  "⚠ 缺 frontmatter": "⚠ Missing frontmatter",
  "编辑：": "Edit: ",
  "新建技能（粘贴内容）": "New skill (paste content)",
  "格式不对": "Wrong format",
  "技能导入失败": "Skill import failed",
  "已把 ": "Moved ",
  " 个旧对话迁移到文件存储": " old chats into file storage",
  "已暂停召回": "Recall paused",
  "恢复召回": "Resume recall",
  "暂停召回": "Pause recall",
  "已恢复召回": "Recall resumed",
  "图片OCR": "Image OCR",
  "其他": "Other",
  "↻ 刷新": "↻ Refresh",
  "↺ 快照还原": "↺ Snapshots",
  "松开上传文件": "Drop files to upload",
  "正在读取拖入的内容…": "Reading dropped content…",
  "没有识别到可入库的文件": "No importable files detected",
  "已存入资料库": "Saved to library",
  "检索失败：": "Search failed: ",
  "命中 ": "Hits: ",
  "相关度 ": "Relevance ",
  "系统默认语言": "System default",
  "已恢复默认（点「保存同义词」生效）": "Defaults restored (press “Save synonyms” to apply)",
  "恢复为内置默认同义词表？你的自定义分组会被覆盖。": "Restore the built-in synonym table? Your custom groups will be overwritten.",
  "已添加附件：": "Attachment added: ",
  "已开启：备赛 / 复盘会自动检索资料库": "On: prep / review will search your library",
  "已关闭：本次起不再自动检索资料库": "Off: no automatic library search from now on",
  // —— 记忆中心 ——
  "否决清单（": "Veto list (",
  "撤销否决": "Undo veto",
  "已撤销": "Undone",
  "不再引用": "Never cite",
  "条": "entries",
  "天": "days",
  "条 / ": " entries / ",
  "流水": "Daily",
  "长期": "Long-term",
  "内容（支持 Markdown）": "Content (Markdown supported)",
  "今天想记点什么？（支持 Markdown）": "What to remember? (Markdown supported)",
  "先输入要搜索的关键词": "Type a keyword to search first",
  "搜索中…": "Searching…",
  "搜索失败": "Search failed",
  "这条记忆": "this memory",
  "已新增记忆": "Memory added",
  "待审阅": "Pending review",
  "接受入库": "Accept",
  "否决": "Veto",
  "已加入待审阅": "Added to pending review",
  "清空失败": "Clear failed",
  "清空失败：": "Clear failed:",
  // —— 设置提示碎片（被 <b> 拆开的节点，Phase 5.4）——
  "开启后，教练提出的记忆候选": "When on, memory candidates proposed by the coach",
  "先进「待审阅」": "go to Pending review first",
  "，你在记忆中心逐条": ", review each one in the Memory center and",
  "，不再自动入库。": ", instead of auto-storing.",
  "开启后，教练会自动把对话里「值得长期记住」的内容归档进记忆，并把近期流水中有价值的段落晋升为长期记忆。关闭后只有你手动添加的记忆。": "When on, the coach archives memorable points from chats and promotes valuable daily-log excerpts to long-term memory. When off, only manual memories remain.",
  "否决清单": "Veto list",
  "被否决的内容会进否决清单，以后同样的内容不再入库也不再注入。": "Vetoed content joins the veto list; the same content is never stored or injected again.",
  "：记忆候选先入「待审阅」，你在记忆中心逐条接受或否决。": ": memory candidates wait in Pending review until you accept or veto them in the Memory center.",
  "「通过入库」或「否决」": "approve or veto",
  "「不再引用」按钮": "Never-cite button",
  "把这条记忆加入否决清单？": "Add this memory to the veto list?",
  "条目本身保留在文件里，但以后不再注入到任务上下文；同内容也不会再被自动归档。": "The entry stays in the file but is no longer injected into run context, and the same content will not be auto-archived.",
  "开启后每次任务自动注入相关记忆。关闭后记忆仍保留可查，但不再影响回答。": "When on, relevant memories are injected into every run. When off they remain viewable but never affect answers.",
  "自动学习与自动引用可分开控制；开启审阅模式后，新的记忆候选先进「待审阅」，由你逐条决定。": "Auto-learn and auto-cite are independent. With review on, new candidates wait in Pending review for your call.",
  "已从否决清单移除": "Removed from the veto list",
  "通过入库": "Accept",
  "已入库": "Stored",
  "已否决（进入否决清单，同文不再入库/注入）": "Vetoed (added to the veto list; never stored or injected again)",
  "待审阅候选 · ": "Pending candidates · ",
  " 条（审阅模式开启中）": " (review mode is on)",
  "任何辩论问题": "Ask any debate question",
  "立论 · 质询 · 攻防": "Construct · Cross-ex · Clash",
  "文字稿逐帧纠偏": "Frame-by-frame transcript fixes",
  "三票制 · 述票": "3 ballots · Verdict delivery",
  "产物": "Deliverables",
  "记忆": "Memory",
  "本模式是": "This mode is an",
  "独立": "independent",
  "的对话空间，切换模式不会把这段对话带过去。": " chat space — switching modes won’t carry this conversation over.",
  "Enter 发送 · Ctrl + Enter 换行": "Enter sends · Ctrl + Enter for newline",
  "本对话 Token": "This chat · Tokens",
  "暂无用量（发消息后显示）": "— no usage yet (shows after you send)",
  "MD 阅读器": "MD reader",
  "边查资料边和教练聊：搜索 + 7 触发条件建议 + 独立研究对话（独立小窗）": "Search while you talk to the coach: web search + 7-trigger suggestions + a separate research chat (own window)",
  "核查论据是否被编造 / 曲解 / 断章取义，真联网查原始出处（独立小窗）": "Check whether evidence is fabricated, twisted, or quoted out of context — live lookup of the original source (own window)",
  "追一段资料的最早出处与原文，梳理流传链、查讹传（独立小窗）": "Trace a claim back to its earliest source and original text; map its spread, catch misquotes (own window)",
  "打开本地 Markdown / 文本文件阅读": "Open local Markdown / text files to read",
  "九步法构建完整辩案": "Build a full case with the nine-step method",
  "比赛攻防流水记录": "Play-by-play record of match clashes",
  "填自己的 OpenAI 兼容地址": "Use your own OpenAI-compatible URL",
  "快照还原": "Snapshot restore"

};

const EN_RULES = [
[/DSH 内核: /, "DSH kernel: "],
[/内置 Node: /, "Bundled Node: "],
[/搜索: 服务侧✅/, "Search: server ✅"],
[/搜索: 免费端侧✅/, "Search: free local ✅"],
[/记忆 ([\d,.]+) B/, "memory $1 B"],
[/^[ ·]*打开失败：/, "Open failed: "],
  [/已排队第\s*(\d+)\s*位[，,]?[^\n]*/, "Queued #$1 — waiting for the run ahead to finish…"],
  [/⏳\s*排队第\s*(\d+)\s*位\s*·\s*/, "⏳ Queued #$1 · "],
  [/引擎就绪\s*·\s*/, "Engine ready · "],
  [/Agent 工作中…\s*已运行\s*[\d:秒分。…]+/, "Agent working… elapsed "],
  [/Agent 运行中\s*·\s*排队\s*(\d+)/, "Agent running · $1 queued"],
  [/进行中\s*·\s*共\s*(\d+)\s*步/, "In progress · $1 steps"],
  [/已提取\s*(\d+)\s*字符/, "Extracted $1 chars"],
  [/参数\s/, "Args "],
  [/共\s*(\d+)\s*个文件/, "$1 files"],
  [/([\d,.]+)\s*字/g, "$1 chars"],
  [/· 对话$/, "· Chat"],
  [/否决清单（\s*(\d+)\s*条[^）]*）/, "Veto list ($1)"],
  [/(\d+)\s*条\s*\/\s*(\d+)\s*天/, "$1 entries / $2 days"],
  [/(\d+)\s*个文件/, "$1 files"]
];

function applyEnglishUI() {
  if (!document || !document.body) return;
  for (const k in EN_EXTRA) if (!(k in EN_UI)) EN_UI[k] = EN_EXTRA[k];
  const hasHan = /[\u4e00-\u9fff]/;
  let walker;
  try {
    walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeValue && (hasHan.test(node.nodeValue) || /[\u3000-\u303f\uff01-\uff5e]/.test(node.nodeValue))) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_REJECT;
      }
    });
  } catch (_) { return; }
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const p = n.parentNode;
    if (!p || !p.closest) continue;
    if (p.closest('textarea, input, pre#memoryContent')) continue;
    // 消息区默认保护用户/AI 内容；欢迎页与其中的界面控件（按钮、下拉、链接）除外
    if (p.closest('#messages') && !(p.closest('.welcome') || p.matches('button, select, option, a'))) continue;
    const raw = n.nodeValue;
    const en = EN_UI[raw.trim()];
    if (en) {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
      n.nodeValue = m[1] + en + m[3];
      continue;
    }
    if (hasHan.test(raw)) {
      let out = raw;
      for (const [re, val] of EN_RULES) {
        if (re.global ? re.test(out) : re.test(out)) out = out.replace(re, val);
      }
      if (out !== raw) n.nodeValue = out;
    }
  }
  document.querySelectorAll('input[placeholder], textarea[placeholder], [title]').forEach((elm) => {
    for (const attr of ['placeholder', 'title']) {
      const v = elm.getAttribute(attr);
      if (v) {
        const en = EN_UI[v.trim()];
        if (en && en !== v) { elm.setAttribute(attr, en); continue; }
        if (hasHan.test(v)) {
          let out = v;
          for (const [re, val] of EN_RULES) {
            if (re.test(out)) out = out.replace(re, val);
          }
          if (out !== v) elm.setAttribute(attr, out);
        }
      }
    }
  });
  const t = (document.title || '').trim();
  if (EN_UI[t]) document.title = EN_UI[t];
  // 本轮自己改出的节点变更不再触发观察者回调（英文值不命中中文键，本就会收敛，
  // 但吞掉记录可以省掉一整轮空转的 TreeWalker）
  try { if (enObserver) enObserver.takeRecords(); } catch (_) {}
}

let enObserver = null;
function armEnglishWatcher() {
  if (enObserver || !document || !document.body) return;
  try {
    // 不加防抖：MutationObserver 回调是微任务，赶在浏览器绘制之前完成替换，
    // 切模式/切语言时不会再「先画一帧中文」。英文值不命中中文键，天然收敛。
    enObserver = new MutationObserver(() => {
      try { if (academyLocale() === 'en') applyEnglishUI(); } catch (_) {}
    });
    enObserver.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title'] });
  } catch (_) { enObserver = null; }
}

/* 应用语言到界面静态文本 */
function applyLocaleToStatic() {
  if (!document || !document.body) return;
  const loc = academyLocale();
  if (loc === 'en') { applyEnglishUI(); armEnglishWatcher(); return; }
  const map = loc === 'zh-TW' ? S2T : T2S;
  const skipSel = '#messages, textarea, input, pre#memoryContent';
  let walker;
  try {
    walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeValue && /[\u4e00-\u9fff]/.test(node.nodeValue)) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_REJECT;
      }
    });
  } catch (_) { return; }
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    if (n.parentNode && n.parentNode.closest && n.parentNode.closest(skipSel)) continue;
    const c = convHan(n.nodeValue, map);
    if (c !== n.nodeValue) n.nodeValue = c;
  }
  document.querySelectorAll('input[placeholder], textarea[placeholder]').forEach((el) => {
    const v = el.getAttribute('placeholder');
    if (v && /[\u4e00-\u9fff]/.test(v)) el.setAttribute('placeholder', convHan(v, map));
  });
}
