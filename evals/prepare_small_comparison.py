#!/usr/bin/env python3
"""Prepare disposable synthetic comparison fixtures. Does not run agents."""

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / 'evals/fixtures/status-and-acceptance'
SKILL = ROOT / 'skills/road-map-journal'


def validate_tree(path: Path) -> None:
    if not path.is_dir() or path.is_symlink():
        raise ValueError(f'not a regular source directory: {path}')
    if any(entry.is_symlink() for entry in path.rglob('*')):
        raise ValueError(f'symlinks are not supported in source: {path}')


def prepare(destination: Path) -> None:
    validate_tree(FIXTURE)
    validate_tree(SKILL)
    if not (FIXTURE / 'PLAN.md').is_file() or not (SKILL / 'SKILL.md').is_file():
        raise ValueError('missing fixture or skill entry point')
    if destination.resolve().is_relative_to(ROOT):
        raise ValueError('destination must be outside the project checkout')
    destination.mkdir(parents=False, exist_ok=False)
    cases = []
    for host in ('hermes', 'codex', 'claude'):
        for condition in ('without', 'with'):
            case_id = f'{host}-{condition}'
            case = destination / case_id
            work = case / 'work'
            before = case / 'before'
            shutil.copytree(FIXTURE, work)
            (case / 'home').mkdir()
            if condition == 'with':
                if host == 'hermes':
                    target = case / 'hermes-home/skills/road-map-journal'
                elif host == 'codex':
                    target = work / '.agents/skills/road-map-journal'
                else:
                    target = work / '.claude/skills/road-map-journal'
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(SKILL, target)
            if host == 'hermes':
                (case / 'hermes-home').mkdir(exist_ok=True)
            shutil.copytree(work, before)
            cases.append({'id': case_id, 'host': host, 'condition': condition, 'status': 'not-run'})
    (destination / 'cases.json').write_text(json.dumps({'cases': cases}, indent=2) + '\n', encoding='utf-8')
    print(f'Prepared {len(cases)} synthetic cases; no agent or model was run.')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path, help='new directory outside the project checkout')
    args = parser.parse_args()
    try:
        prepare(args.destination)
    except (OSError, ValueError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
