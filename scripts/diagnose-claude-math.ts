import { readFile } from 'node:fs/promises';
import { inspectClaudeMath } from '../packages/adapter-claude/src/math.js';
import { MathRenderer } from '../packages/core/src/renderer.js';

// Explicit local Markdown/text input only. Never scans personal conversations.
const at = process.argv.indexOf('--source-file');
if (at < 0 || !process.argv[at + 1]) throw Error('Usage: npm run diagnose:claude -- --source-file <answer.md>');
const source = await readFile(process.argv[at + 1]!, 'utf8');
const report = inspectClaudeMath(source), renderer = new MathRenderer();
const candidates = report.candidates.map(candidate => {
    let state: string = candidate.reason ?? 'prepared';
    if (candidate.tex) {
        try { renderer.render(candidate.tex); state = 'renderable'; }
        catch { state = 'render-failed'; }
    }
    return { start: candidate.start, end: candidate.end, marked: candidate.marked, state,
        ...(process.argv.includes('--include-source') ? { raw: candidate.raw } : {}) };
});
console.log(JSON.stringify({ candidates: candidates.length, renderable: candidates.filter(c => c.state === 'renderable').length,
    regions: candidates, rejectedBlocks: report.rejectedBlocks }, null, 2));
