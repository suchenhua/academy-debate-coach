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
  "开启后，教练会自动把对话里「值得长期记住」的内容归档进记忆，并把近期流水中有价值的段落晋升为长期记忆。关闭后只有你手动添加的记忆。": "When on, the coach archives memorable points from chats and promotes valuable daily-log excerpts to long-term memory. When off, only manual memories remain.",
  "开启后，每次任务会自动把相关记忆注入上下文。关闭后记忆仍然保留、可在记忆中心查看，但不再影响回答。": "When on, relevant memories are injected into every run's context. When off they are kept and viewable, but never affect answers.",
  "批准或否决": "Approve or veto",
  "开启时会先弹出确认，从下一条消息起生效。": "Turning it on asks for confirmation, effective from the next message.",
  "当前与排队": "Current & queued",
  "最近运行": "Recent runs",
  "排队上限 3 个；排队中的任务可撤回。运行记录保留最近 200 条。": "Up to 3 queued runs; queued tasks can be withdrawn. The log keeps the latest 200 runs.",
  "当前空闲": "Idle",
  "还没有运行记录。": "No runs yet.",
  "撤回": "Withdraw",
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
  "加载中…": "Loading…",
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
  "否决": "Veto",
  "撤销否决": "Undo veto",
  "批准入库": "Approve",
  "已加入否决清单": "Added to the veto list",
  "已批准入库": "Approved into memory",
  "已新增记忆": "Memory added",
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
  "已完成": "Done",
  "已取消": "Cancelled",
  "进行中": "In progress",
  "排队": "Queued",
  "已撤回": "Withdrawn",
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
  "资料溯源": "Source tracing",
  "还没有内容": "Nothing here yet",
  "没有可保存的文件": "No files to save",
  "没有可导出的内容": "Nothing to export",
  "移除附件": "Remove attachment",
  "工具箱": "Toolbox",
  "任务撤下": "withdrawn",
  "已恢复默认字号 15px": "Chat font reset to 15px",
};

function applyEnglishUI() {
  if (!document || !document.body) return;
  const hasHan = /[\u4e00-\u9fff]/;
  let walker;
  try {
    walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeValue && hasHan.test(node.nodeValue)) return NodeFilter.FILTER_ACCEPT;
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
    }
  }
  document.querySelectorAll('input[placeholder], textarea[placeholder], [title]').forEach((elm) => {
    for (const attr of ['placeholder', 'title']) {
      const v = elm.getAttribute(attr);
      if (v) {
        const en = EN_UI[v.trim()];
        if (en && en !== v) elm.setAttribute(attr, en);
      }
    }
  });
  const t = (document.title || '').trim();
  if (EN_UI[t]) document.title = EN_UI[t];
}

let enWatcherArmed = false;
function armEnglishWatcher() {
  if (enWatcherArmed || !document || !document.body) return;
  enWatcherArmed = true;
  let timer = 0;
  try {
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try { if (academyLocale() === 'en') applyEnglishUI(); } catch (_) {}
      }, 120);
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title'] });
  } catch (_) { enWatcherArmed = false; }
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
