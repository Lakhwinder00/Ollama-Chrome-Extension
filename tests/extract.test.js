/**
 * Tests for the attachment readers (extension/extract.js): text, PDF, Word,
 * Excel and images — all without any dependency.
 * Run with: node --test tests/extract.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  readAttachment,
  extractPdfText,
  extractOfficeText,
  extOf,
  isImage,
} = require('../extension/extract.js');

const bytesOf = (text) => new Uint8Array(Buffer.from(text, 'latin1'));
const utf8Of = (text) => new Uint8Array(Buffer.from(text, 'utf8'));

// --- helpers: a tiny ZIP writer (stored entries) ----------------------------

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(file.data, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 14); // crc (not checked by the reader)
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); // stored
    central.writeUInt32LE(0, 16); // crc
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([Buffer.concat(locals), centralBuf, eocd]));
}

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

// --- file kinds ------------------------------------------------------------

test('extensions and file kinds are detected', () => {
  assert.equal(extOf('report.PDF'), 'pdf');
  assert.equal(extOf('/tmp/a/b/notes.md'), 'md');
  assert.equal(isImage('photo.png'), true);
  assert.equal(isImage('notes.md'), false);
});

// --- plain text ------------------------------------------------------------

test('a text file is read as text', async () => {
  const r = await readAttachment('notes.md', utf8Of('# Title\n\nSome content.'));
  assert.equal(r.kind, 'text');
  assert.match(r.text, /# Title/);
  assert.match(r.text, /Some content/);
});

test('a binary file is reported instead of sent as garbage', async () => {
  const r = await readAttachment('blob.bin', new Uint8Array([1, 2, 0, 3, 4]));
  assert.equal(r.kind, 'unsupported');
  assert.match(r.note, /binary/i);
});

test('an unknown extension is reported', async () => {
  const r = await readAttachment('thing.xyz', utf8Of('hello'));
  assert.equal(r.kind, 'unsupported');
  assert.match(r.note, /\.xyz/);
});

// --- images ----------------------------------------------------------------

test('an image is kept as an image', async () => {
  const r = await readAttachment('shot.png', PNG_BYTES);
  assert.equal(r.kind, 'image');
  assert.equal(r.mime, 'image/png');
  assert.match(r.dataUrl, /^data:image\/png;base64,/);
});

// --- PDF -------------------------------------------------------------------

const SAMPLE_PDF = [
  '%PDF-1.4',
  '1 0 obj',
  '<< /Type /Catalog /Pages 2 0 R >>',
  'endobj',
  '3 0 obj',
  '<< /Type /Page /Contents 4 0 R >>',
  'endobj',
  '4 0 obj',
  '<< /Length 72 >>',
  'stream',
  'BT /F1 12 Tf 72 720 Td (Invoice total) Tj 0 -20 Td (42 EUR) Tj ET',
  'endstream',
  'endobj',
  'trailer',
  '<< /Root 1 0 R >>',
  '%%EOF',
].join('\n');

test('a PDF is turned into readable text', async () => {
  const text = await extractPdfText(bytesOf(SAMPLE_PDF));
  assert.match(text, /Invoice total/);
  assert.match(text, /42 EUR/);
});

test('an attached PDF comes back as text', async () => {
  const r = await readAttachment('invoice.pdf', bytesOf(SAMPLE_PDF));
  assert.equal(r.kind, 'text');
  assert.match(r.text, /Invoice total/);
});

// --- Word / Excel / PowerPoint ---------------------------------------------

test('a .docx is turned into readable text', async () => {
  const doc = zip([
    {
      name: 'word/document.xml',
      data:
        '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
        '<w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Revenue went up</w:t></w:r><w:r><w:t> by 12%</w:t></w:r></w:p>' +
        '</w:body></w:document>',
    },
  ]);
  const r = await readAttachment('report.docx', doc);
  assert.equal(r.kind, 'text');
  assert.match(r.text, /Quarterly report/);
  assert.match(r.text, /Revenue went up by 12%/);
});

test('a .xlsx is turned into readable rows', async () => {
  const book = zip([
    {
      name: 'xl/sharedStrings.xml',
      data:
        '<?xml version="1.0"?><sst><si><t>Product</t></si><si><t>Price</t></si>' +
        '<si><t>Widget</t></si><si><t>9.99</t></si></sst>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data:
        '<?xml version="1.0"?><worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>9.99</v></c></row>' +
        '</sheetData></worksheet>',
    },
  ]);
  const r = await readAttachment('prices.xlsx', book);
  assert.equal(r.kind, 'text');
  assert.match(r.text, /Product \| Price/);
  assert.match(r.text, /Widget \| 9\.99/);
});

test('a .pptx is turned into readable text', async () => {
  const deck = zip([
    {
      name: 'ppt/slides/slide1.xml',
      data:
        '<?xml version="1.0"?><p:sld xmlns:a="x"><a:t>Roadmap</a:t><a:t>Q3 launch</a:t></p:sld>',
    },
  ]);
  const r = await readAttachment('deck.pptx', deck);
  assert.equal(r.kind, 'text');
  assert.match(r.text, /Roadmap/);
  assert.match(r.text, /Q3 launch/);
});

test('an office file without content is reported, not crashed', async () => {
  const r = await readAttachment('empty.docx', zip([{ name: 'other.txt', data: 'x' }]));
  assert.equal(r.kind, 'text');
  assert.equal(r.text, '');
});
