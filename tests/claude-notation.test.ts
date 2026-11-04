import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { claudeMathTex, findClaudeFormulas } from '../packages/adapter-claude/src/math.js';
import { matchClaudeText, claudeSourceKeys, claudeVisibleKeys } from '../packages/adapter-claude/src/matcher.js';
import { MathRenderer } from '../packages/core/src/renderer.js';
import { NativeAnalyzer } from '../packages/windows-companion/src/analyzer.js';
const cases: { name: string; raw: string }[] = JSON.parse(readFileSync(new URL('./fixtures/claude-common-math.json', import.meta.url), 'utf8'));
const fenced = (raw: string) => '```\n' + raw + '\n```';
const frame = (rows: string[]) => rows.join('\n') + '\n' + '─'.repeat(80) + '\n❯ \n' + '─'.repeat(80) + '\n  ? for shortcuts';

test('common Claude formula families parse completely and produce actual SVG and PNG', () => {
    const renderer = new MathRenderer(), analyzer = new NativeAnalyzer();
    for (const { name, raw } of cases) {
        const tex = claudeMathTex(raw);
        assert.ok(tex, name);
        const image = renderer.render(tex);
        assert.ok(image.svg.includes('<path') && image.width > 0 && image.height > 0, name);
        const source = `The ${name} mathematical relation.\n\n${fenced(raw)}\n\nEnd of this mathematical relation.`;
        const shown = '● ' + source.replace(/^```[^\n]*\n/gm, '').split('\n').join('\n  ');
        const match = matchClaudeText(shown, [{ id: name, file: name, cwd: 'D:/fixture', assistant: [source] }], '', true);
        assert.equal(match.regions.length, 1, name);
        const request = { type: 'analyze' as const, id: 1, text: shown, rowHeight: 28, width: 1900,
            foreground: '#cccccc', background: '#0c0c0c', inlineMath: true };
        let result = analyzer.analyze(request, [], match);
        for (let i = 0; result.pendingRender && i < 20; i++) result = analyzer.analyze(request, [], match);
        assert.equal(result.formulas.length, 1, name + ' reaches actual readable PNG');
        assert.deepEqual(Buffer.from(result.formulas[0]!.png, 'base64').subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
});

test('notation conversion preserves script scope, sampling, multiplication and mathematical meaning', () => {
    const tex = (raw: string) => { const value = claudeMathTex(raw); assert.ok(value, raw); return value; };
    assert.match(tex('p_θ(y) = Π_{t=1}^{T} p_θ(y_t|y_<t)'), /\\prod_\{t = 1\}\^\{T\}/);
    assert.match(tex('p_θ(y) = Π_{t=1}^{T} p_θ(y_t|y_<t)'), /y_\{< t\}/);
    assert.equal(tex('p_t = y_<t^(i)'), tex('p_t = y_{<t}^{(i)}'));
    assert.equal(tex('p_t = y_<=t'), tex('p_t = y_{≤t}'));
    assert.match(tex('L_θ = E_{x~p}[x²]'), /E_\{x \\sim p\}/);
    assert.equal(tex('L_θ = E_{x~p}[x²]'), tex('L_θ = E_{x∼p}[x²]'));
    assert.match(tex('F_norm = x_t / y_t'), /F_\{\\mathrm\{norm\}\}/);
    assert.match(tex('f_t = Π + Σ'), /\\Pi \+ \\Sigma/);
    assert.match(tex('f_t = E[x_t]'), /E \[/);
    assert.ok(!tex('f_t = E[x_t]').includes('mathbb'), 'ASCII expectation E retains its stated style');
    assert.ok(!tex('f_t = x_t / y_t').includes('frac'), 'solidus is never inferred as a stacked fraction');
    assert.match(tex('ε_t = 1e-8'), /1\\times 10\^\{-8\}/);
    assert.match(tex('f′(θ) = θ²'), /\\prime/);
});

test('generated histories and sampling expressions generalize without equation-specific patterns', () => {
    let count = 0;
    for (const base of ['x', 'y', 's', 'h', 'o'])
        for (const index of ['t', 'k', 'n', 'i'])
            for (const comparison of ['<', '>', '≤', '≥', '<=', '>='])
                for (const distribution of ['p', 'q', 'π_θ', 'q_φ']) {
                    const raw = `L_${index}(θ) = - E_{${base}~${distribution}}[log p_θ(${base}_${index}|${base}_${comparison}${index})]`;
                    assert.ok(claudeMathTex(raw), raw); count++;
                }
    assert.equal(count, 480);
});

test('programs stay protected and malformed expressions cannot prevent independent valid formulas', () => {
    const negatives = ['const x_t = y_t^2', 'x_t == y_t^2', 'x_t = ~y_t',
        "x_t = 'y_t'", 'x_t = "y_t"', 'x_t = y_t +', 'x_t = y_t <=', 'x_t = (y_t', 'x_t = y_t)',
        'x_t = y_t__i', 'x_t = y_t^^2', 'x_t = y_t^<i', 'x_t = y_t^', 'x_t = \\frac{x_t}',
        'x_t = \\sqrt{}', 'x_t = \\unknown{y_t}', 'x_t = \\left(y_t]', 'x_t = |y_t',
        'x_t = (这里是说明文字)',
        'x_t = y_t; print(x_t)', 'x_t += y_t', 'x_t = a_t && b_t', 'x_t = [y_t for y_t in z_t]'];
    for (const raw of negatives) {
        assert.equal(claudeMathTex(raw), undefined, raw);
        assert.equal(findClaudeFormulas(fenced(raw)).length, 0, raw);
        const code = ['const x_t = y_t^2', 'x_t == y_t^2', "x_t = 'y_t'", 'x_t = "y_t"',
            'x_t = y_t; print(x_t)', 'x_t += y_t', 'x_t = a_t && b_t', 'x_t = [y_t for y_t in z_t]'].includes(raw);
        assert.equal(findClaudeFormulas(fenced(raw + '\n\nx_t^2+y_t^2=r^2')).length, code ? 0 : 1, raw);
    }
    for (let i = 0; i < 1000; i++) {
        assert.equal(claudeMathTex(`const x_${i} = y_${i}^2`), undefined);
        assert.equal(claudeMathTex(`x_${i} = unknown${i}(y_${i})`), undefined);
    }
    assert.equal(claudeMathTex('x_t=' + '('.repeat(22) + 'y_t' + ')'.repeat(22)), undefined);
    assert.equal(claudeMathTex('x_t=' + 'y_t+'.repeat(1024) + 'y_t'), undefined);
});

test('new formula families survive independent partial viewports, code protection and source changes', () => {
    const selected = cases.filter(x => ['autoregressive product', 'SFT loss', 'token average', 'SFT gradient'].includes(x.name));
    const source = selected.map(({ name, raw }) => `${name} mathematical definition.\n\n${fenced(raw)}`).join('\n\n');
    const session = { id: 'common', file: 'common', cwd: 'D:/fixture', assistant: [source] };
    const rows = source.replace(/^```[^\n]*\n/gm, '').split('\n').map(x => '  ' + x);
    const compact = (x: string) => x.replace(/\s/gu, '');
    for (let start = 0; start < rows.length; start++)
        for (const height of [1, 2, 4, 8, 24]) {
            const body = rows.slice(start, start + height), shown = frame(body), visible = compact(body.join(''));
            const expected = selected.filter(x => visible.includes(compact(x.raw)));
            const match = matchClaudeText(shown, [session], '', true);
            assert.equal(match.regions.length, expected.length, `${start}+${height}`);
            const keys = new Set(claudeVisibleKeys(shown, '', new Set(selected.map(x => compact(x.raw).length))));
            for (const { raw } of expected) assert.ok(claudeSourceKeys(fenced(raw)).some(x => keys.has(x)));
        }
    for (const { raw } of selected) {
        assert.equal(findClaudeFormulas('```python\n' + raw + '\n```').length, 0);
        assert.equal(findClaudeFormulas(fenced(raw)).length, 1);
        assert.equal(findClaudeFormulas(fenced(raw).slice(0, -3)).length, 0);
        const shown = frame(raw.split('\n').map(x => '  ' + x));
        assert.equal(matchClaudeText(shown, [session], '', false).regions.length, 0);
        assert.equal(matchClaudeText(shown.replace(/θ/g, 'β'), [session], '', true).regions.length, 0);
        assert.equal(matchClaudeText(shown, [session, { ...session, file: 'other' }], '', true).state, 'ambiguous');
    }
});
