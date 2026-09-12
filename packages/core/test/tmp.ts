import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Fresh temp dir per test (prefers the session scratchpad when RELAY_TEST_TMP is set).
 * The path is canonicalised: on macOS `os.tmpdir()` is `/var/...`, a symlink to
 * `/private/var/...`, and git reports canonical paths, so tests that compare against
 * `git rev-parse` output need the resolved form.
 */
export function tmpHome(prefix = 'relay-core-'): { home: string; cleanup: () => void } {
  const base = process.env['RELAY_TEST_TMP'] ?? tmpdir();
  const home = realpathSync(mkdtempSync(join(base, prefix)));
  return {
    home,
    cleanup: () => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}
