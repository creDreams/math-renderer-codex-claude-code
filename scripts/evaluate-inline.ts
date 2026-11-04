/** Deterministic generated coverage and performance corpus, not a claim about
 * all natural model output. No personal conversation content is recorded. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { findInlineMath } from '../packages/core/src/implicit-math.js';

const negatives = (i: number) => [
  `timeout=${i}`, `max_steps: ${i}`, `learning_rate=0.00${i}`, `L_total=${i}`, `版本 v1.${i}.3`,
  `2026-11-${i % 28 + 1}`, `arXiv:2510.${String(i).padStart(5, '0')}v1`, `$20,${i} and $30,${i}`,
  `$2.50 for the first item and $2.00 each (${i})`, `https://example.com/${i}/x²+y²=r²`,
  `D:\\data${i}\\x²+y²=r².txt`, `src${i}/main.py`, `person${i}@example.com`, `β版功能 ${i}`,
  `const answer${i} = x² + y² = r²;`, `return x² + y² = r²; // ${i}`, `if (x² + y² = r²) result${i}();`,
  `for (x² + y² = r²) loop${i}();`, `console.log("x² + y² = r²", ${i});`, `print("x² + y² = r²", ${i})`,
  `python -c 'x² + y² = r²' # ${i}`, `node -e "x² + y² = r²" // ${i}`, `echo "x² + y² = r²" # ${i}`,
  `git config --local formula "x² + y² = r²" # ${i}`, `DEBUG x² + y² = r² request=${i}`,
  `INFO: x² + y² = r² request=${i}`, `at f${i}(x² + y² = r²)`, `{"timeout":${i},"formula":"x² + y² = r²"}`,
  `formula: "x² + y² = r²" # ${i}`, `formula = "x² + y² = r²" # ${i}`, `x² + y² == r² // ${i}`,
  `x² + y² != r² // ${i}`, `PS D:\\repo${i}> x² + y² = r²`, `\`x² + y² = r²\` sample ${i}`,
  '```text\nx² + y² = r²\n```\nSample ' + i, `    x² + y² = r² # ${i}`, `x^12 + y^2 = r^2 // ${i}`,
  `\\unknown{x²+y²=r²} sample ${i}`, `x_ij + y² = r² // ${i}`, `x² + unknown${i} + y² = r²`,
];
let truePositive = 0, falsePositive = 0, falseNegative = 0, positiveCases = 0, negativeCases = 0;
const failures: { kind: string; text: string; actual: string[] }[] = [];
for (let i = 1; i <= 250; i++) {
  const formulas = [`f(x) = x^{${i}} + ${i}`, `θ_{t+1} = θ_t − ${i}∇J(θ_t)`, `x² + ${i}y² = r²`,
    `Âₜ = Qₜ − ${i}Vₜ`, `L(θ) = αL₁(θ) + ${i}βL₂(θ)`];
  for (const raw of formulas) {
    const text = `案例 ${i}：数学公式 ${raw}，后文继续说明。`, actual = findInlineMath(text).map(x => x.raw);
    positiveCases++;
    if (actual.length === 1 && actual[0] === raw) truePositive++;
    else { falseNegative++; falsePositive += actual.length; if (failures.length < 20) failures.push({ kind: 'positive', text, actual }); }
  }
  for (const text of negatives(i)) {
    negativeCases++; const actual = findInlineMath(text).map(x => x.raw);
    if (actual.length) { falsePositive += actual.length; if (failures.length < 20) failures.push({ kind: 'negative', text, actual }); }
  }
}
const timings: number[] = [], hotTimings: number[] = [];
const prose = 'Plain explanatory text preserves ordinary terminal content and avoids accidental mathematical interpretation. ';
for (let i = 0; i < 80; i++) {
  const viewport = (prose.repeat(5) + '\n').repeat(120).slice(0, 64000) + `\n公式 x² + ${i}y² = r²，结束。`;
  let start = performance.now(); findInlineMath(viewport); timings.push(performance.now() - start);
  start = performance.now(); findInlineMath(viewport); hotTimings.push(performance.now() - start);
}
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)]!;
const report = { generatedCorpus: true, positiveCases, negativeCases, truePositive, falsePositive, falseNegative,
  precision: truePositive / (truePositive + falsePositive), recall: truePositive / positiveCases,
  boundaryExact: truePositive === positiveCases, fresh64KiBDetectionP95Ms: p95(timings), cached64KiBDetectionP95Ms: p95(hotTimings),
  failures, runAt: new Date().toISOString() };
await mkdir('test-results', { recursive: true }); await writeFile('test-results/inline-corpus.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
assert.equal(falsePositive, 0); assert.equal(falseNegative, 0);
assert.ok(report.cached64KiBDetectionP95Ms <= 5, 'warm viewport recognition budget');
