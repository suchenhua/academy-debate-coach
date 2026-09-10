# 📄 本知识库由 QFUD（驻青四校联合辩论培训计划）整理发布，
# 采用 知识共享署名-非商业性使用-相同方式共享 4.0 国际 (CC BY-NC-SA 4.0) 许可。
# 详情：https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh

"""
秘塔搜索 API 封装
调用方式: python metaso_search.py "查询内容" [--scope webpage|academic] [--mode concise|deep|research] [--size 5]
输出: JSON 结果到 stdout
"""
import json, sys, os
import http.client

API_KEY = os.environ.get("METASO_API_KEY", "")  # 必须通过环境变量 METASO_API_KEY 提供
BASE = "metaso.cn"

def search(query, scope="webpage", size=5, include_summary=True):
    conn = http.client.HTTPSConnection(BASE, timeout=30)
    payload = json.dumps({
        "q": query,
        "scope": scope,
        "size": str(size),
        "includeSummary": include_summary,
        "includeRowContent": False,
        "format": "chat_completions"
    })
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Accept": "application/json",
        "Content-Type": "application/json"
    }
    conn.request("POST", "/api/v1/search", payload, headers)
    res = conn.getresponse()
    data = res.read().decode("utf-8")
    conn.close()
    return json.loads(data)

def format_output(result):
    """格式化为人类可读文本"""
    lines = [f"查询: {result.get('searchParameters',{}).get('q','')}"]
    lines.append(f"结果数: {result.get('total', 0)} | 积分: {result.get('credits', '?')}")
    lines.append("=" * 60)
    for i, page in enumerate(result.get("webpages", []), 1):
        title = page.get("title", "无标题")
        link = page.get("link", "")
        score = page.get("score", "")
        summary = page.get("summary", "") or page.get("snippet", "")
        date = page.get("date", "")
        lines.append(f"\n[{i}] {title}  ({score})")
        lines.append(f"    来源: {link}")
        if date:
            lines.append(f"    日期: {date}")
        if summary:
            lines.append(f"    摘要: {summary[:300]}")
    return "\n".join(lines)

if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description="秘塔AI搜索")
    p.add_argument("query", nargs="+", help="搜索查询")
    p.add_argument("--scope", default="webpage", choices=["webpage", "academic"], help="搜索范围")
    p.add_argument("--size", type=int, default=5, help="返回条数")
    p.add_argument("--json", action="store_true", help="输出原始JSON")
    p.add_argument("--format", choices=["json", "text"], default="text", help="输出格式")
    args = p.parse_args()
    
    query = " ".join(args.query)
    result = search(query, scope=args.scope, size=args.size)
    
    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(format_output(result))
