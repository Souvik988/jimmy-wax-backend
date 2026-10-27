import { describe, expect, it } from 'vitest';
import { etagMatches } from '../../src/app.ts';

describe('If-None-Match matching', () => {
  const tag = '"abc123"';
  it('matches strong, weak, listed and wildcard validators', () => {
    expect(etagMatches(tag, tag)).toBe(true);
    expect(etagMatches(`W/${tag}`, tag)).toBe(true);
    expect(etagMatches(`"x", ${tag}`, tag)).toBe(true);
    expect(etagMatches(`"x",W/${tag} , "y"`, tag)).toBe(true);
    expect(etagMatches('*', tag)).toBe(true);
  });
  it('does not match a different or missing validator', () => {
    expect(etagMatches('"other"', tag)).toBe(false);
    expect(etagMatches('', tag)).toBe(false);
    expect(etagMatches(undefined, tag)).toBe(false);
  });
});
