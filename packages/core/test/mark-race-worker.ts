// Spawned N times in parallel by journal.test.ts: exactly one process must win the 'wx' mark.
import { createMark } from '../src/journal.js';

const [dir, kind, key] = process.argv.slice(2);
const spin = Date.now() + 30; // align the start so the processes really race
while (Date.now() < spin) {
  /* busy wait */
}
const results: string[] = [];
for (let i = 0; i < 20; i++) results.push(createMark(dir as string, kind as 'jit', `${key}-${i}`));
process.stdout.write(JSON.stringify(results));
