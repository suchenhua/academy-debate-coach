'use strict';
/* Academy 记忆守卫（Phase 2：记忆治理）
   思路借自 DSH-SEP（github.com/Lance-QwQ/DSH-SEP，MIT）的「记忆治理」设计：
   秘密与注入指令在写入前拦截；记错的内容用 FORGET 协议软撤回（进归档、仍可召回）。
   正则按本项目中文辩论场景重新实现，未引入 SEP 代码。 */

// 疑似密钥：命中即拒绝写入记忆。宁可误拦一条，不可漏存一个 key。
const SECRET_PATTERNS = [
  { tag: '疑似密钥', re: /\bsk-[A-Za-z0-9_\-]{16,}\b/ },
  { tag: '疑似密钥', re: /\b(api[_\s-]?key|apikey|access[_\s-]?token|auth[_\s-]?token|secret[_\s-]?key|client[_\s-]?secret)\b\s*[:=：是]\s*\S{8,}/i },
  { tag: '疑似口令', re: /(密码|口令|密钥|私钥|访问码)\s*[:=：是]\s*\S{6,}/ },
  { tag: '疑似密钥', re: /\bBearer\s+[A-Za-z0-9._\-]{16,}\b/i },
];

// 提示注入：出现在“要长期记住”的内容里基本只可能是外部资料夹带的指令。
const INJECTION_PATTERNS = [
  { tag: '疑似注入指令', re: /(忽略|无视|不要遵守|不要理会)(掉|了)?(之前|以上|上面|所有|全部|此前)[^。\n]{0,8}(指令|提示|规则|设定|约定|系统提示)/ },
  { tag: '疑似注入指令', re: /ignore\s+(all\s+)?(previous|above|prior|earlier)\s+(instructions?|prompts?|rules?)/i },
  { tag: '疑似越狱指令', re: /(从现在起|从现在开始)[^。\n]{0,12}(你没有任何|不再受|解除所有|没有任何限制)/ },
];

function findTag(text, patterns) {
  const s = String(text || '');
  for (const p of patterns) { try { if (p.re.test(s)) return p.tag; } catch (_) {} }
  return null;
}
function looksSecret(text) { return findTag(text, SECRET_PATTERNS); }
function looksInjection(text) { return findTag(text, INJECTION_PATTERNS); }
/** 记忆写入前统一体检：返回拦截原因（命中哪类），放行返回 null。 */
function blockReason(text) { return looksSecret(text) || looksInjection(text); }

// 用户在消息里谈论“撤回/更正记忆”的意图（宽松匹配：命中只是多提示一句，误报无害）
const MEMORY_TALK_RE = /(忘记|撤回|别再记|不要记|别记|删掉|删除|清除|清空)[^\n]{0,14}(记忆|记的|之前记|以前记|那条|这条)|那(条|句|段)记忆[^\n]{0,10}(删|撤|不要|不对)|(之前|以前|上次|那条|这条|你记的|记下的)[^\n]{0,14}(忘记|忘掉|撤掉|撤回|删掉|删了|别再记|不要记|别记)|(改成|改为|更正|纠正|记错了?)[^\n]{0,12}(之前|那条|那句|记的)/;
function memoryTalkIntent(text) {
  try { return MEMORY_TALK_RE.test(String(text || '')); } catch (_) { return false; }
}

module.exports = { looksSecret, looksInjection, blockReason, memoryTalkIntent };
