import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainMarkdown } from '../packages/adapter-codex/src/markdown-presentation.js';
import { findDisplayMath } from '../packages/core/src/display-math.js';
import { matchVisibleText, NativeAnalyzer } from '../packages/windows-companion/src/analyzer.js';

const labels = (text: string) => plainMarkdown(text, { linkLabels: true });
const physical = (text: string, margin = '  ') => margin + text.replaceAll('\n', '\r\n  ');
const heading = '这段独立推导说明策略更新及四个目标之间的关系，完整公式应在来源链接出现和离开时持续显示。';
const blocks = Array.from({ length: 4 }, (_, i) => '\\[\n\\mathbb E_{q_' + i + '}[Q]-\\eta\\mathrm{KL}(q_' + i + '\\|p).\n\\]');
const link = '[策略优化论文，第 4 节](https://example.org/paper#S4)';
const source = heading + '\n\n' + blocks.map((block, i) => `步骤 ${i}：\n\n${block}`).join('\n\n') +
  '\n\n来源：' + link + '。';
const displayed = source.replace(link, '策略优化论文，第 4 节');
const session = { id: 'hyperlinks', cwd: 'D:/fixture', file: 'fixture', assistant: [source] };

test('Markdown link labels retain styles, inline math and code while code/math examples stay literal', () => {
  const text = '# Heading\n[**Paper \\(q_s\\)** and `code`](https://example.org/a_(b) "Title")\n' +
    '<https://example.org/path> and <reader@example.org>\n' +
    '[Reference *label*][paper]\n\n[paper]: https://example.org/reference\n\n' +
    'Unresolved [label][missing] and ![image](picture.png).\n\n' +
    '`[code](https://example.org/code)`\n\n```text\n[code](https://example.org/fence)\n```\n\n' +
    '\\[\n\\text{[math](https://example.org/math)}\n\\]';
  const expected = 'Heading\nPaper \\(q_s\\) and `code`\n' +
    'https://example.org/path and reader@example.org\n' +
    'Reference label\n\n\n\n' +
    'Unresolved [label][missing] and ![image](picture.png).\n\n' +
    '`[code](https://example.org/code)`\n\n```text\n[code](https://example.org/fence)\n```\n\n' +
    '\\[\n\\text{[math](https://example.org/math)}\n\\]';
  assert.equal(labels(text), expected);
  assert.equal(labels(text), expected, 'cached derivation is identical');
  assert.ok(plainMarkdown(text).includes('[Paper \\(q_s\\) and `code`](https://example.org/a_(b) "Title")'),
    'the existing literal-link presentation remains available');
});

test('a visible source hyperlink never requires all four neighboring formulas to share the viewport', () => {
  const lines = displayed.split('\n'), complete = findDisplayMath(displayed);
  let checked = 0, linkVisible = 0;
  for (const height of [3, 4, 5, 6, 8, 10, 12, 18, 28, 44]) for (let top = 0; top < lines.length; top++) {
    const text = lines.slice(top, top + height).join('\n');
    const offset = lines.slice(0, top).reduce((size, line) => size + line.length + 1, 0);
    const expected = complete.filter(block => block.start >= offset && block.end <= offset + text.length);
    const leading = top ? physical(lines.slice(0, top).join('\n'), '• ') + '\r\n' : '';
    const result = matchVisibleText(physical(text, top ? '  ' : '• '), [session], leading);
    assert.deepEqual(result.regions.map(block => block.tex), expected.map(block => block.tex), `top=${top}, height=${height}`);
    for (const [index, block] of expected.entries()) {
      const startRow = displayed.slice(0, block.start).split('\n').length - 1 - top;
      assert.equal(result.regions[index]!.startRow, startRow);
      assert.equal(result.regions[index]!.endRow, startRow + 2);
    }
    checked++;
    if (expected.length && text.includes('来源：')) linkVisible++;
  }
  assert.ok(checked > 200 && linkVisible > 20);
});

test('hyperlink text at the default bottom renders PNG and preserves source, role and ambiguity checks', () => {
  const tui = (text: string) => physical(text, '• ') + '\r\n  Worked for 29s • 15:56\r\n› Ask Codex\r\nstatus';
  const input = { type: 'analyze' as const, id: 1, text: tui(displayed), rowHeight: 28, width: 2400,
    foreground: '#cccccc', background: '#0c0c0c' };
  const analyzer = new NativeAnalyzer();
  assert.equal(analyzer.analyze(input, [session]).formulas.length, 4);
  assert.equal(analyzer.analyze({ ...input, text: tui(source) }, [session]).formulas.length, 4);
  for (const text of [displayed.replace('策略优化论文', '其他论文'), displayed.replace('步骤 2', '步骤 9'),
    displayed.replace('q_1', 'q_8')])
    assert.equal(analyzer.analyze({ ...input, text: tui(text) }, [session]).formulas.length, 0);
  for (const role of ['› ', '• Ran a command\r\n  '])
    assert.equal(analyzer.analyze({ ...input, text: input.text.replace('• ', role) }, [session]).formulas.length, 0);
  const copy = { ...session, id: 'other-url', assistant: [source.replace('https://example.org/paper#S4', 'https://example.net/other')] };
  assert.equal(analyzer.analyze(input, [session, copy]).state, 'ambiguous', 'a hidden URL cannot distinguish two identical visible answers');
});

test('hyperlink presentation keeps duplicate TeX in hidden-fence code protected', () => {
  const code = '```text\n' + blocks[0] + '\n[code](https://example.org/code)\n```';
  const raw = source.replace('\n\n来源：', '\n\n代码示例：\n\n' + code + '\n\n来源：');
  const shown = displayed.replace('\n\n来源：', '\n\n代码示例：\n\n' + code.slice('```text\n'.length, -'\n```'.length) + '\n\n来源：');
  const terminal = physical(shown, '• ') + '\r\n  Worked for 1s\r\n› input';
  const result = matchVisibleText(terminal, [{ ...session, assistant: [raw] }]);
  assert.deepEqual(result.regions.map(block => block.tex), findDisplayMath(source).map(block => block.tex));
  assert.equal(matchVisibleText(terminal.replace('[code](https://example.org/code)', 'code'), [{ ...session, assistant: [raw] }]).regions.length, 0);
});
