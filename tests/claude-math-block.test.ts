import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseClaudeMathBlock } from '../packages/adapter-claude/src/math-block.js';
import { claudeMathTex, findClaudeFormulas } from '../packages/adapter-claude/src/math.js';
import { claudeSourceKeys, claudeVisibleKeys, matchClaudeText } from '../packages/adapter-claude/src/matcher.js';
import { MathRenderer } from '../packages/core/src/renderer.js';
import { NativeAnalyzer } from '../packages/windows-companion/src/analyzer.js';
const fenced = (raw: string, lang = '') => '```' + lang + '\n' + raw + '\n```';
const screen = (text: string) => '● ' + text.replace(/^```[^\n]*\n/gm, '').split('\n').join('\n  ') + '\n❯ ';
const dpo: { intro: string; blocks: { name: string; raw: string }[] } = JSON.parse(readFileSync(new URL('./fixtures/claude-dpo-math.json', import.meta.url), 'utf8'));

test('complete DPO answer has ten independent formulas through clipping, source proof, PNG and preview toggles', () => {
    const source = dpo.intro + '\n\n' + dpo.blocks.map(({ name, raw }) => `${name}.\n\n${fenced(raw)}\n\nEnd of ${name}.`).join('\n\n');
    const session = { id: 'full-dpo', file: 'full-dpo', cwd: 'D:/fixture', assistant: [source] };
    const formulas = findClaudeFormulas(source);
    assert.equal(formulas.length, 10);
    const shown = screen(source), analyzer = new NativeAnalyzer();
    const match = matchClaudeText(shown, [session], '', true);
    assert.equal(match.regions.length, 10);
    const request = { type: 'analyze' as const, id: 1, text: shown, rowHeight: 28, width: 1900,
        foreground: '#cccccc', background: '#0c0c0c', inlineMath: true };
    let result = analyzer.analyze(request, [], match);
    for (let i = 0; result.pendingRender && i < 30; i++) result = analyzer.analyze(request, [], match);
    assert.equal(result.formulas.length, 10);
    assert.equal(result.skipped, 0);
    assert.equal(matchClaudeText(shown, [session], '', false).regions.length, 0);
    assert.equal(matchClaudeText(shown, [session, { ...session, file: 'ambiguous' }], '', true).state, 'ambiguous');
    const rows = shown.split('\n').slice(1, -1), compact = (s: string) => s.replace(/\s/gu, '');
    for (let start = 0; start < rows.length; start++)
        for (const height of [1, 4, 12, 24]) {
            const body = rows.slice(start, start + height), frame = body.join('\n') + '\n' + '─'.repeat(80) + '\n❯ \n' + '─'.repeat(80) + '\n  ? for shortcuts';
            const expected = formulas.filter(f => compact(body.join('')).includes(compact(f.raw))).length;
            assert.equal(matchClaudeText(frame, [session], '', true).regions.length, expected, `${start}+${height}`);
        }
    const programSource = dpo.intro + '\n\n' + dpo.blocks.map(({ raw }) => fenced(raw, 'python')).join('\n\n');
    assert.equal(findClaudeFormulas(programSource).length, 0);
});

test('preference relations and mathematical semicolons retain their exact roles', () => {
    const pairs = [['≻', 'succ'], ['≺', 'prec'], ['≽', 'succeq'], ['≼', 'preceq'], ['⊥', 'perp'], ['∥', 'parallel'],
        ['≪', 'll'], ['≫', 'gg'], ['≲', 'lesssim'], ['≳', 'gtrsim'], ['≍', 'asymp'], ['↔', 'leftrightarrow']];
    const renderer = new MathRenderer();
    for (const [symbol, command] of pairs) {
        const raw = `x_t ${symbol} y_t`, tex = claudeMathTex(raw);
        assert.ok(tex, raw);
        assert.ok(tex?.includes('\\' + command), raw);
        assert.equal(tex, claudeMathTex(`x_t \\${command} y_t`));
        assert.ok(renderer.render(tex).width > 0);
    }
    assert.match(claudeMathTex('L_DPO(π_θ; π_ref) = E_t[x_t]')!, /; \\pi_\{\\mathrm\{ref\}\}/);
    assert.match(claudeMathTex('L_θ = \\text{fixed; reference}')!, /\\text\{fixed; reference\}/);
    assert.ok(claudeMathTex('L_θ = x_t \\; + y_t'));
    for (const raw of ['x_t = y_t; z_t = x_t', 'f(x_t; y_t); z_t = 1', 'x_t = (y_t;)', 'x_t = (;y_t)', 'x_t = f(y_t;;z_t)',
        'x_t = y_t;\n\nz_t = x_t', 'f(x_t; console.log(y_t)) = 1']) {
        assert.equal(claudeMathTex(raw), undefined, raw);
        assert.equal(parseClaudeMathBlock(raw), undefined, raw);
    }
});

test('bounded text suffixes preserve literal text and produce complete readable PNGs', () => {
    const examples = [
        'm_t = 1  当 s_t 属于回答 y', 'm_t = 0  当 s_t 属于提示 x 或 padding',
        'p_t = x_t, where x_t is the probability', 'x_t = y_t  if t > 0',
        'L_θ = x_t  单位为 10% (value_a)', 'm_{t} = 0  否则',
        'm_t = 1  当 s_t 属于回答 y\nm_t = 0  当 s_t 属于提示 x 或 padding',
    ];
    const analyzer = new NativeAnalyzer();
    for (const raw of examples) {
        const spans = parseClaudeMathBlock(raw);
        assert.equal(spans?.length, 1, raw);
        assert.ok(spans[0]!.tex.includes('\\text{'), raw);
        assert.equal(spans[0]!.raw, raw);
        const source = 'A mathematical definition.\n\n' + fenced(raw) + '\n\nEnd of the definition.', shown = screen(source);
        const match = matchClaudeText(shown, [{ id: 'annotated', file: raw, cwd: 'D:/fixture', assistant: [source] }], '', true);
        assert.equal(match.regions.length, 1, raw);
        const request = { type: 'analyze' as const, id: 1, text: shown, rowHeight: 28, width: 1900,
            foreground: '#cccccc', background: '#0c0c0c', inlineMath: true };
        let result = analyzer.analyze(request, [], match);
        for (let i = 0; result.pendingRender && i < 20; i++) result = analyzer.analyze(request, [], match);
        assert.equal(result.formulas.length, 1, raw);
        assert.equal(result.skipped, 0, raw);
    }
    assert.ok(parseClaudeMathBlock(examples[4]!)![0]!.tex.includes('10% (value_a)'));
    const renderer = new MathRenderer();
    for (const raw of [examples[0]!, examples[4]!, 'm_t = 1  当 value_{a} 占比为 10% 且 $x_t$ 有效']) {
        const tex = parseClaudeMathBlock(raw)![0]!.tex, image = renderer.render(tex);
        assert.ok(!image.svg.includes('data-c="5C"'), 'literal text must not acquire backslash glyphs');
        assert.ok(image.svg.includes('data-c="5F"'), 'literal underscores must survive text rendering');
        if (raw.includes('10%')) assert.ok(image.svg.includes('data-c="25"'), 'literal percentages must survive');
    }
});

test('standalone explanations remain literal while adjacent math retains exact source offsets', () => {
    const body = 'L_θ = E_t[x_t]\n其中 x_t 表示逐步损失。\nm_t = 1  当 s_t 属于回答 y\n\n说明：下面是梯度。\n\n∇_θ L_θ = E_t[∇_θ x_t]';
    for (const raw of [body, body.replaceAll('\n', '\r\n')]) {
        const spans = parseClaudeMathBlock(raw)!;
        assert.equal(spans.length, 3);
        for (const span of spans) assert.equal(raw.slice(span.start, span.end), span.raw);
        assert.ok(spans.every(span => !span.raw.includes('其中') && !span.raw.includes('说明：')));
        const source = 'Annotated mathematical block.\n\n' + fenced(raw) + '\n\nEnd of answer.', shown = screen(source);
        const session = { id: 'mixed', file: 'mixed', cwd: 'D:/fixture', assistant: [source] };
        assert.equal(findClaudeFormulas(source).length, 3);
        const match = matchClaudeText(shown, [session], '', true);
        assert.equal(match.regions.length, 3);
        const rows = shown.split(/\r?\n/);
        for (const r of match.regions) assert.ok(!rows.slice(r.startRow, r.endRow + 1).join('').includes('其中'));
        const keys = new Set(claudeVisibleKeys(shown, ''));
        assert.ok(claudeSourceKeys(source).every(key => keys.has(key)));
        assert.equal(matchClaudeText(shown, [session], '', false).regions.length, 0);
        assert.equal(findClaudeFormulas(fenced(raw, 'python')).length, 0);
    }
});

test('mixed text preserves code boundaries and isolates unsupported or malformed mathematical expressions', () => {
    const code = ['const x_t = y_t;\n其中 x_t 为变量。', 'x_t = y_t;  当 t > 0',
        'x_t = y_t  当 console.log(x_t)', 'x_t = [y_t  for y_t in z_t]'];
    const invalid = [
        'x_t = (y_t\n其中 y_t 是变量。\nz_t = y_t', 'x_t = y_t +  当 t > 0',
        'x_t = (这里是说明文字)', 'x_t = \\unknown{y_t}\n说明：保持原文。',
        'x_t = y_t  当 ' + '字'.repeat(257)];
    for (const raw of code) {
        assert.equal(parseClaudeMathBlock(raw), undefined, raw);
        assert.equal(findClaudeFormulas(fenced(raw + '\n\nz_t^2+x_t^2=y_t^2')).length, 0, raw);
    }
    for (const raw of invalid) {
        assert.equal(parseClaudeMathBlock(raw), undefined, raw);
        assert.equal(findClaudeFormulas(fenced(raw + '\n\nz_t^2+x_t^2=y_t^2')).length, 1, raw);
    }
    for (const raw of ['x_t = unknown(y_t)\n其中 x_t 为变量。', 'x_t = y_t\nThis is an arbitrary paragraph.',
        'x_t = y_t\n说明：' + '字'.repeat(257)]) {
        assert.equal(parseClaudeMathBlock(raw)?.length, 1, raw);
    }
    for (const text of ['where x_t is a variable', '其中 x_t 是变量。']) {
        assert.equal(parseClaudeMathBlock(text), undefined);
        assert.equal(findClaudeFormulas(fenced(text + '\n\nz_t^2+x_t^2=y_t^2')).length, 1);
    }
    const strong = fenced('L_θ = \\underbrace{x_t+y_t}_{\\text{total}}', 'latex');
    assert.equal(findClaudeFormulas(strong).length, 1, 'explicit math containers retain their TeX fallback');
    assert.equal(findClaudeFormulas(strong.slice(0, -3)).length, 0);
});
