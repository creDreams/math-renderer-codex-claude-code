import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaudeFormulas, claudeMathTex } from '../packages/adapter-claude/src/math.js';
import { matchClaudeText, claudeSourceKeys, claudeVisibleKeys, isClaudeScreen } from '../packages/adapter-claude/src/matcher.js';
import { claudeHistoryAdapter, claudeRecord } from '../packages/adapter-claude/src/history.js';
import { HistoryIndex } from '../packages/adapter-codex/src/history-index.js';
import { NativeAnalyzer } from '../packages/windows-companion/src/analyzer.js';
import { MathRenderer } from '../packages/core/src/renderer.js';
import { claudeViewport } from '../packages/adapter-claude/src/viewport.js';
const blocks = [
    '{τ_1, τ_2, ..., τ_N}, τ_i = {(s_1^(i), a_1^(i), r_1^(i)), ..., (s_T^(i), a_T^(i), r_T^(i))}',
    'R(τ_i) = Σ_t r_t^(i)\n\nA^E(τ_i) = ( R(τ_i) − mean({R(τ_j)}_{j=1..N}) ) / F_norm',
    'U = { s̃ | s̃ 在 {τ_i} 中出现过 }',
    'G^S(s̃) = { (a_t^(i), R_t^(i)) | s_t^(i) = s̃ }',
    'R_t^(i) = Σ_{k=t}^{T} γ^(k−t) · r_k^(i)',
    'A^S(a_t^(i)) = ( R_t^(i) − mean({R_t^(j) | (a_t^(j), R_t^(j)) ∈ G^S(s̃)}) ) / F_norm',
    'A(a_t^(i)) = A^E(τ_i) + ω · A^S(a_t^(i))',
    'ρ_θ(a_t^(i)) = π_θ(a_t^(i) | s_t^(i), x) / π_old(a_t^(i) | s_t^(i), x)\n\n' +
        'J_GiGPO(θ) = E[ (1 / NT) Σ_i Σ_t min( ρ_θ · A(a_t^(i)),\n' +
        '  clip(ρ_θ, 1−ε, 1+ε) · A(a_t^(i)) ) ]\n  − β · D_KL( π_θ || π_ref )',
];
const source = 'Mathematical answer for regression.\n\n' + blocks.map((b, i) => `Step ${i + 1} formula definition.\n\n\`\`\`\n${b}\n\`\`\`\n\nEnd of mathematical step ${i + 1}.`).join('\n\n');
const shown = '● ' + source.replace(/^```[^\n]*\n/gm, '\n').split('\n').join('\n  ') + '\n\n✻ Churned for 35s\n❯ ';
const session = { id: 'claude-test', file: 'fixture.jsonl', cwd: 'D:/fixture', assistant: [source] };
const record = (text: string) => ({ type: 'assistant', sessionId: session.id, cwd: session.cwd, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const historyView = (body: string, prompt = 'Explain the mathematical derivation.') =>
    `❯ ${prompt}\n${body}\n  Jump to bottom (ctrl+End) ↓\n${'─'.repeat(80)}\n❯ \n${'─'.repeat(80)}\n  ⏵⏵ bypass permissions on (shift+tab to cycle)`;
test('Claude mathematical code blocks retain complete notation and render all sample expressions', () => {
    const formulas = findClaudeFormulas(source), renderer = new MathRenderer();
    assert.equal(formulas.length, 10);
    for (const f of formulas) {
        assert.equal(source.slice(f.start, f.end), f.raw);
        const image = renderer.render(f.tex);
        assert.ok(image.width > 0);
        assert.ok(!f.tex.includes('\\frac'), 'solidus is not inferred as a stacked fraction');
    }
    assert.match(formulas[5]!.tex, /\\sum/);
    assert.match(formulas[3]!.tex, /\\text\{中出现过\}/);
    assert.match(formulas[4]!.tex, /\^\{\(i\)\}/);
});
test('code blocks, tool results, thinking, sidechains and unfinished streams remain protected', () => {
    for (const language of ['python', 'javascript', 'bash', 'json'])
        assert.deepEqual(findClaudeFormulas('```' + language + '\nx^2+y^2=r^2\n```'), []);
    assert.deepEqual(findClaudeFormulas('```\nconst y = 2;\n\nx^2+y^2=r^2\n```'), [], 'mixed untyped programs remain entirely protected');
    for (const raw of ['const x = y^2 + z^2', 'x^2 == y^2 + z^2', 'x^2 = unknown(y)', 'x^2 = y^2 +', 'x^2 = (y^2', 'x^2 = y^2; print(x)'])
        assert.equal(claudeMathTex(raw), undefined, raw);
    const input = 'A formula.\n```\nx^2+y^2=r^2\n```';
    for (let n = 0; n < input.length; n++)
        assert.deepEqual(findClaudeFormulas(input.slice(0, n)), [], String(n));
    for (const r of [{ ...record(source), type: 'user' }, { ...record(source), isSidechain: true },
        { ...record(source), message: { role: 'assistant', content: [{ type: 'thinking', thinking: source }] } },
        { ...record(source), isCompactSummary: true }, { ...record(source), message: { role: 'user', content: [{ type: 'text', text: source }] } }])
        assert.equal(claudeRecord(r).text, undefined);
});
test('Claude matches each block independently and preview off removes unmarked blocks', () => {
    const match = matchClaudeText(shown, [session], '', true);
    assert.equal(match.state, 'matched');
    assert.equal(match.regions.length, 10);
    assert.equal(matchClaudeText(shown, [session], '', false).regions.length, 0);
    const rows = shown.split('\n');
    for (let i = 1; i < match.regions.length; i++)
        assert.ok(match.regions[i]!.startRow > match.regions[i - 1]!.endRow, 'empty padding is never shared');
    for (const r of match.regions)
        assert.ok(rows.slice(r.startRow, r.endRow + 1).join('').includes('='));
});
test('all completely visible formulas survive every viewport position and wrapping', () => {
    const rows = shown.split('\n'), all = matchClaudeText(shown, [session], '', true).regions;
    for (let start = 0; start < rows.length; start++)
        for (const height of [6, 12, 24, 60]) {
            const visible = rows.slice(start, start + height).join('\n'), context = rows.slice(0, start).join('\n') + (start ? '\n' : '');
            const current = matchClaudeText(visible, [session], context, true);
            // Compare the actual formula rows, allowing optional blank padding at edges.
            for (const f of all) {
                let begin = f.startRow, end = f.endRow;
                while (!rows[begin]!.trim())
                    begin++;
                while (!rows[end]!.trim())
                    end--;
                if (begin >= start && end < start + height)
                    assert.ok(current.regions.some(r => r.startRow <= begin - start && r.endRow >= end - start), `formula ${begin}-${end} viewport ${start}+${height}`);
            }
            const keys = new Set(claudeVisibleKeys(visible, context));
            if (current.regions.length)
                assert.ok(claudeSourceKeys(source).some(k => keys.has(k)));
        }
    const wrap = shown.split('\n').flatMap(line => line.length > 60 && line.startsWith('  ') ? [line.slice(0, 60), '  ' + line.slice(60)] : [line]).join('\n');
    assert.equal(matchClaudeText(wrap, [session], '', true).regions.length, 10);
});
test('Claude repainted history needs no assistant marker or offscreen terminal context', () => {
    const body = shown.split('\n').slice(1, -3);
    const expressions = blocks.flatMap(block => block.split('\n\n')).map(raw => raw.replace(/\s/gu, ''));
    let positions = 0;
    for (let start = 0; start < body.length; start++)
        for (const height of [1, 2, 3, 6, 12, 24, 70]) {
            const rows = body.slice(start, start + height);
            for (const variant of ['pinned-history', 'history', 'pinned-bottom', 'bottom', 'bottom-completed']) {
                let text = historyView(rows.join('\n'));
                if (variant !== 'pinned-history' && variant !== 'pinned-bottom') text = text.replace(/^❯[^\n]*\n/u, '');
                if (variant.includes('bottom')) text = text.replace('Jump to bottom (ctrl+End) ↓', variant === 'bottom-completed' ? '✻ Churned for 35s · done 17:54' : '');
                assert.equal(isClaudeScreen(text, '• Previous Codex scrollback.'), true);
                const expected = expressions.filter(raw => rows.map(row => row.replace(/\s/gu, '')).join('').includes(raw));
                const result = matchClaudeText(text, [session], '', true);
                assert.equal(result.regions.length, expected.length, `repainted ${variant} ${start}+${height}`);
                const keys = new Set(claudeVisibleKeys(text, '', new Set(expressions.map(raw => raw.length))));
                for (const raw of expected)
                    assert.ok(keys.has('claude:' + raw), 'disk lookup and matching see the same independent expression');
                const margin = variant.startsWith('pinned') ? 1 : 0;
                assert.ok(result.regions.every(r => r.startRow >= margin && r.endRow <= rows.length + margin), 'pinned prompt and floating controls are never covered');
                positions++;
            }
        }
    assert.ok(positions > 2000);
});
test('Claude viewport bounds agree with native host across shared layouts and input boundaries', () => {
    const fixtures: { name: string; rows: string[]; startRow: number; endRow: number }[] = JSON.parse(readFileSync(new URL('./fixtures/claude-viewports.json', import.meta.url), 'utf8'));
    for (const fixture of fixtures) {
        const expected = fixture.startRow < 0 ? undefined : { startRow: fixture.startRow, endRow: fixture.endRow };
        assert.deepEqual(claudeViewport(fixture.rows), expected, fixture.name);
    }
    const text = historyView('  Step 1 formula definition.\n\n  ' + blocks[0]).replace(/^❯[^\n]*\n/u, '').replace('Jump to bottom (ctrl+End) ↓', '✻ Churned for 35s · done 17:54');
    assert.equal(isClaudeScreen(text, '• Old Codex scrollback.'), true);
    assert.equal(matchClaudeText(text, [session], '', true).regions.length, 1, 'reported bottom layout survives without any role, hint or pinned prompt');
    const inPrompt = text.replace('\n❯ \n', '\n❯ New question\n  ' + blocks[1]!.replaceAll('\n', '\n  ') + '\n');
    assert.equal(matchClaudeText(inPrompt, [session], '', true).regions.length, 1, 'multi-line user input cannot donate formulas');
    const ruleBody = '  Step 1 formula definition.\n\n  ' + blocks[0] + '\n  ────────────────────\n  Additional answer prose.';
    assert.equal(matchClaudeText(historyView(ruleBody), [session], '', true).regions.length, 1, 'an indented Markdown horizontal rule cannot end the answer');
    const dividedSource = 'The first mathematical relation.\n\n```\nx_t^2+y_t^2=r^2\n```\n\n---\n\nThe next mathematical relation.\n\n```\na_t^2+b_t^2=c^2\n```\n\nComplete mathematical derivation.';
    const divided = historyView('  The first mathematical relation.\n\n  x_t^2+y_t^2=r^2\n\n  ────────────────────\n\n  The next mathematical relation.\n\n  a_t^2+b_t^2=c^2\n\n  Complete mathematical derivation.');
    assert.equal(matchClaudeText(divided, [{ ...session, assistant: [dividedSource] }], '', true).regions.length, 2, 'formulas below an indented separator stay in the answer');
});
test('Claude history frame excludes prompts, controls, tools, altered and ambiguous formulas', () => {
    const body = '  Mathematical answer for regression.\n\n  Step 1 formula definition.\n\n  ' + blocks[0];
    const view = historyView(body);
    assert.equal(matchClaudeText(view, [session], '', true).regions.length, 1);
    assert.equal(matchClaudeText(view, [session], '', false).regions.length, 0);
    assert.equal(matchClaudeText(view, [session, { ...session, file: 'duplicate.jsonl' }], '', true).state, 'ambiguous');
    assert.equal(matchClaudeText(historyView('  ' + blocks[0]!.replace('τ_N', 'τ_Z')), [session], '', true).regions.length, 0);
    assert.equal(matchClaudeText(historyView('  ● Bash(echo math)\n  ' + blocks[0]), [session], '', true).regions.length, 0);
    assert.equal(matchClaudeText(historyView('  ● Bash(echo math)\n  ⎿ ' + blocks[0]), [session], '', true).regions.length, 0);
    assert.equal(matchClaudeText(historyView('  Not a mathematical answer.', blocks[0]), [session], '', true).regions.length, 0);
    const atBottom = view.replace('Jump to bottom (ctrl+End) ↓', '');
    assert.equal(matchClaudeText(atBottom, [session], '', true).regions.length, 1, 'reaching the bottom does not require the disappearing jump hint');
    assert.equal(matchClaudeText(atBottom.replace('shift+tab to cycle', 'unrecognised footer'), [session], '', true).regions.length, 0);
    assert.equal(matchClaudeText(view.replace('❯ Explain the mathematical derivation.\n', ''), [session], '', true).regions.length, 1, 'history without a pinned header still has its navigation frame');
    assert.equal(matchClaudeText(view.replaceAll('─'.repeat(80), ''), [session], '', true).regions.length, 0);
    assert.equal(matchClaudeText('❯ A user prompt.\n' + body, [session], '', true).regions.length, 0);
    const wrapped = historyView('  Step 1 formula definition.\n\n  ' + blocks[0]!.slice(0, 55) + '\n' + blocks[0]!.slice(55));
    assert.equal(matchClaudeText(wrapped, [session], '', true).regions.length, 1, 'physical soft wraps do not end a repainted answer');
});
test('Claude edge summations use compact limits instead of disappearing when a padding row scrolls out', () => {
    const raw = blocks[4]!, source = `A verified discounted return.\n\n\`\`\`\n${raw}\n\`\`\`\n\nEnd of derivation.`;
    const renderer = new NativeAnalyzer(), original = { ...session, assistant: [source] };
    for (const body of ['  ' + raw + '\n  \n  End of derivation.', '  A verified discounted return.\n  \n  ' + raw, '  \n  ' + raw + '\n  ']) {
        const text = historyView(body), match = matchClaudeText(text, [original], '', true);
        assert.equal(match.regions.length, 1);
        assert.equal(match.regions[0]!.tex, findClaudeFormulas(source)[0]!.tex, 'compact layout never rewrites the expression');
        const request = { type: 'analyze' as const, id: 1, text, rowHeight: 28, width: 1600, foreground: '#cccccc', background: '#0c0c0c', inlineMath: true };
        let image = renderer.analyze(request, [], match);
        for (let i = 0; i < 20 && image.pendingRender; i++) image = renderer.analyze(request, [], match);
        assert.equal(image.formulas.length, 1, 'all complete edge expressions reach actual PNG generation');
        assert.ok(image.formulas[0]!.height <= (match.regions[0]!.endRow - match.regions[0]!.startRow + 1) * 28);
    }
});
test('colour-independent source proof rejects input, changed math and ambiguous sessions', () => {
    assert.equal(isClaudeScreen('• New Codex answer.', '● Earlier Claude answer.\n'), false);
    assert.equal(isClaudeScreen('● New Claude answer.', '• Earlier Codex answer.\n'), true);
    assert.equal(matchClaudeText(shown.replace(/^● /, '❯ '), [session], '', true).regions.length, 0);
    assert.equal(matchClaudeText(shown, [session, { ...session, file: 'other.jsonl', id: 'other' }], '', true).state, 'ambiguous');
    const altered = shown.replace('R_t^(i) = Σ_{k=t}^{T}', 'R_t^(i) = Σ_{k=t}^{9}');
    assert.equal(matchClaudeText(altered, [session], '', true).regions.length, 9);
    const markedSource = 'Formula with explicit math code.\n\n```latex\nx^2+y^2=r^2\n```\n\nVerified ending.';
    const marked = '● Formula with explicit math code.\n\n  x^2+y^2=r^2\n\n  Verified ending.\n❯ ';
    assert.equal(matchClaudeText(marked, [{ ...session, assistant: [markedSource] }], '', false).regions.length, 1);
    const explicitSource = 'A marked equation.\n\\[\nx_t^2+y_t^2=r^2\n\\]\nEnd of equation.';
    for (const delimiter of [['\\[', '\\]'], ['[', ']']]) {
        const visible = `● A marked equation.\n  ${delimiter[0]}\n  x_t^2+y_t^2=r^2\n  ${delimiter[1]}\n  End of equation.`;
        assert.equal(matchClaudeText(visible, [{ ...session, assistant: [explicitSource] }], '', false).regions.length, 1);
        assert.ok(claudeSourceKeys(explicitSource).some(key => claudeVisibleKeys(visible, '').includes(key)));
    }
});
test('Claude history incrementally indexes originals, refreshes partial records and rejects deletion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentmath-claude-'));
    const dir = path.join(root, 'projects', 'D--fixture');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, '00000000-0000-4000-8000-000000000001.jsonl');
    const index = new HistoryIndex(root, path.join(root, 'cache'), true, claudeHistoryAdapter);
    try {
        const data = JSON.stringify(record(source));
        await writeFile(file, data.slice(0, 100));
        await index.scan();
        assert.equal((await index.resolve(shown)).match.state, 'waiting');
        await appendFile(file, data.slice(100) + '\n');
        await index.scan();
        const first = await index.resolve(shown);
        assert.equal(first.match.regions.length, 10);
        assert.ok(first.metrics.sourceReadBytes > 0);
        const second = await index.resolve(shown);
        assert.equal(second.metrics.sourceReadBytes, 0);
        assert.ok(second.metrics.sourceHits > 0);
        const historical = await index.resolve(historyView(shown.split('\n').slice(1, -3).join('\n')));
        assert.equal(historical.match.regions.length, 10, 'indexed lookup resolves a repainted viewport with no assistant marker');
        assert.equal(historical.metrics.sourceReadBytes, 0, 'historical repaint uses the bounded source cache');
        const bottom = historyView(shown.split('\n').slice(1, -3).join('\n')).replace(/^❯[^\n]*\n/u, '').replace('Jump to bottom (ctrl+End) ↓', '✻ Churned for 35s · done 17:54');
        const bottomProof = await index.resolve(bottom, '• Unrelated previous Codex answer.\n');
        assert.equal(bottomProof.match.regions.length, 10, 'same disk index resolves the unpinned bottom with no assistant context');
        assert.equal(bottomProof.metrics.sourceReadBytes, 0, 'scrolling to bottom never rescans source records');
        const analyzer = new NativeAnalyzer();
        const request = { type: 'analyze' as const, id: 1, text: shown, rowHeight: 28, width: 1800, foreground: '#b1b9f9', background: '#0c0c0c', inlineMath: true };
        let rendered = analyzer.analyze(request, [], first.match);
        for (let i = 0; i < 20 && rendered.pendingRender; i++)
            rendered = analyzer.analyze(request, [], first.match);
        assert.equal(rendered.formulas.length, 10, 'all ten independently verified expressions fit the native renderer');
        await rm(file);
        await index.scan();
        assert.equal((await index.resolve(shown)).match.state, 'waiting');
    }
    finally {
        await index.close();
        await rm(root, { recursive: true, force: true });
    }
});
test('Claude full-expression index avoids common-prefix history scans and persists across restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentmath-claude-prefix-'));
    const dir = path.join(root, 'projects', 'D--fixture');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, '00000000-0000-4000-8000-000000000002.jsonl');
    const answers = Array.from({ length: 180 }, (_, n) => `Equation number ${n}.\n\n\`\`\`\nx_t^2+y_t^2=${n}\n\`\`\`\n\nEnd of equation ${n}.`);
    await writeFile(file, answers.map(x => JSON.stringify(record(x))).join('\n') + '\n');
    let index = new HistoryIndex(root, path.join(root, 'cache'), true, claudeHistoryAdapter);
    const visible = '● ' + answers[0]!.replace(/^```[^\n]*\n/gm, '').split('\n').join('\n  ');
    try {
        await index.scan();
        const initial = await index.resolve(visible);
        assert.equal(initial.match.regions.length, 1);
        assert.equal(initial.metrics.sourceMisses, 1, '179 identical formula prefixes do not broaden original-record reads');
        const samples: number[] = [];
        for (let i = 0; i < 60; i++) {
            const r = await index.resolve(visible);
            assert.equal(r.metrics.sourceReadBytes, 0);
            samples.push(r.metrics.lookupMs);
        }
        samples.sort((a, b) => a - b);
        assert.ok(samples[56]! < 50, 'warm lookup P95 stays within 50ms');
        await index.close();
        index = new HistoryIndex(root, path.join(root, 'cache'), true, claudeHistoryAdapter);
        await index.scan();
        assert.equal((await index.resolve(visible)).match.regions.length, 1);
        assert.equal(index.metrics.indexReadBytes, 0);
    }
    finally {
        await index.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('Claude notation upgrade rebuilds unchanged historical formulas and retains exact source lookup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentmath-claude-upgrade-'));
    const dir = path.join(root, 'projects', 'D--fixture');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, '00000000-0000-4000-8000-000000000003.jsonl');
    const raw = 'L_GSPO(θ) = sg[x_{i,<t}]';
    const text = `An autoregressive mathematical relation.\n\n\`\`\`\n${raw}\n\`\`\`\n\nEnd of relation.`;
    const oldAdapter = { ...claudeHistoryAdapter, version: 'claude-v4', sourceKeys: () => [] };
    let index = new HistoryIndex(root, path.join(root, 'cache'), true, oldAdapter);
    try {
        await writeFile(file, JSON.stringify(record(text)) + '\n');
        await index.scan();
        const oldFile = index.databaseFile;
        await index.close();
        index = new HistoryIndex(root, path.join(root, 'cache'), true, claudeHistoryAdapter);
        assert.notEqual(index.databaseFile, oldFile);
        await index.scan();
        const visible = historyView('  An autoregressive mathematical relation.\n\n  ' + raw);
        const found = await index.resolve(visible);
        assert.equal(found.match.regions.length, 1, 'unchanged answer omitted by old grammar is indexed on upgrade');
        assert.equal(found.metrics.sourceMisses, 1);
        const warm = await index.resolve(visible);
        assert.equal(warm.metrics.sourceReadBytes, 0);
        assert.equal(await import('node:fs/promises').then(x => x.readFile(file, 'utf8')), JSON.stringify(record(text)) + '\n');
    }
    finally { await index.close(); await rm(root, { recursive: true, force: true }); }
});
