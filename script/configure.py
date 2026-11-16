#!/usr/bin/env python3
"""Configure keys locally with hidden input; never prints either key."""
import getpass
import os
from pathlib import Path
import re
import secrets
import tempfile

root = Path(__file__).resolve().parent.parent
destination = root / '.env'
content = destination.read_text() if destination.exists() else (root / '.env.example').read_text()
google_key = getpass.getpass('Google API Key（输入不显示，回车保存）: ').strip()
# Permit common copy/paste forms without guessing Google's key format.
google_key = re.sub(r'^(?:GOOGLE_API_KEY\s*=|x-goog-api-key\s*:)\s*', '', google_key, flags=re.I).strip()
if len(google_key) >= 2 and google_key[0] == google_key[-1] and google_key[0] in "\"'":
    google_key = google_key[1:-1].strip()
if not google_key:
    raise SystemExit('未读取到密钥，未修改配置。请粘贴实际 Key 后再回车；隐藏输入时屏幕不显示字符。')
if any(ord(c) < 33 or ord(c) > 126 or c in "\"'#$\\<>" for c in google_key):
    raise SystemExit('输入含空格、控制字符或不适用于 .env 的字符，未修改配置。请只复制 Key 的值，不要复制整个 JSON 对象。')
if re.search(r'change.?me|replace.?me|your[_-]|placeholder', google_key, re.I):
    raise SystemExit('输入仍为示例占位符，未修改配置。请使用现有 Google Key。')

match = re.search(r'^BRIDGE_API_KEY=(.*)$', content, flags=re.MULTILINE)
bridge_key = match.group(1).strip() if match else ''
if len(bridge_key) < 24 or re.search(r'[<>\s]|replace.?me|change.?me|your[_-]|placeholder', bridge_key, re.I):
    bridge_key = secrets.token_urlsafe(32)
if bridge_key == google_key:
    bridge_key = secrets.token_urlsafe(32)

for name, value in [('GOOGLE_API_KEY', google_key), ('BRIDGE_API_KEY', bridge_key)]:
    if re.search(rf'^{name}=.*$', content, flags=re.MULTILINE):
        content = re.sub(rf'^{name}=.*$', lambda _: f'{name}={value}', content, flags=re.MULTILINE)
    else:
        content += f'\n{name}={value}\n'

# Atomic replacement with owner-only permissions, even when updating an existing file.
fd, temporary = tempfile.mkstemp(prefix='.env-', dir=root)
try:
    with os.fdopen(fd, 'w') as stream:
        stream.write(content)
    os.replace(temporary, destination)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print(f'已保存 {destination}（权限 600）。BRIDGE_API_KEY 已配置且未显示。')
print('服务运行时更新密钥后，请执行 docker compose up -d --force-recreate。')
