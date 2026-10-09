const { renderMarkdown, highlight } = require('../extension/markdown.js');

const fence = '```';
const md = [
  '# Title',
  '',
  'Some **bold** and _italic_ with `inline` and a [link](https://example.com).',
  '',
  '- item one',
  '- item two',
  '',
  '> quoted line',
  '',
  fence + 'js',
  '// comment',
  'function hello(name) {',
  '  const x = 42; // trailing',
  '  return name;',
  '}',
  fence,
  '',
  'Raw html should escape: <script>alert(1)</script>',
  '',
  '1. first',
  '2. second',
  '',
  'Auto link: https://example.com/path.',
].join('\n');

const html = renderMarkdown(md);
console.log(html);
console.log('---CHECKS---');
const checks = {
  'code-block': html.includes('code-block'),
  'tok-k span': html.includes('tok-k'),
  'script escaped': !html.includes('<script>') && html.includes('&lt;script&gt;'),
  strong: html.includes('<strong>bold</strong>'),
  em: html.includes('<em>italic</em>'),
  inlineCode: html.includes('<code>inline</code>'),
  ul: html.includes('<ul><li>item one</li><li>item two</li></ul>'),
  blockquote: html.includes('<blockquote>quoted line</blockquote>'),
  link: html.includes('href="https://example.com"'),
  h1: html.includes('<h1>Title</h1>'),
  ol: html.includes('<ol><li>first</li><li>second</li></ol>'),
  autolink: html.includes('<a href="https://example.com/path"'),
  comment: html.includes('tok-c'),
  number: html.includes('tok-n'),
  unterminatedFence: renderMarkdown('hello\n```js\nconst a = 1;').includes('code-block'),
  empty: renderMarkdown('') === '',
};

let failed = 0;
for (const [name, ok] of Object.entries(checks)) {
  if (!ok) { failed += 1; console.log('FAIL:', name); }
}
console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED');
console.log('---HIGHLIGHT SAMPLE---');
console.log(highlight('def add(a, b):\n    # sum\n    return a + b  # trailing', 'py'));
