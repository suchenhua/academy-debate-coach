# 📄 本知识库由 QFUD（驻青四校联合辩论培训计划）整理发布，
# 采用 知识共享署名-非商业性使用-相同方式共享 4.0 国际 (CC BY-NC-SA 4.0) 许可。
# 详情：https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh

# -*- coding: utf-8 -*-
"""
纯stdlib docx生成器：将Markdown转为Word文档
无pip依赖，使用zipfile + xml.etree.ElementTree
"""

import zipfile
import xml.etree.ElementTree as ET
import re
import os
import io
import sys

# ── OOXML namespaces ──
NSMAP = {
    'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'mc': 'http://schemas.openxmlformats.org/markup-compatibility/2006',
    'w14': 'http://schemas.microsoft.com/office/word/2010/wordml',
}

for prefix, uri in NSMAP.items():
    ET.register_namespace(prefix, uri)

W = lambda tag: '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}' + tag
R = lambda tag: '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}' + tag

def et_sub(parent, tag, attrib=None, text=None):
    el = ET.SubElement(parent, W(tag), attrib=attrib or {})
    if text is not None:
        el.text = text
    return el

def make_document_xml(paragraphs):
    """生成 word/document.xml"""
    doc_el = ET.Element(W('document'), {
        '{http://schemas.openxmlformats.org/markup-compatibility/2006}Ignorable': 'w14',
    })
    body = et_sub(doc_el, 'body')
    
    for para_info in paragraphs:
        p = et_sub(body, 'p')
        style = para_info.get('style')
        if style:
            pPr = et_sub(p, 'pPr')
            et_sub(pPr, 'pStyle', {'w:val': style})
        
        for run_info in para_info['runs']:
            r = et_sub(p, 'r')
            if run_info.get('bold'):
                rPr = et_sub(r, 'rPr')
                et_sub(rPr, 'b')
                et_sub(rPr, 'bCs')
            t = et_sub(r, 't', {'xml:space': 'preserve'})
            t.text = run_info['text']
    
    return ET.tostring(doc_el, encoding='unicode', xml_declaration=True)

def make_styles_xml():
    """生成 word/styles.xml - 带Heading样式"""
    styles = ET.Element(W('styles'))
    
    # Normal
    st = ET.SubElement(styles, W('style'), {'w:type': 'paragraph', 'w:styleId': 'Normal', 'w:default': '1'})
    st_name = ET.SubElement(st, W('name'), {'w:val': 'Normal'})
    st_pPr = ET.SubElement(st, W('pPr'))
    ET.SubElement(st_pPr, W('spacing'), {'w:after': '120', 'w:line': '276', 'w:lineRule': 'auto'})
    st_rPr = ET.SubElement(st, W('rPr'))
    ET.SubElement(st_rPr, W('rFonts'), {'w:eastAsia': '宋体'})
    ET.SubElement(st_rPr, W('sz'), {'w:val': '24'})
    
    headings = [
        ('Heading1', 'heading 1', 36, 360, 240),
        ('Heading2', 'heading 2', 32, 240, 180),
        ('Heading3', 'heading 3', 28, 200, 120),
    ]
    for sid, name, sz, before, after in headings:
        st = ET.SubElement(styles, W('style'), {'w:type': 'paragraph', 'w:styleId': sid})
        st_name = ET.SubElement(st, W('name'), {'w:val': name})
        ET.SubElement(st, W('basedOn'), {'w:val': 'Normal'})
        ET.SubElement(st, W('next'), {'w:val': 'Normal'})
        st_pPr = ET.SubElement(st, W('pPr'))
        ET.SubElement(st_pPr, W('spacing'), {'w:before': str(before), 'w:after': str(after)})
        ET.SubElement(st_pPr, W('outlineLvl'), {'w:val': str(int(sid[-1]) - 1)})
        st_rPr = ET.SubElement(st, W('rPr'))
        ET.SubElement(st_rPr, W('b'))
        ET.SubElement(st_rPr, W('bCs'))
        ET.SubElement(st_rPr, W('sz'), {'w:val': str(sz)})
    
    return ET.tostring(styles, encoding='unicode', xml_declaration=True)

TEMPLATES = {
    '[Content_Types].xml': '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>''',
    '_rels/.rels': '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>''',
    'word/_rels/document.xml.rels': '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>''',
}

def parse_markdown_simple(text):
    """
    简单markdown解析：H1(# ), H2(## ), H3(### ), 段落, 粗体(** **), 表格
    返回: list of dicts: {'style': None/'Heading1'/'Heading2'/'Heading3', 'runs': [{'text':..., 'bold':False}]}
    """
    lines = text.split('\n')
    result = []
    in_table = False
    table_lines = []
    
    for line in lines:
        # 表格检测
        if '|' in line and line.strip().startswith('|'):
            table_lines.append(line)
            continue
        elif '|---' in line:
            table_lines.append(line)
            continue
        elif table_lines:
            # flush table
            result.extend(parse_table(table_lines))
            table_lines = []
        
        stripped = line.strip()
        if not stripped:
            continue
        
        # H1
        if stripped.startswith('# ') and not stripped.startswith('## '):
            text = stripped[2:]
            result.append({'style': 'Heading1', 'runs': parse_inline(text)})
        # H2
        elif stripped.startswith('## ') and not stripped.startswith('### '):
            text = stripped[3:]
            result.append({'style': 'Heading2', 'runs': parse_inline(text)})
        # H3
        elif stripped.startswith('### '):
            text = stripped[4:]
            result.append({'style': 'Heading3', 'runs': parse_inline(text)})
        # 水平线
        elif stripped == '---':
            result.append({'style': None, 'runs': [{'text': '─' * 40, 'bold': False}]})
        # 块引用
        elif stripped.startswith('> '):
            text = stripped[2:]
            result.append({'style': None, 'runs': parse_inline(text)})
        # 普通段落
        else:
            result.append({'style': None, 'runs': parse_inline(stripped)})
    
    # flush remaining table
    if table_lines:
        result.extend(parse_table(table_lines))
    
    return result

def parse_inline(text):
    """解析行内格式：**粗体**"""
    runs = []
    pattern = re.compile(r'\*\*(.+?)\*\*')
    last = 0
    for m in pattern.finditer(text):
        if m.start() > last:
            runs.append({'text': text[last:m.start()], 'bold': False})
        runs.append({'text': m.group(1), 'bold': True})
        last = m.end()
    if last < len(text):
        runs.append({'text': text[last:], 'bold': False})
    if not runs:
        runs.append({'text': text, 'bold': False})
    return runs

def parse_table(lines):
    """简化表格解析→表格段落"""
    result = []
    # 过滤分隔行
    data_lines = [l for l in lines if not re.match(r'^\|[\s\-:|]+\|$', l.strip())]
    if len(data_lines) < 2:
        return [{'style': None, 'runs': [{'text': ' | '.join(l.strip('|').split('|')).strip() + '  ', 'bold': False}]} for l in lines if not l.strip().startswith('|---')]
    
    # 简单格式化：每行变成用tab分隔的文本
    for line in data_lines:
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        text = '  │  '.join(cells)
        result.append({'style': None, 'runs': [{'text': text, 'bold': False}]})
    
    return result

def build_docx(md_path, docx_path):
    """主流程"""
    with open(md_path, 'r', encoding='utf-8') as f:
        md_text = f.read()
    
    paragraphs = parse_markdown_simple(md_text)
    document_xml = make_document_xml(paragraphs)
    styles_xml = make_styles_xml()
    
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for path, content in TEMPLATES.items():
            zf.writestr(path, content.encode('utf-8'))
        zf.writestr('word/document.xml', document_xml.encode('utf-8'))
        zf.writestr('word/styles.xml', styles_xml.encode('utf-8'))
    
    with open(docx_path, 'wb') as f:
        f.write(buf.getvalue())
    
    print(f'OK: {docx_path} ({os.path.getsize(docx_path)} bytes)')


if __name__ == '__main__':
    md_path = sys.argv[1] if len(sys.argv) > 1 else r'./outputs/prep/辩题简写_持方_备赛包.md'
    docx_path = sys.argv[2] if len(sys.argv) > 2 else r'./outputs/prep/辩题简写_持方_备赛包.docx'
    build_docx(md_path, docx_path)