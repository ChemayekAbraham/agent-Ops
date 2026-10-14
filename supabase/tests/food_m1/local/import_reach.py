"""For each test file given on stdin, follow its imports transitively (the
'@/' alias and relative paths) and report whether it can reach any of the
files the Food M1 release changes. Used to classify full-suite failures:
a failing test that cannot reach a changed file cannot be broken by it.
Usage: python import_reach.py <repo_root> <changed_files.txt> < failing_files.txt"""
import os, re, sys

root = sys.argv[1]
changed = {os.path.normpath(os.path.join(root, l.strip())) for l in open(sys.argv[2]) if l.strip()}
IMPORT = re.compile(r"""(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]""", re.M)
EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']

def resolve(spec, frm):
    if spec.startswith('@/'):
        base = os.path.join(root, 'src', spec[2:])
    elif spec.startswith('.'):
        base = os.path.join(os.path.dirname(frm), spec)
    else:
        return None                                   # a package, not repo code
    for e in EXTS:
        p = os.path.normpath(base + e)
        if os.path.isfile(p):
            return p
    return None

def reach(start):
    seen, stack, hits = set(), [start], set()
    while stack:
        f = stack.pop()
        if f in seen: continue
        seen.add(f)
        if f in changed: hits.add(os.path.relpath(f, root))
        try: text = open(f, encoding='utf-8', errors='ignore').read()
        except OSError: continue
        for m in IMPORT.finditer(text):
            spec = next(g for g in m.groups() if g)
            r = resolve(spec, f)
            if r and r not in seen: stack.append(r)
    return hits, len(seen)

for line in sys.stdin:
    t = line.strip()
    if not t: continue
    hits, n = reach(os.path.normpath(os.path.join(root, t)))
    print(f"{'REACHES' if hits else 'isolated':8} {t}  (files followed: {n})" + (f"  -> {sorted(hits)}" if hits else ''))
