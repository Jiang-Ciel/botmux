import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { LiteElement } from 'mathjax-full/js/adaptors/lite/Element.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
// Explicit allowlist: no require/autoload, HTML, links or user-defined macros.
const document = mathjax.document('', {
  InputJax: new TeX({ packages: ['base', 'ams'], maxBuffer: 4096, maxMacros: 100 }),
  OutputJax: new SVG({ fontCache: 'none' }),
});

/** MathJax emits self-contained SVG paths; existing optional canvas rasterizes
 * them locally. Hard size bounds prevent a formula allocating a huge bitmap. */
export async function renderReplyMath(latex: string, display: boolean): Promise<Buffer> {
  if (latex.length > 2048) throw new Error('Formula too long');
  if (/\\(?:def|gdef|edef|xdef|let|newcommand|renewcommand|providecommand|require|href|url|html\w*|includegraphics)\b/.test(latex)) {
    throw new Error('Unsupported formula command');
  }
  const node = document.convert(latex, { display });
  const source = adaptor.outerHTML(node);
  if (source.includes('data-mjx-error') || source.length > 1_000_000) throw new Error('Unsupported formula');
  const svgNode = adaptor.firstChild(node);
  if (!(svgNode instanceof LiteElement) || adaptor.kind(svgNode) !== 'svg') throw new Error('Missing SVG');
  const rawViewBox: unknown = adaptor.getAttribute(svgNode, 'viewBox');
  const viewBox = typeof rawViewBox === 'string' ? rawViewBox.split(/\s+/).map(Number) : undefined;
  if (!viewBox || viewBox.length !== 4 || viewBox.some(n => !Number.isFinite(n))
    || viewBox[2] <= 0 || viewBox[3] <= 0) throw new Error('Invalid formula dimensions');
  const scale = 32 / 1000;
  const width = Math.ceil(viewBox[2] * scale);
  const height = Math.ceil(viewBox[3] * scale);
  if (width > 2400 || height > 1200) throw new Error('Formula exceeds image budget');
  adaptor.setAttribute(svgNode, 'width', String(width));
  adaptor.setAttribute(svgNode, 'height', String(height));
  const svg = adaptor.outerHTML(svgNode).replace(/currentColor/g, '#202124');
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(Buffer.from(svg));
  const canvas = createCanvas(width + 24, height + 24);
  const context = canvas.getContext('2d');
  context.drawImage(image, 12, 12, width, height);
  return canvas.toBuffer('image/png');
}
