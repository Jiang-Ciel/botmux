import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
    expect(replyMathSpans(Array(150).fill('$x$').join(' '))).toHaveLength(128);
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
      expect(pixels.some((value, index) => index % 4 === 0 && value < 100 && pixels[index + 3] > 0)).toBe(true);
    }
  });
  it('renders the complete reported MoE reply, including formulas after the eighth span', async () => {
    const original = readFileSync(new URL('./fixtures/moe-formulas.md', import.meta.url), 'utf8');
    const spans = replyMathSpans(original);
    expect(spans.length).toBeGreaterThan(8);
    const upload = vi.fn(async (_bytes: Buffer) => `img_v3_formula_${upload.mock.calls.length}`);
    const markdown = await resolveReplyMath(original, { owns: () => true, upload });
    expect(replyMathSpans(markdown)).toEqual([]);
    expect(markdown).not.toContain('```latex');
    const card = JSON.parse(buildCanonicalFinalReplyCard({ markdown }));
    const images = card.body.elements.filter((e: any) => e.tag === 'img');
    expect(images).toHaveLength(spans.length);
    for (const image of images) {
      expect(image.scale_type).toBe('crop_center');
      expect(image.size).toMatch(/^\d+px \d+px$/);
      expect(image.mode).toBeUndefined();
    }
    // Short variable names must not become full-width banners.
    expect(images.some((image: any) => Number(image.size.split('px')[0]) < 50)).toBe(true);
    expect(images.some((image: any) => Number(image.size.split('px')[0]) > 100)).toBe(true);
  });
  it('matches image display size to PNG aspect ratio without upscaling small formulas', async () => {
    const upload = vi.fn(async (_bytes: Buffer) => 'img_v3_size');
    const markdown = await resolveReplyMath(String.raw`$$\frac{a}{b}$$`, { owns: () => true, upload });
    const bytes = upload.mock.calls[0][0] as Buffer;
    const card = JSON.parse(buildCanonicalFinalReplyCard({ markdown }));
    const image = card.body.elements.find((e: any) => e.tag === 'img');
    const [width, height] = image.size.match(/\d+/g).map(Number);
    expect(width).toBe(Math.round(bytes.readUInt32BE(16) / 2));
    expect(height).toBe(Math.round(bytes.readUInt32BE(20) / 2));
    expect(image.preview).toBe(true);
    expect(image.transparent).toBe(true);
  });
  it('rejects unknown commands and oversized raster dimensions', async () => {
    await expect(renderReplyMath(String.raw`\notACommand{x}`, false)).rejects.toThrow();
    await expect(renderReplyMath(String.raw`\rule{100000em}{1em}`, true)).rejects.toThrow();
  });
});
