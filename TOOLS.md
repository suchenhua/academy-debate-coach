> 📄 本知识库由 QFUD（驻青四校联合辩论培训计划）整理发布，
> 采用 知识共享署名-非商业性使用-相同方式共享 4.0 国际 (CC BY-NC-SA 4.0) 许可。
> 详情：https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh

---

# TOOLS.md — 本地工具备注 v1.1

## 辩论工具箱
- 根目录：本发行包根目录
- 版本：v1.1

## 可用工具
- ✅ Python 3（python3）
- ✅ python-docx（备赛包/评判报告生成）
- ✅ OCR 工具（`scripts/ocr/ocr_stdlib.py`）

## 备赛包生成
1. 使用 prep-coach v5.0（双模式：A.线性全量 / B.交互引导）
2. python-docx 生成备赛包
3. md2docx：`scripts/md2docx.py`

## 工具箱脚本
- `scripts/metaso_search.py` — 秘塔学术搜索
- `scripts/md2docx.py` — Markdown转docx
- `scripts/extract_docx.py` — docx文本提取
- `scripts/ocr/ocr_stdlib.py` — OCR 文本识别
- `scripts/switch-persona.ps1` — 人设切换

## 工具箱命名规范
- **目录**: 英文短横线（如 `methodologies`、`scoring-standards`）
- **文件**: 中文名（如 `逻敏.md`），中国人名用中文