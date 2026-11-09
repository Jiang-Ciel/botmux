import MarkdownIt from 'markdown-it';
import { inlineMathText } from './reply-math-text.js';

export interface ReplyMathSpan { start: number; end: number; latex: string; display: boolean }
const parser = new MarkdownIt({ html: false, linkify: false });

/** Scan source, not rendered Markdown: code and link destinations are literal.
 * Dollar pairs use whitespace/digit guards so ordinary prices remain prose. */
export function replyMathSpans(markdown: string): ReplyMathSpan[] {
  if (!markdown.includes('$') && !markdown.includes('\\[') && !markdown.includes('\\(')) return [];
  const protectedRanges: Array<[number, number]> = [];
  const lines = markdown.split('\n');
  const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1);
  // Classify model-escaped fence lines exactly as the card renderer does;
  // line offsets still refer to the untouched source.
  const classified = markdown.replace(/^[ ]{0,3}(?:\\`){3,}[^\n`]*$/gm, line => line.replace(/\\`/g, '`'));
  for (const token of parser.parse(classified, {})) {
    if (['fence', 'code_block', 'html_block'].includes(token.type) && token.map) {
      protectedRanges.push([offsets[token.map[0]], offsets[token.map[1]]]);
    }
  }
  // Inline code supports variable-length backtick runs, including newlines.
  for (const match of markdown.matchAll(/(`+)([\s\S]*?)\1(?!`)/g)) {
    protectedRanges.push([match.index!, match.index! + match[0].length]);
  }
  for (const match of markdown.matchAll(/!?\[[^\]\n]*\]\([^\n]*?\)|^ {0,3}\[[^\]\n]+\]:[^\n]*/gm)) {
    protectedRanges.push([match.index!, match.index! + match[0].length]);
  }
  const protectedAt = (i: number) => protectedRanges.some(([a, b]) => i >= a && i < b);
  const escaped = (i: number) => {
    let n = 0;
    while (i > 0 && markdown[--i] === '\\') n++;
    return n % 2 === 1;
  };
  const spans: ReplyMathSpan[] = [];
  for (let i = 0; i < markdown.length && spans.length < 128; i++) {
    if (protectedAt(i) || escaped(i)) continue;
    const opener = markdown.startsWith('\\[', i) ? '\\[' : markdown.startsWith('\\(', i) ? '\\('
      : markdown.startsWith('$$', i) ? '$$' : markdown[i] === '$' ? '$' : undefined;
    if (!opener) continue;
    const display = opener === '$$' || opener === '\\[';
    const closer = opener === '\\[' ? '\\]' : opener === '\\(' ? '\\)' : opener;
    const start = i + opener.length;
    if (opener === '$' && (/\s/.test(markdown[start] ?? '') || markdown[i - 1] === '$')) continue;
    let end = start;
    for (; end < Math.min(markdown.length, start + 2049); end++) {
      if (protectedAt(end) || (!display && markdown[end] === '\n')) break;
      if (!markdown.startsWith(closer, end) || escaped(end)) continue;
      if (opener === '$' && (/\s/.test(markdown[end - 1]) || /[\d$]/.test(markdown[end + 1] ?? ''))) continue;
      const latex = markdown.slice(start, end).trim();
      if (latex && latex.length <= 2048) {
        spans.push({ start: i, end: end + closer.length, latex, display });
        i = end + closer.length - 1;
      }
      break;
    }
  }
  return spans;
}

/** Display-only: no external renderer, filesystem lookup or original-text mutation.
 * The caller's ownership gate is checked again immediately before each upload.
 * A failed/unsupported expression remains legible as literal LaTeX. */
export async function resolveReplyMath(markdown: string, io: {
  owns: () => boolean;
  upload: (bytes: Buffer) => Promise<string>;
  render?: (latex: string, display: boolean) => Promise<Buffer>;
}): Promise<string> {
  const spans = replyMathSpans(markdown);
  if (!spans.length) return markdown;
  const cache = new Map<string, { key: string; width: number; height: number }>();
  let output = '';
  let cursor = 0;
  for (const span of spans) {
    if (!io.owns()) return markdown;
    output += markdown.slice(cursor, span.start);
    const text = !span.display ? inlineMathText(span.latex) : undefined;
    if (text !== undefined) {
      output += text;
      cursor = span.end;
      continue;
    }
    let replacement: string;
    try {
      const id = `${span.display}:${span.latex}`;
      let image = cache.get(id);
      if (!image) {
        const render = io.render ?? (await import('./reply-math-render.js')).renderReplyMath;
        const bytes = await render(span.latex, span.display);
        if (!io.owns()) return markdown;
        const key = await io.upload(bytes);
        if (!/^img_[A-Za-z0-9_-]+$/.test(key)) throw new Error('Invalid formula image key');
        // PNG pixels are rendered at 2x text resolution. Never enlarge a small
        // expression to the card width; shrink long equations proportionally.
        const png = bytes.length >= 24 && bytes.toString('hex', 0, 8) === '89504e470d0a1a0a';
        const pixelWidth = png ? bytes.readUInt32BE(16) : 120;
        const pixelHeight = png ? bytes.readUInt32BE(20) : 48;
        const scale = Math.min(0.5, 560 / Math.max(1, pixelWidth), 600 / Math.max(1, pixelHeight));
        image = { key, width: Math.max(1, Math.round(pixelWidth * scale)), height: Math.max(1, Math.round(pixelHeight * scale)) };
        cache.set(id, image);
      }
      // Renderer-only metadata becomes an exact-size native image component.
      replacement = `\n\n![botmux-math:${image.width}x${image.height}](${image.key})\n\n`;
    } catch {
      const fence = '`'.repeat(Math.max(3, ...[...span.latex.matchAll(/`+/g)].map(m => m[0].length + 1)));
      replacement = `\n\n${fence}latex\n${span.latex}\n${fence}\n\n`;
    }
    output += replacement;
    cursor = span.end;
  }
  return output + markdown.slice(cursor);
}
