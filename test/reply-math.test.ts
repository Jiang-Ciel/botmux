import { describe, expect, it, vi } from 'vitest';
import { replyMathSpans, resolveReplyMath } from '../src/im/lark/reply-math.js';
import { renderReplyMath } from '../src/im/lark/reply-math-render.js';
import { buildCanonicalFinalReplyCard } from '../src/im/lark/md-card.js';

const fakeRender = async () => Buffer.from('png');

describe('LaTeX reply rendering', () => {
  it('recognizes inline, display and bracket delimiters in source order', () => {
    const spans = replyMathSpans(String.raw`行内 $x_i^2$，\(\alpha\)，$$\frac{1}{2}$$ 和 \[E=mc^2\]`);
    expect(spans.map(s => [s.latex, s.display])).toEqual([
      ['x_i^2', false], [String.raw`\alpha`, false], [String.raw`\frac{1}{2}`, true], ['E=mc^2', true],
    ]);
  });
  it('protects fences, inline code, indented code, links, escaped dollars and prices', () => {
    const text = [
      '```latex', '$$x$$', '```', String.raw`\`\`\`latex`, '$$escaped$$', String.raw`\`\`\``, '`$x$` and ``$y$``',
      '', '    $$indented$$', '', '[link](https://example.org/$x$)', '[ref]: https://example.org/$y$',
      String.raw`\$100 and \$200`, 'cost $5 or $10',
    ].join('\n');
    expect(replyMathSpans(text)).toEqual([]);
  });
  it('leaves incomplete streams untouched and caps expression count/length', () => {
    expect(replyMathSpans(String.raw`start \[x+y`)).toEqual([]);
    expect(replyMathSpans('$x\ny$')).toEqual([]);
    expect(replyMathSpans(`$$${'x'.repeat(2049)}$$`)).toEqual([]);
    expect(replyMathSpans(Array(20).fill('$x$').join(' '))).toHaveLength(8);
  });
  it('renders and uploads once per identical expression and builds native image elements', async () => {
    const upload = vi.fn(async () => 'img_v3_formula');
    const original = String.raw`结果 $x_i$ 与 $x_i$。`;
    const markdown = await resolveReplyMath(original, { owns: () => true, upload, render: fakeRender });
    expect(upload).toHaveBeenCalledTimes(1);
    const card = JSON.parse(buildCanonicalFinalReplyCard({ markdown }));
    expect(JSON.stringify(card)).toContain('img_v3_formula');
    expect(markdown).not.toContain('$x_i$');
    expect(original).toBe(String.raw`结果 $x_i$ 与 $x_i$。`);
  });
  it('preserves failed formulas as literal code without losing surrounding prose', async () => {
    const markdown = await resolveReplyMath('before $x_i$ after', {
      owns: () => true, upload: async () => { throw new Error('offline'); }, render: fakeRender,
    });
    expect(markdown).toContain('```latex\nx_i\n```');
    expect(markdown).toContain('before ');
    expect(markdown).toContain(' after');
  });
  it('does not upload after ownership is lost during rendering', async () => {
    let owned = true;
    const upload = vi.fn(async () => 'img_v3_formula');
    const original = '$x$';
    const output = await resolveReplyMath(original, { owns: () => owned, upload,
      render: async () => { owned = false; return Buffer.from('png'); } });
    expect(output).toBe(original);
    expect(upload).not.toHaveBeenCalled();
  });
  it('uses real local SVG/PNG rendering for fractions, sums, subscripts and aligned equations', async () => {
    for (const latex of [String.raw`\frac{a_i^2}{\sqrt{b}}`, String.raw`\sum_{i=1}^n i`,
      String.raw`\begin{aligned}x&=1\\y&=2\end{aligned}`]) {
      const bytes = await renderReplyMath(latex, true);
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(bytes.readUInt32BE(16)).toBeGreaterThan(24);
      expect(bytes.readUInt32BE(20)).toBeGreaterThan(24);
      const { createCanvas, loadImage } = await import('@napi-rs/canvas');
      const image = await loadImage(bytes);
      const ctx = createCanvas(image.width, image.height).getContext('2d');
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
      expect(pixels.some((value, index) => index % 4 !== 3 && value < 100)).toBe(true);
    }
  });
  it('rejects unknown commands and oversized raster dimensions', async () => {
    await expect(renderReplyMath(String.raw`\notACommand{x}`, false)).rejects.toThrow();
    await expect(renderReplyMath(String.raw`\rule{100000em}{1em}`, true)).rejects.toThrow();
  });
});
