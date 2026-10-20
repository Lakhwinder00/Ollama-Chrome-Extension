/* Local Code Agent — attachment readers.
 *
 * The user can attach a document or an image to a message. Images stay images
 * (the model looks at them); documents are turned into plain text that is put
 * in the prompt, so the model can act on them.
 *
 * No dependencies: PDF, Word, Excel and PowerPoint files are parsed here.
 * Everything is best-effort — a file that cannot be read is reported, never
 * silently dropped.
 */

(function (global) {
  'use strict';

  // ------------------------------------------------------------ file types --

  const TEXT_EXTENSIONS = new Set([
    'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
    'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp',
    'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'log', 'ini',
    'cfg', 'conf', 'toml', 'env', 'gitignore', 'dockerfile', 'makefile',
    'gradle', 'properties', 'vue', 'svelte', 'r', 'jl', 'lua', 'pl',
  ]);

  // A NUL byte means the file is binary, not text.
  const NUL = String.fromCharCode(0);

  const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']);

  const OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods']);

  const MIME_BY_EXT = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    avif: 'image/avif',
    pdf: 'application/pdf',
  };

  function extOf(name) {
    const base = String(name || '').split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
  }

  function isImage(name) {
    return IMAGE_EXTENSIONS.has(extOf(name));
  }

  function isTextFile(name) {
    const ext = extOf(name);
    if (TEXT_EXTENSIONS.has(ext)) return true;
    // Extension-less files that look like text are read as text.
    if (!ext) return true;
    return false;
  }

  // ------------------------------------------------------------- utilities --

  function toBytes(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }

  function bytesToLatin1(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return s;
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const decoderLatin1 = new TextDecoder('latin1', { fatal: false });

  function decodeUtf8(bytes) {
    return decoder.decode(bytes);
  }

  /** Inflate with the platform's DecompressionStream (Chrome 80+, Node 18+). */
  async function inflate(bytes, format) {
    if (typeof DecompressionStream === 'undefined') return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch (e) {
      return null;
    }
  }

  function unescapeXml(text) {
    return String(text || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&amp;/g, '&');
  }

  function cleanText(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ------------------------------------------------------------------ zip --

  /**
   * Read the entries of a ZIP archive (Word/Excel/PowerPoint are ZIP files).
   * Only the "stored" and "deflate" methods are supported, which is all the
   * Office formats use.
   */
  async function readZipEntries(bytes) {
    const entries = {};
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Find the End Of Central Directory record.
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 66000; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) return entries;

    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);

    for (let i = 0; i < count && offset + 46 <= bytes.length; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) break;
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = decoderLatin1.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));

      // The local header repeats the name/extra lengths.
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = bytes.subarray(dataStart, dataStart + compressedSize);

      let data = raw;
      if (method === 8) {
        const inflated = await inflate(raw, 'deflate-raw');
        if (inflated) data = inflated;
      } else if (method !== 0) {
        offset += 46 + nameLen + extraLen + commentLen;
        continue; // unsupported compression
      }
      entries[name] = data;
      offset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  // ------------------------------------------------------------ office xml --

  function docxText(xml) {
    const out = [];
    const paragraphs = String(xml).split(/<\/w:p>/i);
    for (const p of paragraphs) {
      const texts = [];
      const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gi;
      let m;
      while ((m = re.exec(p))) texts.push(unescapeXml(m[1]));
      const line = texts.join('');
      if (line.trim()) out.push(line);
    }
    return out.join('\n');
  }

  function sharedStrings(xml) {
    const out = [];
    const items = String(xml).split(/<si(?:\s[^>]*)?>/i).slice(1);
    for (const item of items) {
      const texts = [];
      const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi;
      let m;
      while ((m = re.exec(item))) texts.push(unescapeXml(m[1]));
      out.push(texts.join(''));
    }
    return out;
  }

  function xlsxRows(xml, shared) {
    const lines = [];
    const rows = String(xml).split(/<row(?:\s[^>]*)?>/i).slice(1);
    for (const row of rows) {
      const cells = [];
      const re = /<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/gi;
      let m;
      while ((m = re.exec(row))) {
        const attrs = m[1] || m[3] || '';
        const body = m[2] || '';
        const type = /t="([^"]+)"/.exec(attrs);
        const t = type ? type[1] : 'n';
        let value = '';
        if (t === 's') {
          const v = /<v>([\s\S]*?)<\/v>/.exec(body);
          const idx = v ? Number(v[1]) : -1;
          value = idx >= 0 && shared[idx] != null ? shared[idx] : '';
        } else if (t === 'inlineStr') {
          const texts = [];
          const tre = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi;
          let tm;
          while ((tm = tre.exec(body))) texts.push(unescapeXml(tm[1]));
          value = texts.join('');
        } else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(body);
          value = v ? unescapeXml(v[1]) : '';
        }
        cells.push(value);
      }
      const line = cells.join(' | ').replace(/(\s*\|\s*)+$/, '').trim();
      if (line) lines.push(line);
    }
    return lines;
  }

  function pptxText(xml) {
    const out = [];
    const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi;
    let m;
    while ((m = re.exec(xml))) {
      const t = unescapeXml(m[1]).trim();
      if (t) out.push(t);
    }
    return out.join('\n');
  }

  async function extractOfficeText(name, bytes) {
    const entries = await readZipEntries(bytes);
    const ext = extOf(name);
    if (ext === 'docx' || ext === 'odt') {
      const doc = entries['word/document.xml'];
      if (doc) return cleanText(docxText(decodeUtf8(doc)));
      const content = entries['content.xml'];
      if (content) {
        // ODF: the text lives in <text:p> elements.
        const parts = [];
        const re = /<text:p(?:\s[^>]*)?>([\s\S]*?)<\/text:p>/gi;
        let m;
        while ((m = re.exec(decodeUtf8(content)))) {
          parts.push(unescapeXml(m[1]).replace(/<[^>]+>/g, ''));
        }
        return cleanText(parts.join('\n'));
      }
      return '';
    }
    if (ext === 'xlsx' || ext === 'ods') {
      const shared = entries['xl/sharedStrings.xml']
        ? sharedStrings(decodeUtf8(entries['xl/sharedStrings.xml']))
        : [];
      const sheets = Object.keys(entries)
        .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
        .sort();
      const lines = [];
      for (const sheet of sheets) {
        lines.push(`## ${sheet.replace('xl/worksheets/', '')}`);
        lines.push(...xlsxRows(decodeUtf8(entries[sheet]), shared));
      }
      return cleanText(lines.join('\n'));
    }
    if (ext === 'pptx') {
      const slides = Object.keys(entries)
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort();
      const lines = [];
      for (const slide of slides) {
        lines.push(`## ${slide.replace('ppt/slides/', '')}`);
        lines.push(pptxText(decodeUtf8(entries[slide])));
      }
      return cleanText(lines.join('\n'));
    }
    return '';
  }

  // ------------------------------------------------------------------ pdf --

  function readPdfLiteral(content, start) {
    // content[start] === '(' — read a literal string with its escapes.
    let depth = 0;
    let out = '';
    for (let i = start; i < content.length; i++) {
      const c = content[i];
      if (c === '\\') {
        const next = content[i + 1];
        i++;
        if (next === 'n') out += '\n';
        else if (next === 'r') out += '\r';
        else if (next === 't') out += '\t';
        else if (next === 'b') out += '\b';
        else if (next === 'f') out += '\f';
        else if (next >= '0' && next <= '7') {
          let oct = next;
          while (oct.length < 3 && content[i + 1] >= '0' && content[i + 1] <= '7') {
            oct += content[++i];
          }
          out += String.fromCharCode(parseInt(oct, 8));
        } else if (next === '\n') {
          // line continuation
        } else {
          out += next;
        }
        continue;
      }
      if (c === '(') {
        depth++;
        if (depth === 1) continue;
      }
      if (c === ')') {
        depth--;
        if (depth === 0) return { value: out, next: i + 1 };
      }
      out += c;
    }
    return { value: out, next: content.length };
  }

  function hexToText(hex) {
    if (hex.length % 2) hex += '0';
    if (hex.startsWith('feff')) {
      // UTF-16BE
      let out = '';
      for (let i = 2; i + 3 < hex.length + 1; i += 4) {
        const code = parseInt(hex.substr(i, 4), 16);
        if (!Number.isNaN(code)) out += String.fromCharCode(code);
      }
      return out;
    }
    let out = '';
    for (let i = 0; i + 1 < hex.length; i += 2) {
      const code = parseInt(hex.substr(i, 2), 16);
      if (!Number.isNaN(code)) out += String.fromCharCode(code);
    }
    return out;
  }

  /** Pull the visible text out of a PDF content stream. */
  function pdfTextFromContent(content) {
    const out = [];
    let pending = [];
    const flush = () => {
      if (pending.length) {
        out.push(pending.join(''));
        pending = [];
      }
    };
    let i = 0;
    const n = content.length;
    while (i < n) {
      const c = content[i];
      if (c === '(') {
        const lit = readPdfLiteral(content, i);
        pending.push(lit.value);
        i = lit.next;
        continue;
      }
      if (c === '<' && content[i + 1] !== '<') {
        const end = content.indexOf('>', i);
        if (end === -1) break;
        pending.push(hexToText(content.slice(i + 1, end).replace(/\s+/g, '')));
        i = end + 1;
        continue;
      }
      if (c === '<' && content[i + 1] === '<') {
        i += 2;
        continue;
      }
      if (c === '>' && content[i + 1] === '>') {
        i += 2;
        continue;
      }
      if (c === 'T' && content[i + 1] === '*') {
        flush();
        out.push('\n');
        i += 2;
        continue;
      }
      if (c === 'E' && content[i + 1] === 'T') {
        flush();
        out.push('\n');
        i += 2;
        continue;
      }
      if ((c === 'T' && (content[i + 1] === 'd' || content[i + 1] === 'D')) ||
          (c === 'T' && content[i + 1] === 'm')) {
        flush();
        out.push(' ');
        i += 2;
        continue;
      }
      i++;
    }
    flush();
    return out.join('');
  }

  async function extractPdfText(bytes) {
    const raw = bytesToLatin1(bytes);
    const chunks = [];
    const re = /stream\r\n|\r|\n/g;
    let m;
    while ((m = re.exec(raw))) {
      const start = m.index + m[0].length;
      const end = raw.indexOf('endstream', start);
      if (end === -1) break;
      const header = raw.slice(Math.max(0, m.index - 600), m.index);
      const dict = header.slice(header.lastIndexOf('<<'));
      // Skip images and other binary payloads.
      if (/\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode|\/Image\b|\/FontFile/.test(dict)) {
        re.lastIndex = end + 9;
        continue;
      }
      const data = toBytes(raw.slice(start, end));
      let text = null;
      if (/\/FlateDecode/.test(header)) {
        const inflated = await inflate(data, 'deflate');
        if (inflated) text = pdfTextFromContent(bytesToLatin1(inflated));
      } else if (!/\/Filter/.test(dict)) {
        text = pdfTextFromContent(bytesToLatin1(data));
      }
      if (text && text.trim()) chunks.push(text);
      // Skip past "endstream" so it is not mistaken for another stream.
      re.lastIndex = end + 9;
    }
    return cleanText(chunks.join('\n'));
  }

  // ------------------------------------------------------------- the entry --

  /**
   * Read an attached file.
   * @param {string} name file name
   * @param {Uint8Array} bytes file content
   * @returns {Promise<{kind:string, text?:string, dataUrl?:string, note?:string}>}
   *   kind: 'image' | 'text' | 'unsupported'
   */
  async function readAttachment(name, bytes) {
    const ext = extOf(name);
    try {
      if (IMAGE_EXTENSIONS.has(ext)) {
        const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
        return {
          kind: 'image',
          mime,
          dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}`,
          note: 'image',
        };
      }
      if (ext === 'pdf') {
        const text = await extractPdfText(bytes);
        if (!text) {
          return {
            kind: 'text',
            text: '',
            note:
              'The PDF has no extractable text (it is probably a scan). Ask the user for a text version, or read the file from the project.',
          };
        }
        return { kind: 'text', text, note: 'pdf' };
      }
      if (OFFICE_EXTENSIONS.has(ext)) {
        const text = await extractOfficeText(name, bytes);
        return { kind: 'text', text, note: ext };
      }
      if (isTextFile(name)) {
        const text = decodeUtf8(bytes);
        if (text.indexOf(NUL) !== -1) {
          return {
            kind: 'unsupported',
            note: 'This looks like a binary file — the model cannot read it as text.',
          };
        }
        return { kind: 'text', text, note: 'text' };
      }
      // Unknown extension: readable when it is plain text, rejected when it
      // is binary.
      const unknown = decodeUtf8(bytes);
      if (unknown.indexOf(NUL) !== -1) {
        return {
          kind: 'unsupported',
          note: 'This looks like a binary file — the model cannot read it as text.',
        };
      }
      return {
        kind: 'unsupported',
        note: `The model cannot read .${ext} files. Convert it to text or PDF first.`,
      };
    } catch (e) {
      return { kind: 'unsupported', note: 'Could not read the file: ' + String((e && e.message) || e) };
    }
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    if (typeof btoa === 'function') return btoa(binary);
    return Buffer.from(bytes).toString('base64'); // Node (tests)
  }

  const api = {
    readAttachment,
    readZipEntries,
    extractPdfText,
    extractOfficeText,
    docxText,
    xlsxRows,
    sharedStrings,
    pptxText,
    extOf,
    isImage,
    isTextFile,
    bytesToBase64,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) {
    global.readAttachment = readAttachment;
    global.extOf = extOf;
  }
})(typeof window !== 'undefined' ? window : null);
