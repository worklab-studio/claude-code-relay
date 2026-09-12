import { describe, expect, it } from 'vitest';
import { isDiffLine, isIndentedCodeLine, isStackTraceLine, prose } from './prose.js';

describe('prose', () => {
  it('strips fenced code blocks and long inline code', () => {
    const msg = 'I added currency to Invoice.\n\n```ts\nexport interface Invoice { currency: Currency }\n```\n\nThe helper `fmt` stays; the long one `' + 'x'.repeat(100) + '` is gone.\n\nNext: update the dashboard.';
    const out = prose(msg);
    expect(out).toContain('I added currency to Invoice.');
    expect(out).not.toContain('export interface');
    expect(out).toContain('`fmt`');
    expect(out).not.toContain('x'.repeat(100));
    expect(out).toContain('Next: update the dashboard.');
  });

  it('drops diff and stack-trace lines but keeps markdown bullets', () => {
    const msg = [
      'Done:',
      '- kept bullet one',
      '+ kept plus bullet',
      '-  total: number',
      '+  amountDue: number',
      '@@ -1,3 +1,4 @@',
      'diff --git a/x b/x',
      '    at Object.<anonymous> (/x/y.js:1:2)',
      'TypeError: cannot read',
      'Traceback (most recent call last):',
      '  File "x.py", line 3, in <module>',
      'All good now.',
    ].join('\n');
    const out = prose(msg);
    expect(out).toBe('Done:\n- kept bullet one\n+ kept plus bullet\nAll good now.');
    expect(isDiffLine('-total')).toBe(true);
    expect(isDiffLine('- a bullet')).toBe(false);
    expect(isStackTraceLine('    at foo (bar.js:1:1)')).toBe(true);
    expect(isStackTraceLine('at the end of the day')).toBe(false);
  });

  it('strips fences nested in list items and 4-space indented code blocks (review)', () => {
    const msg = [
      '1. Update the config:',
      '   ```ts',
      '   const apiKey = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";',
      '   export const secret = process.env.X;',
      '   ```',
      '2. Done.',
      '',
      '    const password = "hunter2";',
      '    export default password;',
      '',
      'Then run it:',
      '\tnpm test',
      'Nested bullets survive:',
      '    - a nested bullet with four spaces',
      'End.',
    ].join('\n');
    const out = prose(msg);
    expect(out).not.toContain('apiKey');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('password');
    expect(out).not.toContain('npm test');
    expect(out).toContain('1. Update the config:');
    expect(out).toContain('2. Done.');
    expect(out).toContain('- a nested bullet with four spaces');
    expect(out).toContain('End.');
    expect(prose('- item\n  ~~~\n  code\n  ~~~\n- next')).toBe('- item\n\n- next');
    expect(isIndentedCodeLine('    code')).toBe(true);
    expect(isIndentedCodeLine('    - bullet')).toBe(false);
    expect(isIndentedCodeLine('   three')).toBe(false);
  });

  it('caps at 3,000 chars on a word boundary and handles empty input', () => {
    const out = prose('word '.repeat(2000));
    expect(out.length).toBeLessThanOrEqual(3000);
    expect(out.endsWith('…')).toBe(true);
    expect(prose('')).toBe('');
    expect(prose(undefined)).toBe('');
    expect(prose('a\n\n\n\nb')).toBe('a\n\nb');
    expect(prose('unterminated\n```\ncode here')).toBe('unterminated');
  });
});
