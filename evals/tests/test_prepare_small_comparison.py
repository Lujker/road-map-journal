import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PREPARER = Path(__file__).resolve().parents[1] / 'prepare_small_comparison.py'


class PrepareComparisonTests(unittest.TestCase):
    def test_creates_six_isolated_cases_with_matching_snapshots(self):
        with tempfile.TemporaryDirectory() as temp:
            dest = Path(temp) / 'prepared'
            result = subprocess.run([sys.executable, str(PREPARER), str(dest)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            manifest = json.loads((dest / 'cases.json').read_text())
            self.assertEqual(len(manifest['cases']), 6)
            for case in manifest['cases']:
                root = dest / case['id']
                self.assertEqual((root / 'before/PLAN.md').read_bytes(), (root / 'work/PLAN.md').read_bytes())
                self.assertNotIn('auth.json', [p.name for p in root.rglob('*')])
                host, mode = case['host'], case['condition']
                if host == 'hermes':
                    target = root / 'hermes-home/skills/road-map-journal/SKILL.md'
                    self.assertEqual(target.exists(), mode == 'with')
                else:
                    rel = ('.agents/skills/road-map-journal/SKILL.md' if host == 'codex'
                           else '.claude/skills/road-map-journal/SKILL.md')
                    self.assertEqual((root / 'work' / rel).exists(), mode == 'with')
                    self.assertEqual((root / 'before' / rel).exists(), mode == 'with')
                    if mode == 'with':
                        self.assertEqual((root / 'work' / rel).read_bytes(), (root / 'before' / rel).read_bytes())

    def test_refuses_existing_destination_without_modifying_it(self):
        with tempfile.TemporaryDirectory() as temp:
            dest = Path(temp) / 'occupied'
            dest.mkdir()
            (dest / 'existing.txt').write_text('preserve')
            result = subprocess.run([sys.executable, str(PREPARER), str(dest)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(sorted(x.name for x in dest.iterdir()), ['existing.txt'])
            self.assertEqual((dest / 'existing.txt').read_text(), 'preserve')


if __name__ == '__main__':
    unittest.main()
