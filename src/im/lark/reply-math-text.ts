const symbols: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
  tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '·', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥',
  ne: '≠', neq: '≠', approx: '≈', equiv: '≡', in: '∈', notin: '∉', infty: '∞',
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒',
};
const scriptMap = (source: string, target: string): Map<string, string> =>
  new Map([...source].map((char, index) => [char, [...target][index]]));
const subscript = scriptMap('0123456789+-=()aehijklmnoprstuvx', '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ');
const superscript = scriptMap('0123456789+-=()in', '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁱⁿ');

/** Intentionally a small grammar, not a lossy LaTeX-to-text stripper.
 * Unsupported commands, grouping, scripts and tall constructions stay images.
 * Only inline callers use this: explicit display math always stays a block.
 * No whitespace/newlines are added outside the original math span. */
export function inlineMathText(latex: string): string | undefined {
  if (!latex || latex.length > 96 || /[\r\n]/.test(latex)) return undefined;
  let output = '';
  let atom = false;
  let scripts = '';
  for (let i = 0; i < latex.length;) {
    const char = latex[i];
    if (/\s/.test(char)) { output += char; i++; continue; }
    if (char === '_' || char === '^') {
      if (!atom || scripts.includes(char)) return undefined;
      scripts += char;
      i++;
      let body: string;
      if (latex[i] === '{') {
        const end = latex.indexOf('}', i + 1);
        if (end < 0) return undefined;
        body = latex.slice(i + 1, end);
        i = end + 1;
      } else {
        body = latex[i++] ?? '';
      }
      const map = char === '_' ? subscript : superscript;
      if (!body || [...body].some(c => !map.has(c))) return undefined;
      output += [...body].map(c => map.get(c)!).join('');
      continue;
    }
    scripts = '';
    if (char === '\\') {
      const command = /^\\([A-Za-z]+)/.exec(latex.slice(i));
      if (!command || !symbols[command[1]]) return undefined;
      const symbol = symbols[command[1]];
      output += symbol;
      atom = /^[\p{L}∞]$/u.test(symbol);
      i += command[0].length;
    } else if (/^[A-Za-z0-9]$/.test(char)) {
      output += char;
      atom = true;
      i++;
    } else if ('=+-/(),.<>|'.includes(char)) {
      output += char;
      // A script on a parenthesized group is not a script on its last glyph.
      atom = false;
      i++;
    } else {
      return undefined;
    }
  }
  // Prevent converted relations from becoming HTML/autolinks in card Markdown.
  return output.trim().replace(/</g, '&#60;').replace(/>/g, '&#62;');
}
