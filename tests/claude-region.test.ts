import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convertClaudeNotation } from '../packages/adapter-claude/src/notation.js';
import { inspectClaudeMathBlock } from '../packages/adapter-claude/src/math-block.js';
import { inspectClaudeMath, findClaudeFormulas } from '../packages/adapter-claude/src/math.js';
import { claudeSourceKeys, matchClaudeText } from '../packages/adapter-claude/src/matcher.js';
import { NativeAnalyzer } from '../packages/windows-companion/src/analyzer.js';
import { MathRenderer } from '../packages/core/src/renderer.js';
const fixture: { intro: string; blocks: { name: string; raw: string; expressions: number }[] } =
    JSON.parse(readFileSync(new URL('./fixtures/claude-gspo-math.json', import.meta.url), 'utf8'));
const fenced = (raw: string, language = '') => '```' + language + '\n' + raw + '\n```';
const screen = (source: string) => '● ' + source.replace(/^```[^\n]*\n/gm, '').split('\n').join('\n  ') + '\n❯ ';
const history = (raw: string) => raw + '\n' + '─'.repeat(80) + '\n❯ \n' + '─'.repeat(80) + '\n  ? for shortcuts';
function pngs(source: string, expected: number) {
    const shown = screen(source), match = matchClaudeText(shown, [{ id: 'region', file: 'region', cwd: 'D:/fixture', assistant: [source] }], '', true);
    assert.equal(match.regions.length, expected);
    const analyzer = new NativeAnalyzer(), request = { type: 'analyze' as const, id: 1, text: shown, rowHeight: 28, width: 1900,
        foreground: '#cccccc', background: '#0c0c0c', inlineMath: true };
    let result = analyzer.analyze(request, [], match);
    for (let i = 0; result.pendingRender && i < 30; i++) result = analyzer.analyze(request, [], match);
    assert.equal(result.formulas.length, expected, 'every prepared expression reaches a readable PNG');
    assert.equal(result.skipped, 0);
    return result;
}

test('six GSPO regions convert all eight expressions, preserving compound scripts and blank-line continuations', () => {
    const source = fixture.intro + '\n\n' + fixture.blocks.map(({ name, raw }) => name + ' formula.\n\n' + fenced(raw) + '\n\nEnd of ' + name + '.').join('\n\n');
    const report = inspectClaudeMath(source);
    assert.equal(report.candidates.length, 8);
    assert.equal(report.formulas.length, 8);
    assert.equal(report.rejectedBlocks.length, 0);
    const expectedExpressions = fixture.blocks.flatMap(block => block.expressions === 1 ? [block.raw] : block.raw.split('\n\n'));
    assert.deepEqual(report.formulas.map(f => f.raw), expectedExpressions);
    assert.equal(report.formulas.filter(f => f.raw.startsWith('s_i(θ)')).length, 1, 'continued equalities stay together');
    assert.match(report.formulas[1]!.tex, /gathered/);
    assert.match(report.formulas[1]!.tex, /i , < t/);
    assert.ok(report.formulas.some(f => f.tex.includes('\\operatorname{sg}')));
    assert.ok(report.formulas.some(f => f.tex.includes('\\text{GSPO-token}')));
    pngs(source, 8);
    const session = { id: 'gspo', file: 'gspo', cwd: 'D:/fixture', assistant: [source] };
    const rows = screen(source).split('\n').slice(1, -1), compact = (s: string) => s.replace(/\s/gu, '');
    for (let start = 0; start < rows.length; start++) for (const height of [1, 3, 8, 16, 30]) {
        const body = rows.slice(start, start + height), shown = compact(body.join(''));
        const expected = expectedExpressions.filter(raw => shown.includes(compact(raw))).length;
        assert.equal(matchClaudeText(history(body.join('\n')), [session], '', true).regions.length, expected, start + '+' + height);
    }
    assert.equal(matchClaudeText(screen(source), [session], '', false).regions.length, 0);
});

test('custom functions and named quantities need no dictionary entries in mathematical regions', () => {
    const renderer = new MathRenderer();
    for (const name of ['sg', 'stopGradient', 'myCustomMetric', 'newOp42', 'unknown', 'rewardModel']) {
        for (const [open, close] of [['(', ')'], ['[', ']']]) {
            const raw = 'L_θ = ' + name + open + 'x_t, y_{i,<t}' + close;
            const values = inspectClaudeMathBlock(raw).candidates;
            assert.equal(values.length, 1);
            assert.ok(values[0]!.tex?.includes('\\operatorname{' + name + '}'));
            assert.ok(renderer.render(values[0]!.tex!).width > 0);
        }
    }
    const source = 'The loss function formula is defined below.\n\n' + fenced('totalLoss = customMetric(prediction, target)');
    assert.equal(findClaudeFormulas(source).length, 1, 'math context also supports plain named quantities');
    assert.equal(findClaudeFormulas(fenced('foo = bar')).length, 0, 'an ambiguous plain assignment alone is insufficient');
    assert.equal(convertClaudeNotation('L_θ = α_t ⋆ β_t').tex?.includes('⋆'), true, 'unfamiliar Unicode operators retain their glyph');
    for (const raw of ['L_θ = x_t  单位为 (count', 'L_θ = \\text{结果 当 t 有效}', 'L_θ = \\text{[count}']) {
        const report = inspectClaudeMathBlock(raw);
        assert.equal(report.candidates.filter(f => f.tex).length, 1, raw);
        assert.ok(renderer.render(report.candidates[0]!.tex!).width > 0);
    }
});

test('broken expressions remain local and remain discoverable through source indexing', () => {
    for (const bad of ['x_t = \\unknown{y_t}', 'x_t = (y_t', 'x_t = y_t +']) {
        const raw = 'a_t = custom(x_t)\n\n' + bad + '\n\nz_t^2+x_t^2=y_t^2';
        const source = 'Independent mathematical definitions.\n\n' + fenced(raw) + '\n\nEnd of answer.';
        const report = inspectClaudeMath(source);
        assert.equal(report.candidates.length, 3, bad);
        assert.equal(report.formulas.length, 2, bad);
        assert.equal(report.candidates.filter(f => f.reason).length, 1);
        for (const f of report.candidates) assert.equal(source.slice(f.start, f.end), f.raw);
        assert.ok(claudeSourceKeys(source).includes('claude:' + bad.replace(/\s/gu, '')), 'failed conversion still has an exact source key');
        pngs(source, 2);
    }
    const contiguous = inspectClaudeMathBlock('x_t = y_t\nz_t = \\unknown{y_t}\nw_t = x_t');
    assert.equal(contiguous.candidates.filter(f => f.tex).length, 2, 'independent lines also isolate unsupported notation');
});

test('literal explanations, original offsets, stream completeness and code boundaries remain protected', () => {
    const raw = 'loss = customMetric(x_t)\nThis is an explanatory sentence.\nz_t = sg[x_t]\n\n说明：保留这行原文。\n\nw_t = z_t';
    for (const body of [raw, raw.replaceAll('\n', '\r\n')]) {
        const source = 'A mathematical formula.\n\n' + fenced(body), report = inspectClaudeMath(source);
        assert.equal(report.formulas.length, 3);
        for (const f of report.candidates) {
            assert.equal(source.slice(f.start, f.end), f.raw);
            assert.ok(!f.raw.includes('explanatory') && !f.raw.includes('说明'));
        }
        assert.equal(findClaudeFormulas(source.slice(0, -3)).length, 0);
        assert.equal(findClaudeFormulas('A formula.\n\n' + fenced(body, 'python')).length, 0);
    }
    for (const code of ['const x_t = y_t;', 'x_t == custom(y_t)', 'x_t = [y_t for y_t in z_t]', 'print(x_t)', 'x_t = y_t; z_t = 1']) {
        const report = inspectClaudeMath(fenced(code + '\n\nx_t^2+y_t^2=z_t^2'));
        assert.equal(report.formulas.length, 0, code);
        assert.equal(report.rejectedBlocks[0]?.reason, 'program');
    }
    assert.equal(inspectClaudeMathBlock('x_t = (' + '('.repeat(24) + 'y_t' + ')'.repeat(25)).candidates[0]?.reason, 'unsupported');
    assert.equal(inspectClaudeMathBlock('x_t = ' + 'y'.repeat(66000)).reason, 'limit');
    const explicit = 'Explicit mathematical quantity.\n\n' + fenced('\\[\nq_{reference}\n\\]') + '\n\nEnd of definition.';
    assert.equal(findClaudeFormulas(explicit).length, 1, 'explicit delimiters do not require heuristic math evidence');
    pngs(explicit, 1);
});
