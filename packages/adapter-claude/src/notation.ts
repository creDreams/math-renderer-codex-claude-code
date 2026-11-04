/** Bounded notation parser for complete mathematical code blocks. This only
 * translates written notation; source matching always uses the untouched raw text. */
const greek = new Map('α β γ δ ε ζ η θ ι κ λ μ ν ξ π ρ σ τ υ φ χ ψ ω Γ Δ Θ Λ Ξ Π Σ Φ Ψ Ω'
    .split(' ').map((char, i) => [char, 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega'.split(' ')[i]!]));
const functions = new Set(['mean', 'std', 'min', 'max', 'clip', 'exp', 'log', 'ln', 'sin', 'cos', 'tan', 'cot',
    'sinh', 'cosh', 'tanh', 'sqrt', 'abs', 'norm', 'KL', 'Pr', 'argmin', 'argmax', 'softmax', 'sigmoid',
    'ReLU', 'relu', 'GELU', 'gelu', 'logsumexp', 'logdet', 'det', 'tr', 'trace', 'diag', 'rank',
    'Var', 'Cov', 'var', 'cov', 'corr', 'sign', 'sgn', 'sup', 'inf', 'lim']);
const accents: Record<string, string> = { '\u0302': 'hat', '\u0303': 'tilde', '\u0304': 'bar', '\u0307': 'dot', '\u0308': 'ddot', '\u20d7': 'vec' };
const symbols: Record<string, string> = { 'ϵ': '\\epsilon', 'ϕ': '\\varphi', 'ϑ': '\\vartheta', 'ϱ': '\\varrho',
    '∞': '\\infty', 'ℓ': '\\ell', 'ℝ': '\\mathbb{R}', 'ℕ': '\\mathbb{N}', 'ℤ': '\\mathbb{Z}',
    'ℚ': '\\mathbb{Q}', 'ℂ': '\\mathbb{C}', 'ℙ': '\\mathbb{P}', '𝔼': '\\mathbb{E}', '∅': '\\emptyset',
    '∇': '\\nabla', '∂': '\\partial', '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∬': '\\iint', '∮': '\\oint' };
const relations: Record<string, string> = { '=': '=', '<': '<', '>': '>', '<=': '\\leq', '>=': '\\geq',
    '≤': '\\leq', '≥': '\\geq', '≠': '\\neq', '≈': '\\approx', '≃': '\\simeq', '≅': '\\cong', '≡': '\\equiv',
    '~': '\\sim', '∼': '\\sim', '∝': '\\propto', '∈': '\\in', '∉': '\\notin', '⊂': '\\subset', '⊆': '\\subseteq',
    '⊃': '\\supset', '⊇': '\\supseteq', '→': '\\to', '->': '\\to', '↦': '\\mapsto', '⇒': '\\Rightarrow', '⇔': '\\Leftrightarrow',
    '≻': '\\succ', '≺': '\\prec', '≽': '\\succeq', '≼': '\\preceq', '⊥': '\\perp', '∥': '\\parallel',
    '≪': '\\ll', '≫': '\\gg', '≲': '\\lesssim', '≳': '\\gtrsim', '≍': '\\asymp', '↔': '\\leftrightarrow' };
const binary: Record<string, string> = { '+': '+', '-': '-', '−': '-', '*': '*', '/': '/', '·': '\\cdot', '×': '\\times',
    '÷': '\\div', '±': '\\pm', '∓': '\\mp', '⊙': '\\odot', '⊗': '\\otimes', '∪': '\\cup', '∩': '\\cap',
    '∧': '\\land', '∨': '\\lor' };
const relationCommands = new Set(['mid', 'in', 'notin', 'le', 'leq', 'ge', 'geq', 'ne', 'neq', 'approx', 'simeq',
    'cong', 'equiv', 'sim', 'propto', 'subset', 'subseteq', 'supset', 'supseteq', 'to', 'mapsto', 'Rightarrow', 'Leftrightarrow',
    'succ', 'prec', 'succeq', 'preceq', 'perp', 'parallel', 'll', 'gg', 'lesssim', 'gtrsim', 'asymp', 'leftrightarrow']);
const binaryCommands = new Set(['cdot', 'times', 'div', 'pm', 'mp', 'odot', 'otimes', 'cup', 'cap', 'land', 'lor']);
const prefix = new Set(['nabla', 'partial', 'sum', 'prod', 'int', 'iint', 'oint']);
const unaryCommands = new Set(['widehat', 'hat', 'tilde', 'widetilde', 'bar', 'overline', 'underline', 'vec', 'dot', 'ddot',
    'mathbb', 'mathcal', 'mathbf', 'mathit', 'boldsymbol']);
const textCommands = new Set(['mathrm', 'operatorname', 'text']);
const atomCommands = new Set([...greek.values(), 'epsilon', 'varepsilon', 'varphi', 'vartheta', 'varrho',
    'infty', 'ell', 'emptyset', 'ldots', 'cdots', 'dots', 'vdots', 'ddots']);
const supers = '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ', superValues = '0123456789+-=()ni';
const subs = '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ', subValues = '0123456789+-=()aehijklmnoprstuvx';
const forbidden = /==|!=|:=|=>|&&|\*\*|\/\/|["`#@]|https?:|[A-Za-z]:\\|\b(?:const|let|var|return|import|export|def|class|function|print|console|echo|git|npm|python|True|False|None)\b/;
export const hasClaudeProgramSyntax = (raw: string): boolean => forbidden.test(raw);

class Notation {
    at = 0;
    depth = 0;
    steps = 0;
    features = 0;
    structures = 0;
    sets = 0;
    relations = 0;
    atoms = 0;
    constructor(readonly raw: string, readonly permissive = false, readonly continuation = false) { }
    fail(): never { throw Error('unsupported notation'); }
    space() { while (/\s/u.test(this.raw[this.at] ?? '\0')) this.at++; }
    peek() { this.space(); return String.fromCodePoint(this.raw.codePointAt(this.at) ?? 0); }
    step() { if (++this.steps > 2048) this.fail(); }
    command(): string {
        const word = /^\\([A-Za-z]+)/.exec(this.raw.slice(this.at));
        if (!word) return '';
        this.at += word[0].length;
        return word[1]!;
    }
    group(script: boolean, literal = false, sized = false, escaped = false): string {
        if (++this.depth > 20) this.fail();
        const open = this.peek();
        if (!'([{'.includes(open)) this.fail();
        this.at++;
        const close = ({ '(': ')', '[': ']', '{': '}' } as Record<string, string>)[open]!;
        const set = open === '{' && (!script || literal);
        if (set) this.sets++;
        const body = this.sequence(close, script);
        if (set) this.sets--;
        if (sized && this.command() !== 'right') this.fail();
        if (escaped) { if (this.peek() !== '\\') this.fail(); this.at++; }
        if (this.peek() !== close) this.fail();
        this.at++; this.depth--;
        if (sized) return '\\left' + (open === '{' ? '\\{' : open) + body + '\\right' + (close === '}' ? '\\}' : close);
        return open === '{' ? script && !literal ? '{' + body + '}' : '\\{' + body + '\\}' : open + body + close;
    }
    textArgument(): string {
        if (this.peek() !== '{') this.fail();
        const end = this.raw.indexOf('}', ++this.at);
        if (end < 0 || end - this.at > 96) this.fail();
        const text = this.raw.slice(this.at, end);
        if (!text.trim() || /[\\{}$%#&\r\n]/.test(text)) this.fail();
        this.at = end + 1;
        return '{' + text + '}';
    }
    argument(script: boolean, label = false): string {
        const ch = this.peek();
        if (script && label && this.permissive) {
            const name = /^[A-Za-z]{2,}(?:-[A-Za-z][A-Za-z0-9]*)+/.exec(this.raw.slice(this.at))?.[0];
            if (name && name.length <= 64) { this.at += name.length; return '{\\text{' + name + '}}'; }
        }
        if (ch === '{') return this.group(true);
        // Parenthesized scripts retain the parentheses Claude actually wrote.
        if (script && ch === '(') return '{' + this.group(true) + '}';
        if (script && /[<>≤≥]/u.test(ch)) {
            const operator = this.raw.slice(this.at, this.at + 2);
            const relation = relations[operator] ?? relations[ch]!;
            this.at += relations[operator] ? 2 : ch.length;
            const atom = this.base(true);
            if (atom.pending) this.fail();
            return '{' + relation + ' ' + atom.tex + '}';
        }
        if (script && ch === '*') { this.at++; return '{*}'; }
        const atom = this.base(script);
        if (atom.pending) this.fail();
        return '{' + atom.tex + '}';
    }
    base(script: boolean, chinese = false): { tex: string; pending: boolean; word?: boolean } {
        this.step();
        const ch = this.peek();
        if (ch === '\0') this.fail();
        let tex: string, pending = false, word = false;
        if ('([{'.includes(ch)) tex = this.group(script);
        else if (ch === '\\') {
            if (this.raw[this.at + 1] === '{') { this.at++; return { tex: this.group(false, true, false, true), pending: false }; }
            const name = this.command();
            if (name === 'left') {
                const escaped = this.peek() === '\\';
                if (escaped) this.at++;
                tex = this.group(script, true, true, escaped);
            }
            else if (atomCommands.has(name)) tex = '\\' + name;
            else if (prefix.has(name)) { tex = '\\' + name; pending = true; this.structures++; }
            else if (functions.has(name)) tex = '\\operatorname{' + name + '}';
            else if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
                this.structures++;
                tex = '\\' + name + this.argument(false) + this.argument(false);
            }
            else if (name === 'sqrt') {
                this.structures++;
                const degree = this.peek() === '[' ? this.group(false) : '';
                tex = '\\sqrt' + degree + this.argument(false);
            }
            else if (unaryCommands.has(name)) tex = '\\' + name + this.argument(false);
            else if (textCommands.has(name)) tex = '\\' + name + this.textArgument();
            else this.fail();
            this.features++;
        }
        else if (/^[A-Za-z][\u0302\u0303\u0304\u0307\u0308]+$/u.test(ch.normalize('NFD'))) {
            const [base, ...marks] = ch.normalize('NFD');
            tex = marks.reduce((body, mark) => '\\' + accents[mark] + '{' + body + '}', base!);
            this.at += ch.length; this.features++;
        }
        else if (/[A-Za-z]/.test(ch)) {
            const name = (this.permissive ? /^[A-Za-z][A-Za-z0-9]*/ : /^[A-Za-z]+/).exec(this.raw.slice(this.at))![0];
            this.at += name.length;
            if (name.length === 1 || /^[A-Z]{2,3}$/.test(name)) tex = name;
            else if (script && name.length <= 64) tex = '\\mathrm{' + name + '}';
            else if (functions.has(name)) { tex = '\\operatorname{' + name + '}'; this.features++; }
            else if (/^d[A-Za-z]$/.test(name)) tex = '\\mathrm{d}' + name[1];
            else if (this.permissive && name.length <= 64) {
                const callable = /^[ \t]*[([]/.test(this.raw.slice(this.at));
                tex = (callable ? '\\operatorname{' : '\\mathrm{') + name + '}';
                word = !callable;
            }
            else this.fail();
        }
        else if (/\d/.test(ch) || ch === '.' && /\d/.test(this.raw[this.at + 1] ?? '')) {
            const number = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.raw.slice(this.at))![0];
            this.at += number.length;
            const scientific = /^(.+)[eE]([+-]?\d+)$/.exec(number);
            tex = scientific ? scientific[1] + '\\times 10^{' + scientific[2] + '}' : number;
        }
        else if (greek.has(ch) || symbols[ch]) {
            this.at += ch.length;
            tex = greek.has(ch) ? '\\' + greek.get(ch)! : symbols[ch]!;
            if ((ch === 'Σ' || ch === 'Π') && /^\s*[_^]/.test(this.raw.slice(this.at)))
                tex = ch === 'Σ' ? '\\sum' : '\\prod';
            pending = prefix.has(tex.slice(1));
            if (pending) this.structures++;
            this.features++;
        }
        else if (ch === '.' && this.raw.startsWith('..', this.at)) {
            const ellipsis = this.raw.startsWith('...', this.at);
            this.at += ellipsis ? 3 : 2; tex = ellipsis ? '\\ldots' : '\\ldotp\\ldotp';
        }
        else if (ch === '…' || ch === '⋯') { this.at++; tex = ch === '…' ? '\\ldots' : '\\cdots'; }
        else if (chinese && /\p{Script=Han}/u.test(ch)) {
            const phrase = /^[\p{Script=Han}]+/u.exec(this.raw.slice(this.at))![0];
            this.at += phrase.length;
            tex = '\\text{' + phrase + '}';
        }
        else if (this.permissive && /[\p{L}\p{Sm}]/u.test(ch) && !/\p{Script=Han}/u.test(ch)) {
            // Retain unfamiliar Unicode letters/operators as written. MathJax
            // can use a glyph or its literal-text fallback without guessing.
            this.at += ch.length; tex = ch;
        }
        else this.fail();
        this.atoms++;
        return { tex, pending, word };
    }
    atom(script: boolean, chinese: boolean): { tex: string; pending: boolean; word?: boolean } {
        return this.suffix(this.base(script, chinese));
    }
    suffix(value: { tex: string; pending: boolean; word?: boolean }): { tex: string; pending: boolean; word?: boolean } {
        const seen = new Set<string>();
        for (;;) {
            const ch = this.peek();
            if (accents[ch]) { value.tex = '\\' + accents[ch] + '{' + value.tex + '}'; this.at += ch.length; this.features++; }
            else if (ch === "'" || ch === '′' || ch === '″') {
                let primes = 0;
                while (["'", '′', '″'].includes(this.raw[this.at] ?? '')) { primes += this.raw[this.at++] === '″' ? 2 : 1; }
                if (primes > 4 || seen.has('^')) this.fail();
                value.tex += '^{' + '\\prime '.repeat(primes).trim() + '}'; seen.add('^'); this.features++;
            }
            else if (ch === '_' || ch === '^' || supers.includes(ch) || subs.includes(ch)) {
                const operator = ch === '_' || subs.includes(ch) ? '_' : '^';
                if (seen.has(operator)) this.fail();
                seen.add(operator); this.features++;
                if (ch === '_' || ch === '^') {
                    this.at++;
                    // A history comparison is meaningful in a subscript only.
                    if (operator === '^' && /[<>≤≥]/u.test(this.peek())) this.fail();
                    value.tex += operator + this.argument(true, operator === '_');
                }
                else {
                    const chars = operator === '^' ? supers : subs, values = operator === '^' ? superValues : subValues;
                    let body = '';
                    while (chars.includes(this.raw[this.at] ?? '\0')) body += values[chars.indexOf(this.raw[this.at++]!)]!;
                    value.tex += operator + '{' + body + '}';
                }
            }
            else if (ch === '!') { value.tex += '!'; this.at++; }
            else break;
        }
        if (seen.size) value.word = false;
        return value;
    }
    sequence(close = '', script = false): string {
        const output: string[] = [];
        let expecting = true, any = false, previousWord = false;
        for (;;) {
            this.step();
            const ch = this.peek();
            if (ch === '\0' || close && (ch === close || this.raw.startsWith('\\' + close, this.at) || /^\\right\b/.test(this.raw.slice(this.at)))) break;
            if (')]}'.includes(ch)) this.fail();
            const pair = this.raw.slice(this.at, this.at + 2);
            if (expecting && ch === '·' && this.depth > 0 && /^\s*[)\]}|,]/.test(this.raw.slice(this.at + 1))) {
                output.push('\\cdot'); this.at++; this.atoms++; this.features++; expecting = false; any = true; continue;
            }
            let relation = relations[pair] ?? relations[ch], operator = binary[ch], advance = relations[pair] ? 2 : ch.length;
            if (ch === '∥' && expecting) relation = undefined; // Opening norm, versus a parallel relation between operands.
            if (ch === '\\') {
                const name = /^\\([A-Za-z]+)/.exec(this.raw.slice(this.at))?.[1];
                if (name && (relationCommands.has(name) || binaryCommands.has(name))) {
                    relation = relationCommands.has(name) ? '\\' + name : undefined;
                    operator = binaryCommands.has(name) ? '\\' + name : undefined;
                    advance = name.length + 1; this.features++;
                }
                else if (/^\\[!,;: ]/.test(this.raw.slice(this.at))) { this.at += 2; continue; }
            }
            if (relation || operator) {
                const scriptRelation = script && (!any || output.at(-1) === ',' || output.at(-1) === ':');
                if (expecting && !(operator && ['+', '-', '−', '±', '∓'].includes(ch)) &&
                    !(relation && (scriptRelation || this.continuation && !close && !any))) this.fail();
                if (relation) { this.relations++; if (!'=<>'.includes(ch)) this.features++; }
                output.push(relation ?? operator!); this.at += advance; expecting = true; previousWord = false; continue;
            }
            // A semicolon separates fixed/variable mathematical parameters only
            // inside parentheses. It never permits top-level program statements.
            if (ch === ',' || ch === ':' || ch === ';' && close === ')' && !script) {
                if (expecting) this.fail();
                output.push(ch); this.at++; expecting = true; previousWord = false; continue;
            }
            if (ch === '|' || ch === '‖' || ch === '∥') {
                const norm = pair === '||' || ch === '‖' || ch === '∥', delimiter = ch === '‖' || ch === '∥' ? ch : norm ? '||' : '|';
                this.at += delimiter.length;
                if (expecting) {
                    const body = this.sequence(ch, script);
                    if (!this.raw.startsWith(delimiter, this.at)) this.fail();
                    this.at += delimiter.length;
                    output.push(this.suffix({ tex: (norm ? '\\lVert ' : '\\lvert ') + body + (norm ? ' \\rVert' : ' \\rvert'), pending: false }).tex);
                    this.atoms++; this.features++; this.structures++; expecting = false; any = true;
                }
                else { output.push(norm ? '\\Vert' : '\\mid'); expecting = true; }
                continue;
            }
            const value = this.atom(script, this.sets > 0);
            if (previousWord && value.word) this.fail(); // Literal prose is not a product of invented variables.
            output.push(value.tex); expecting = value.pending; any = true;
            previousWord = value.word === true;
        }
        if (!any || expecting) this.fail();
        return output.join(' ');
    }
}

export interface NotationConversion { tex?: string; reason?: 'program' | 'limit' | 'unsupported'; }
/** A confirmed mathematical region may introduce arbitrary names. This path
 * converts notation without requiring a dictionary entry for every function. */
export function convertClaudeNotation(raw: string, continuation = false): NotationConversion {
    if (raw.length > 4096) return { reason: 'limit' };
    if (hasClaudeProgramSyntax(raw)) return { reason: 'program' };
    try {
        const parser = new Notation(raw, true, continuation), tex = parser.sequence();
        if (parser.at === raw.length && parser.atoms >= (continuation ? 1 : 2)) return { tex };
    } catch { }
    return { reason: 'unsupported' };
}

export function parseClaudeNotation(raw: string): string | undefined {
    if (!raw.trim() || raw.length > 4096 || forbidden.test(raw)) return;
    try {
        const parser = new Notation(raw), tex = parser.sequence();
        // Require mathematical evidence and a complete relation or an explicit
        // structure such as a fraction, integral or norm. Plain assignments
        // and arbitrary expressions in untyped code stay literal.
        return parser.at === raw.length && parser.features > 0 && (parser.relations > 0 || parser.structures > 0) && parser.atoms >= 2 ? tex : undefined;
    }
    catch { return; }
}
