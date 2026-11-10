#!/usr/bin/env python3
"""Compare two isolated read-only evaluation fixtures, without modifying them."""

import argparse
import os
import sys
from pathlib import Path


def snapshot(root: Path) -> dict[str, bytes | None]:
    if not root.is_dir() or root.is_symlink():
        raise ValueError(f'not a regular directory: {root}')
    entries: dict[str, bytes | None] = {}
    for current, directories, files in os.walk(root, followlinks=False, onerror=lambda e: (_ for _ in ()).throw(e)):
        current_path = Path(current)
        for name in directories:
            path = current_path / name
            if path.is_symlink():
                raise ValueError(f'symlink not supported: {path}')
            entries[path.relative_to(root).as_posix() + '/'] = None
        for name in files:
            path = current_path / name
            if path.is_symlink() or not path.is_file():
                raise ValueError(f'not a regular file: {path}')
            entries[path.relative_to(root).as_posix()] = path.read_bytes()
    return entries


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('before', type=Path)
    parser.add_argument('after', type=Path)
    args = parser.parse_args()
    try:
        before, after = snapshot(args.before), snapshot(args.after)
    except (OSError, ValueError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 2
    changes = []
    for path in sorted(before.keys() - after.keys()):
        changes.append(f'removed: {path}')
    for path in sorted(after.keys() - before.keys()):
        changes.append(f'added: {path}')
    for path in sorted(before.keys() & after.keys()):
        if before[path] != after[path]:
            changes.append(f'modified: {path}')
    if changes:
        print('\n'.join(changes))
        return 1
    print('unchanged')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
