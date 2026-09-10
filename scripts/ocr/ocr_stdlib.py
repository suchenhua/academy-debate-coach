# 📄 本知识库由 QFUD（驻青四校联合辩论培训计划）整理发布，
# 采用 知识共享署名-非商业性使用-相同方式共享 4.0 国际 (CC BY-NC-SA 4.0) 许可。
# 详情：https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh

#!/usr/bin/env python3
"""OCR.space API - stdlib only version"""
import sys, os, json, base64, urllib.request

API_URL = "https://api.ocr.space/parse/image"

def ocr_image(image_path, language="chs"):
    if not os.path.exists(image_path):
        print(f"Error: file not found: {image_path}")
        return None
    
    size_kb = os.path.getsize(image_path) / 1024
    print(f"Image: {image_path} ({size_kb:.1f} KB)")
    
    with open(image_path, 'rb') as f:
        file_bytes = f.read()
    
    boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW'
    body = (
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="language"\r\n\r\n'
        f'{language}\r\n'
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="isOverlayRequired"\r\n\r\n'
        f'false\r\n'
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="OCREngine"\r\n\r\n'
        f'2\r\n'
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="file"; filename="image.png"\r\n'
        f'Content-Type: image/png\r\n\r\n'
    ).encode('utf-8') + file_bytes + f'\r\n--{boundary}--\r\n'.encode('utf-8')
    
    req = urllib.request.Request(API_URL, data=body)
    req.add_header('apikey', 'helloworld')
    req.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')
    
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f"Error: {e}")
        return None
    
    # Save raw response to file (avoids GBK encoding issues)
    raw_path = image_path + '.raw.json'
    with open(raw_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"Raw response saved to: {raw_path}")
    if result.get("ParsedResults"):
        text = result["ParsedResults"][0].get("ParsedText", "")
        return text.strip()
    else:
        error = result.get("ErrorMessage", ["Unknown error"])
        print(f"OCR Error: {error}")
        return None

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python ocr_stdlib.py <image_path> [language]")
        sys.exit(1)
    
    image_path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 else "chs"
    
    print(f"OCR.space: {image_path} (lang={language})")
    result = ocr_image(image_path, language)
    
    if result:
        out_path = image_path + '.ocr.txt'
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(result)
        print(f"OCR done: {out_path} ({len(result)} chars)")
    else:
        print("OCR failed")
        sys.exit(1)
