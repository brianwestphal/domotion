import re
with open('tests/output/html-test/24-deep-counter-scope.svg') as f:
    s = f.read()
for m in re.finditer(r'<g transform="translate\(([0-9.-]+)\s*,\s*([0-9.-]+)\)"[^>]*aria-label="([^"]*\[[0-9]+\][^"]*)"', s):
    x, y, label = m.group(1), m.group(2), m.group(3)
    print(f'  ({x}, {y}): {label!r}')
