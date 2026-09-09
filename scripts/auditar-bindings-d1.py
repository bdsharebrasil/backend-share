from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
EXTENSIONS = {'.ts', '.tsx', '.js', '.mjs', '.sql'}
PREPARE_RE = re.compile(r'\.prepare\(\s*([\'"`])')
TOKEN_RE = re.compile(r'\?(\d*)')

findings = []
files = 0
for path in sorted(ROOT.rglob('*')):
    if not path.is_file() or path.suffix not in EXTENSIONS:
        continue
    if any(part in {'node_modules', 'dist', '.git'} for part in path.parts):
        continue
    files += 1
    for line_no, line in enumerate(path.read_text(encoding='utf-8', errors='ignore').splitlines(), 1):
        for match in PREPARE_RE.finditer(line):
            quote = match.group(1)
            remainder = line[match.end():]
            end = remainder.find(quote)
            if end < 0:
                continue
            sql = remainder[:end]
            markers = TOKEN_RE.findall(sql)
            has_bare = any(marker == '' for marker in markers)
            has_numbered = any(marker != '' for marker in markers)
            if has_bare and has_numbered:
                findings.append((path.relative_to(ROOT), line_no, line.strip()))

print(f'Arquivos analisados: {files}')
print(f'Misturas encontradas: {len(findings)}')
for path, line_no, line in findings:
    print(f'{path}:{line_no}: {line}')

raise SystemExit(1 if findings else 0)
