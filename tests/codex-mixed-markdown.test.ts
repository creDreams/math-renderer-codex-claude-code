import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {markdownPresentations} from '../packages/adapter-codex/src/markdown-presentation.js';
import {matchCodexText} from '../packages/adapter-codex/src/matcher.js';
import {NativeAnalyzer} from '../packages/windows-companion/src/analyzer.js';
import {HistoryIndex} from '../packages/adapter-codex/src/history-index.js';

// Synthetic prose/paths; the reported equations exercise both nested SVG
// stretch glyphs and answer proof, not a formula-specific recognition rule.
const ratio = String.raw`\underbrace{\frac{\pi_\theta(o_i\mid q)}
                 {\pi_{\theta_{\mathrm{old}}}(o_i\mid q)}}_{\text{整条回答的比率}}
=
\prod_{t=1}^{|o_i|}
\underbrace{\frac{\pi_\theta(o_{i,t}\mid q,o_{i,<t})}
                 {\pi_{\theta_{\mathrm{old}}}(o_{i,t}\mid q,o_{i,<t})}}_{\text{第 }t\text{ 个 token 的比率}}.`;
const expectation = String.raw`\mathbb E_{y\sim q}[e^{-\ell(y)}-1]
=\sum_y q(y)\left(\frac{p(y)}{q(y)}-1\right)
=\sum_y[p(y)-q(y)]=0.`;
const gradient = String.raw`\nabla_\theta(\rho k_3)=\rho\,\ell\,\nabla_\theta\log q(y).`;
const block = (tex: string) => '\\[\n' + tex + '\n\\]';
const firstSource = '**比较整段回答与逐 token 更新的目标，保持每个比率的实际含义。** ' +
  '[Online paper](https://example.org/policy)\n\n' + block(ratio) + '\n\n' +
  '- **第一种更新**使用整个回答的比率。\n- **第二种更新**使用每个 token 的比率。\n\n' +
  '[Local reference](D:/research/notes/policy.pdf)';
const secondSource = '**固定同一个前缀比较分布，以下等式必须保持完整。**\n\n' +
  '### 为什么加入零均值项？\n\n' + block(expectation) + '\n\n' +
  '### 为什么乘重要性权重？\n\n' + block(gradient) + '\n\n' +
  '[Local reference](D:/research/notes/policy.pdf)';
// Independent expectations, rather than using the production presentation to
// construct the very screen that will be tested against it.
const firstShown = '比较整段回答与逐 token 更新的目标，保持每个比率的实际含义。 Online paper\n\n' +
  block(ratio) + '\n\n• 第一种更新使用整个回答的比率。\n• 第二种更新使用每个 token 的比率。\n\n' +
  'Local reference (notes/policy.pdf)';
const secondShown = '固定同一个前缀比较分布，以下等式必须保持完整。\n\n' +
  '### 为什么加入零均值项？\n\n' + block(expectation) + '\n\n' +
  '### 为什么乘重要性权重？\n\n∇_{θ}(ρ k₃)=ρ ℓ ∇_{θ}log q(y).\n\n' +
  'Local reference (notes/policy.pdf)';
const session = {id:'mixed-markdown',file:'synthetic',cwd:'D:/research',assistant:[firstSource,secondSource]};
const physical = (text: string, margin = '• ') => margin + text.replaceAll('\n','\r\n  ');
const page = (first = firstShown, second = secondShown) => physical(first) +
  '\r\n  Worked for 1m 9s • Nov 20 at 15:53\r\n\r\n› Compare the next objective\r\n\r\n' + physical(second) +
  '\r\n  Worked for 40s • 11:05\r\n\r\n› Input';
const request = {type:'analyze' as const,id:1,width:2400,rowHeight:28,foreground:'#cccccc',background:'#0c0c0c'};
function render(text: string, inlineMath: boolean, analyzer = new NativeAnalyzer()) {
  let result = analyzer.analyze({...request,text,inlineMath},[session]);
  for(let n=0;result.pendingRender && n<12;n++) result = analyzer.analyze({...request,text,inlineMath},[session]);
  return result;
}

test('Codex mixed heading/link presentations preserve exact source-derived destinations and protected content', () => {
  const source = '# **Heading**\n[**Local**](d:/RESEARCH/notes/policy.pdf) [Web](https://example.org/a)\n' +
    '[Other](D:/research-other/policy.pdf) [Relative](../notes/policy.pdf) [File](file:///D:/research/notes/paper.pdf)\n' +
    '[Reference][local]\n\n[local]: D:/research/notes/reference.pdf\n\n' +
    '`[code](D:/research/notes/code.pdf)`\n\n```text\n### **literal**\n[code](D:/research/notes/code.pdf)\n```\n\n' + block(ratio);
  const expected = '# Heading\nLocal (notes/policy.pdf) Web\nOther (D:/research-other/policy.pdf) Relative (../notes/policy.pdf) File (notes/paper.pdf)\n' +
    'Reference (notes/reference.pdf)\n\n\n\n' +
    '`[code](D:/research/notes/code.pdf)`\n\n```text\n### **literal**\n[code](D:/research/notes/code.pdf)\n```\n\n' + block(ratio);
  const forms = markdownPresentations(source,session.cwd);
  assert.ok(forms.includes(expected));
  assert.strictEqual(markdownPresentations(source,session.cwd),forms,'bounded cache retains derived presentations');
  assert.ok(!markdownPresentations(source,'D:/another').includes(expected),'cwd cannot reuse another answer path transformation');
  for(const form of forms) {
    assert.ok(form.includes(block(ratio)),'TeX is never reformatted as Markdown');
    assert.ok(form.includes('### **literal**\n[code](D:/research/notes/code.pdf)'),'fenced code stays literal');
    assert.ok(form.includes('`[code](D:/research/notes/code.pdf)`'));
  }
});

test('both reported display formulas reach PNG with preview off; native gradient and cached status updates stay independent', () => {
  for(const inlineMath of [false,true]) {
    const analyzer = new NativeAnalyzer(), first = render(page(),inlineMath,analyzer);
    assert.equal(first.state,'matched'); assert.equal(first.skipped,0);
    assert.equal(first.formulas.length,inlineMath ? 3 : 2);
    for(const formula of first.formulas) {
      const png = Buffer.from(formula.png,'base64');
      assert.equal(png.readUInt32BE(16),formula.width); assert.equal(png.readUInt32BE(20),formula.height);
      assert.ok(formula.width>100 && formula.height>20);
    }
    for(let n=0;n<12;n++) {
      const next=render(page()+'\r\n'+(n%2?'◦':'•')+` Working (${n}s • esc to interrupt)`,inlineMath,analyzer);
      assert.deepEqual(next.formulas,first.formulas); assert.equal(next.metrics.imageMisses,0);
    }
  }
});

test('mixed headings and local paths retain every complete formula across independent clipped viewports', () => {
  let checked=0;
  for(const [raw,shown,texes] of [[firstSource,firstShown,[ratio]],[secondSource,secondShown,[expectation]]] as const) {
    const lines=shown.split('\n'), originals=[{...session,assistant:[raw]}];
    const expected=texes.map(tex=>({tex,start:lines.indexOf(tex.split('\n')[0]!)-1,end:lines.indexOf(tex.split('\n')[0]!)+tex.split('\n').length}));
    for(const height of [3,5,8,12,22,40]) for(let top=0;top<lines.length;top++) {
      const visible=lines.slice(top,top+height),leading=top?physical(lines.slice(0,top).join('\n'))+'\r\n':'';
      const match=matchCodexText(physical(visible.join('\n'),top?'  ':'• '),originals,leading);
      const complete=expected.filter(b=>b.start>=top && b.end<top+visible.length);
      assert.deepEqual(match.regions.map(b=>[b.tex,b.startRow,b.endRow]),complete.map(b=>[b.tex,b.start-top,b.end-top]),`top=${top}, height=${height}`);
      checked++;
    }
  }
  assert.ok(checked>150);
});

test('mixed presentation never authorizes changed labels, paths, prose, math, roles or ambiguous sources', () => {
  for(const change of [
    (s:string)=>s.replace('notes/policy.pdf','notes/other.pdf'),
    (s:string)=>s.replace('Local reference','Other reference'),
    (s:string)=>s.replace('零均值项','完全不同项'),
    (s:string)=>s.replace('p(y)-q(y)','p(y)+q(y)'),
    (s:string)=>s.replace('以下等式必须保持完整','以下等式已被人为修改'),
  ]) {
    const result=render(page(firstShown,change(secondShown)),false);
    assert.deepEqual(result.formulas.map(f=>f.startRow),render(page(firstShown,'unverified reply'),false).formulas.map(f=>f.startRow),
      'only the unrelated intact answer may retain its own image');
  }
  const text=physical(secondShown)+'\r\n  Worked for 1s\r\n› Input';
  for(const prefix of ['› ','• Ran a command\r\n  ']) assert.equal(render(text.replace('• ',prefix),true).formulas.length,0);
  const original={...session,assistant:[secondSource]},other={...original,id:'copy'};
  assert.equal(matchCodexText(text,[original,other]).state,'ambiguous');
  assert.equal(matchCodexText(text,[{...original,cwd:'D:/another'}]).regions.length,0);
});

test('persisted history finds existing formulas with mixed presentation without changing the index schema', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'math-mixed-markdown-'));
  let index: HistoryIndex | undefined;
  try {
    const home=path.join(root,'codex'); await mkdir(path.join(home,'sessions'),{recursive:true});
    await writeFile(path.join(home,'sessions/rollout-fixture.jsonl'),[
      {type:'session_meta',payload:{id:session.id,cwd:session.cwd}},
      ...session.assistant.map(text=>({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text}]}})),
    ].map(x=>JSON.stringify(x)).join('\n')+'\n');
    index=new HistoryIndex(home,path.join(root,'cache'));
    await index.scan();
    let result=await index.resolve(page());
    assert.equal(result.match.state,'matched');assert.equal(result.match.regions.length,2);
    index.close();index=new HistoryIndex(home,path.join(root,'cache'));
    await index.scan();
    result=await index.resolve(page());
    assert.equal(result.match.regions.length,2);
    assert.equal(result.metrics.sourceMisses,2);
  } finally {index?.close();await rm(root,{recursive:true,force:true});}
});
