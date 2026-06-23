import { describe, it, expect } from 'vitest';
import { sanitizeContent } from '@bb/domain/comment/comment.service';

describe('CommentService.sanitizeContent', () => {
  it('strips a simple tag and keeps the text', () => {
    expect(sanitizeContent('<b>hello</b> world')).toBe('hello world');
  });

  it('strips script tags, leaving the inner text inert (no executable markup)', () => {
    const out = sanitizeContent('hi<script>alert(1)</script>there');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).toBe('hialert(1)there');
  });

  it('defeats reassembly bypass (<scr<script>ipt>)', () => {
    // A single-pass strip would leave "<script>" behind; the loop must not.
    const out = sanitizeContent('<scr<script>ipt>alert(1)<<x>/script>');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });

  it('neutralises an unmatched leftover angle bracket', () => {
    const out = sanitizeContent('5 < 10 is true');
    expect(out).not.toContain('<');
    expect(out).toContain('10 is true');
  });

  it('does not hang on adversarial ReDoS-style input', () => {
    const evil = `<script ${'a'.repeat(50_000)}`;
    const start = process.hrtime.bigint();
    const out = sanitizeContent(evil);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(out).not.toContain('<');
    expect(ms).toBeLessThan(1000);
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeContent('   <p>spaced</p>   ')).toBe('spaced');
  });
});
