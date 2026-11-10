#!/usr/bin/env python3
"""Check that relative Markdown links in tracked .md files resolve to existing paths. Standard library only."""
import os
import re
import subprocess
import sys

root = subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip()
files = subprocess.check_output(['git', 'ls-files', '*.md'], text=True, cwd=root).split()
bad = 0
for f in files:
    text = open(os.path.join(root, f), encoding='utf8').read()
    text = re.sub(r'```.*?```', '', text, flags=re.S)
    for target in re.findall(r'\]\(([^)\s]+)\)', text):
        if re.match(r'^[a-z]+:', target) or target.startswith('#'):
            continue
        path = os.path.normpath(os.path.join(root, os.path.dirname(f), target.split('#')[0]))
        if not os.path.exists(path):
            print(f'BROKEN {f}: {target}')
            bad += 1
print(f'{len(files)} files checked, {bad} broken links')
sys.exit(1 if bad else 0)
