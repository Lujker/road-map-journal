import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CHECKER = Path(__file__).resolve().parents[1] / 'check_read_only.py'


class ReadOnlyCheckTests(unittest.TestCase):
    def test_unchanged_fixture_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            before, after = root / 'before', root / 'after'
            before.mkdir()
            after.mkdir()
            for folder in (before, after):
                (folder / 'PLAN.md').write_text('OPEN: one\n', encoding='utf-8')
            result = subprocess.run([sys.executable, str(CHECKER), str(before), str(after)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertIn('unchanged', result.stdout)

    def test_changed_added_and_removed_files_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            before, after = root / 'before', root / 'after'
            before.mkdir()
            after.mkdir()
            (before / 'PLAN.md').write_text('before', encoding='utf-8')
            (after / 'PLAN.md').write_text('after', encoding='utf-8')
            (before / 'gone.txt').write_text('removed', encoding='utf-8')
            (after / 'new.txt').write_text('added', encoding='utf-8')
            result = subprocess.run([sys.executable, str(CHECKER), str(before), str(after)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
            for expected in ('modified: PLAN.md', 'removed: gone.txt', 'added: new.txt'):
                self.assertIn(expected, result.stdout)

    def test_directory_creation_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            before, after = root / 'before', root / 'after'
            before.mkdir()
            after.mkdir()
            (after / 'empty').mkdir()
            result = subprocess.run([sys.executable, str(CHECKER), str(before), str(after)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
            self.assertIn('added: empty/', result.stdout)

    def test_invalid_input_fails_not_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run([sys.executable, str(CHECKER), tmp, str(Path(tmp) / 'missing')], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('unchanged', result.stdout)


if __name__ == '__main__':
    unittest.main()
