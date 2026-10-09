/* Local Code Agent — Markdown renderer + syntax highlighter.
 *
 * No dependencies (the extension ships without a build step). Model output is
 * untrusted, so every slice of source text is HTML-escaped before markup is
 * generated: the renderer only ever emits tags it constructed itself, which
 * keeps stray script/onerror output inert.
 */

(function (global) {
  'use strict';

  // ------------------------------------------------------------- utilities
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
  }

  const words = (s) => String(s || '').split(/\s+/).filter(Boolean);

  // ------------------------------------------------ syntax highlighting ---
  // Profiles are shared across aliases; the scanner walks the code once and
  // classifies comments / strings / numbers / keywords / calls.
  const LANG = {};
  const ALIASES = {};

  function defineLang(aliases, spec) {
    const profile = {
      line: spec.line || [],
      block: spec.block || [],
      strings: spec.strings || [],
      triple: spec.triple || [],
      kw: new Set(words(spec.kw)),
      lit: new Set(words(spec.lit)),
      built: new Set(words(spec.built)),
      html: !!spec.html,
      propColon: !!spec.propColon,
      capitals: spec.capitals !== false,
    };
    LANG[aliases[0]] = profile;
    aliases.slice(1).forEach((a) => { ALIASES[a] = aliases[0]; });
  }

  defineLang(['js'], {
    line: ['//'],
    block: [['/*', '*/']],
    strings: ['"', "'", '`'],
    kw:
      'await break case catch class const continue debugger default delete do else enum export ' +
      'extends finally for from function get if implements import in instanceof interface let new ' +
      'of private protected public return set static super switch this throw try typeof var void ' +
      'while with yield async as declare namespace type readonly keyof infer is satisfies assert module',
    lit: 'undefined null true false NaN Infinity',
    built:
      'console window document globalThis Math JSON Promise Object Array String Number Boolean ' +
      'Symbol Map Set Date RegExp Error process require define arguments',
  });

  defineLang(['py'], {
    line: ['#'],
    strings: ['"', "'"],
    triple: ['"""', "'''"],
    kw:
      'and as assert async await break class continue def del elif else except finally for from ' +
      'global if import in is lambda nonlocal not or pass raise return try while with yield match case',
    lit: 'None True False',
    built:
      'self cls print len range str int float list dict set tuple bool type bytes frozenset object ' +
      'super isinstance Exception ValueError TypeError KeyError IndexError RuntimeError StopIteration ' +
      'open input abs min max sum sorted enumerate zip map filter any all repr',
    capitals: false,
  });

  defineLang(['sh'], {
    line: ['#'],
    strings: ['"', "'"],
    kw:
      'if then else elif fi for while do done case esac function in select until time coproc ' +
      'local return exit break continue',
    lit: 'true false',
    built:
      'echo cd ls rm mkdir cat grep sed awk curl wget git npm node python python3 pip export set ' +
      'unset shift trap printf read source pwd mv cp chmod chown touch head tail sort uniq wc ' +
      'diff patch apt brew docker kubectl terraform powershell',
    capitals: false,
  });

  defineLang(['json'], {
    strings: ['"'],
    lit: 'true false null',
    propColon: true,
    capitals: false,
  });

  defineLang(['yaml'], {
    line: ['#'],
    strings: ['"', "'"],
    lit: 'true false yes no on off null',
    propColon: true,
    capitals: false,
  });

  defineLang(['toml'], {
    line: ['#'],
    strings: ['"', "'"],
    lit: 'true false',
    propColon: true,
    capitals: false,
  });

  defineLang(['css'], {
    block: [['/*', '*/']],
    strings: ['"', "'"],
    propColon: true,
    capitals: false,
  });

  defineLang(['html'], {
    block: [['<!--', '-->']],
    strings: ['"', "'"],
    html: true,
    kw: 'doctype html head body script style link meta',
    lit: 'true false',
    capitals: false,
  });

  defineLang(['sql'], {
    line: ['--'],
    block: [['/*', '*/']],
    strings: ["'", '"'],
    kw:
      'select from where insert into values update set delete create table drop alter join left ' +
      'right inner outer full on group by order having limit offset as and or not null distinct ' +
      'primary key foreign references index view with union all like in is exists case when then ' +
      'else end begin commit rollback between using desc asc',
    lit: 'true false',
    built: 'count sum avg min max coalesce cast convert now current_date current_timestamp',
    capitals: false,
  });

  defineLang(['go'], {
    line: ['//'],
    block: [['/*', '*/']],
    strings: ['"', "'", '`'],
    kw:
      'package import func var const type struct interface map chan go defer if else for range ' +
      'return switch case default break continue select fallthrough goto',
    lit: 'nil true false iota',
    built:
      'string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 bool byte ' +
      'rune error len cap make new append copy delete panic recover print println',
  });

  defineLang(['rs'], {
    line: ['//'],
    block: [['/*', '*/']],
    strings: ['"', "'"],
    kw:
      'fn let mut pub use mod struct enum impl trait match if else while for loop return break ' +
      'continue const static unsafe async await move ref where crate self super as in dyn box',
    lit: 'true false None',
    built:
      'i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char String Vec Option ' +
      'Result Some None Ok Err println format',
  });

  defineLang(['cpp'], {
    line: ['//'],
    block: [['/*', '*/']],
    strings: ['"', "'"],
    kw:
      'class struct namespace using public private protected virtual override final new delete ' +
      'template typename this const constexpr static extern inline explicit friend operator ' +
      'sizeof typedef union goto',
    lit: 'true false nullptr NULL void',
    built:
      'int char float double bool long short unsigned signed auto string std cout cin printf ' +
      'scanf include define main vector map set size push_back',
  });

  defineLang(['cs'], {
    line: ['//'],
    block: [['/*', '*/']],
    strings: ['"', "'"],
    kw:
      'class struct interface enum namespace using public private protected internal static readonly ' +
      'virtual override sealed async await new delete this base null true false is as typeof ' +
      'nameof checked unchecked unsafe fixed stackalloc',
    lit: 'true false null',
    built:
      'int char float double bool long short byte string var object void Console Write WriteLine ' +
      'List Dictionary Task',
  });

  defineLang(['java'], {
    line: ['//'],
    block: [['/*', '*/']],
    strings: ['"', "'"],
    kw:
      'class interface extends implements public private protected static final void new return if ' +
      'else for while do switch case break continue try catch finally throw throws import package ' +
      'this super enum instanceof abstract synchronized transient volatile native default record var',
    lit: 'true false null',
    built:
      'String Integer Boolean Double Float Long Object List Map System out println printlnf printf',
  });

  defineLang(['kt'], {
    line: ['//'],
    block: [['/*', '*/']],
    strings: ['"', "'"],
    kw:
      'fun val var class object interface data sealed when if else for while do return break ' +
      'continue throw try catch finally import package internal private public protected override ' +
      'open is in as companion lateinit by lazy suspend',
    lit: 'true false null',
    built: 'String Int Double Float Boolean Long List Map MutableMap println',
  });

  defineLang(['rb'], {
    line: ['#'],
    strings: ['"', "'"],
    kw:
      'def end if elsif else unless case when while until for in do return yield begin rescue ' +
      'ensure raise require require_relative module class self nil true false and or not',
    lit: 'true false nil',
    built: 'puts print p lambda proc new attr_accessor include extend',
    capitals: false,
  });

  defineLang(['php'], {
    line: ['//', '#'],
    block: [['/*', '*/']],
    strings: ['"', "'"],
    kw:
      'function class interface trait abstract final public private protected static return if else ' +
      'elseif while for foreach switch case default break continue echo print require require_once ' +
      'use namespace new clone try catch throw instanceof',
    lit: 'true false null',
    built: 'array string int float bool isset unset empty array_map count implode explode',
    capitals: false,
  });

  defineLang(['md'], { strings: [], capitals: false });

  Object.assign(ALIASES, {
    javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', typescript: 'js', tsx: 'js', ts: 'js',
    node: 'js', 'node.js': 'js', ecmascript: 'js',
    python: 'py', python3: 'py',
    bash: 'sh', shell: 'sh', zsh: 'sh', fish: 'sh', console: 'sh', terminal: 'sh',
    powershell: 'sh', ps1: 'sh', cmd: 'sh', bat: 'sh', batch: 'sh', dockerfile: 'sh',
    makefile: 'sh', cmake: 'sh', shellsession: 'sh',
    yml: 'yaml', dockercompose: 'yaml', ini: 'toml', cfg: 'toml', conf: 'toml',
    scss: 'css', sass: 'css', less: 'css', stylus: 'css',
    xml: 'html', svg: 'html', xhtml: 'html', vue: 'html', svelte: 'html', htm: 'html',
    golang: 'go', rust: 'rs', ruby: 'rb', rails: 'rb',
    'c++': 'cpp', 'c#': 'cs', csharp: 'cs', kotlin: 'kt', swift: 'java', scala: 'java',
    objc: 'cpp', 'objective-c': 'cpp',
    jsonc: 'json', json5: 'json',
    postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql', tsql: 'sql',
  });

  function resolveLang(lang) {
    const key = String(lang || '').toLowerCase().trim();
    if (!key) return null;
    return LANG[ALIASES[key] || key] || null;
  }

  /** Classify one identifier-like word (keyword, literal, builtin, call...). */
  function wordClass(profile, word, nextChar) {
    if (profile.kw.has(word)) return 'tok-k';
    if (profile.lit.has(word)) return 'tok-n';
    if (profile.built.has(word)) return 'tok-b';
    if (nextChar === '(') return 'tok-f';
    if (profile.propColon && nextChar === ':') return 'tok-a';
    if (profile.capitals && /^[A-Z]/.test(word)) return 'tok-b';
    return '';
  }

  function highlightHtmlTag(raw) {
    let out = '';
    let i = 0;
    const n = raw.length;
    const emit = (cls, text) => {
      out += cls ? '<span class="' + cls + '">' + escapeHtml(text) + '</span>' : escapeHtml(text);
    };
    while (i < n) {
      const ch = raw[i];
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < n && raw[j] !== ch) j += 1;
        emit('tok-s', raw.slice(i, Math.min(j + 1, n)));
        i = j + 1;
        continue;
      }
      if (/[A-Za-z_:-]/.test(ch)) {
        let j = i;
        while (j < n && /[\w:.-]/.test(raw[j])) j += 1;
        const word = raw.slice(i, j);
        let k = j;
        while (k < n && /\s/.test(raw[k])) k += 1;
        emit(raw[k] === '=' ? 'tok-a' : 'tok-k', word);
        i = j;
        continue;
      }
      emit('', ch);
      i += 1;
    }
    return out;
  }

  function highlight(code, lang) {
    const profile = resolveLang(lang);
    const src = String(code == null ? '' : code);
    if (!profile) return escapeHtml(src);

    const n = src.length;
    let i = 0;
    let out = '';
    const emit = (cls, text) => {
      out += cls ? '<span class="' + cls + '">' + escapeHtml(text) + '</span>' : escapeHtml(text);
    };

    while (i < n) {
      const ch = src[i];
      let matched = false;

      // line comments
      for (const marker of profile.line) {
        if (marker && src.startsWith(marker, i)) {
          let j = src.indexOf('\n', i);
          if (j === -1) j = n;
          emit('tok-c', src.slice(i, j));
          i = j;
          matched = true;
          break;
        }
      }
      if (matched) continue;

      // block comments
      for (const pair of profile.block) {
        const open = pair[0];
        const close = pair[1];
        if (src.startsWith(open, i)) {
          let j = src.indexOf(close, i + open.length);
          j = j === -1 ? n : j + close.length;
          emit('tok-c', src.slice(i, j));
          i = j;
          matched = true;
          break;
        }
      }
      if (matched) continue;

      // html tags carry their own mini-scanner
      if (profile.html && ch === '<') {
        if (src.startsWith('<!--', i)) continue; // handled as a block comment above
        let j = i;
        let quote = '';
        while (j < n) {
          const c = src[j];
          if (quote) {
            if (c === quote) quote = '';
          } else if (c === '"' || c === "'") {
            quote = c;
          } else if (c === '>') {
            break;
          }
          j += 1;
        }
        const end = Math.min(j + 1, n);
        out += highlightHtmlTag(src.slice(i, end));
        i = end;
        continue;
      }

      // triple-quoted strings (python docstrings) before plain strings
      let tripleMatched = false;
      for (const marker of profile.triple) {
        if (src.startsWith(marker, i)) {
          let j = src.indexOf(marker, i + marker.length);
          j = j === -1 ? n : j + marker.length;
          emit('tok-s', src.slice(i, j));
          i = j;
          tripleMatched = true;
          break;
        }
      }
      if (tripleMatched) continue;

      if (profile.strings.indexOf(ch) !== -1) {
        let j = i + 1;
        while (j < n) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === ch) { j += 1; break; }
          if (src[j] === '\n' && ch !== '`') { break; }
          j += 1;
        }
        j = Math.min(j, n);
        emit('tok-s', src.slice(i, j));
        i = j;
        continue;
      }

      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        let j = i;
        while (j < n && /[0-9a-fA-FxXoObB._]/.test(src[j])) j += 1;
        emit('tok-n', src.slice(i, j));
        i = j;
        continue;
      }

      if (/[A-Za-z_$]/.test(ch)) {
        let j = i;
        while (j < n && /[\w$]/.test(src[j])) j += 1;
        const word = src.slice(i, j);
        let k = j;
        while (k < n && (src[k] === ' ' || src[k] === '\t')) k += 1;
        emit(wordClass(profile, word, src[k] || ''), word);
        i = j;
        continue;
      }

      emit('', ch);
      i += 1;
    }
    return out;
  }

  // -------------------------------------------------------------- markdown
  // Stash markers are control characters that never occur in chat text, so
  // restored HTML cannot collide with the source being formatted.
  const MARK = '\x00';
  const MARK_END = '\x01';
  const FENCE_RE = /\x00F(\d+)\x01/;
  const SLOT_RE = /\x00(\d+)\x01/g;

  function inlineFormat(text) {
    const slots = [];
    const stash = (html) => {
      slots.push(html);
      return MARK + (slots.length - 1) + MARK_END;
    };

    let s = text;

    // inline code first — its contents must not be reformatted
    s = s.replace(/`([^`\n]+)`/g, (m, code) => stash('<code>' + code + '</code>'));

    // images and links (absolute http/https/mailto targets only)
    s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (m, alt, url) =>
      stash('<img src="' + url + '" alt="' + alt + '" loading="lazy" />')
    );
    s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (m, label, url) =>
      stash('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>')
    );

    // bare URLs
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (m, pre, url) => {
      const trail = /[.,;:!?"'\u201d\u2019]+$/.exec(url);
      const clean = trail ? url.slice(0, url.length - trail[0].length) : url;
      const tail = trail ? trail[0] : '';
      const link =
        '<a href="' + clean + '" target="_blank" rel="noopener noreferrer">' + clean + '</a>';
      return pre + stash(link) + tail;
    });

    // emphasis
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?![^*])/g, '$1<em>$2</em>');
    s = s.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    return s.replace(SLOT_RE, (m, idx) => slots[Number(idx)] || '');
  }

  function codeBlockHtml(fence) {
    const lang = String(fence.lang || '').toLowerCase();
    return (
      '<div class="code-block">' +
      '<div class="code-head"><span class="code-lang">' +
      escapeHtml(lang || 'text') +
      '</span><button type="button" class="code-copy" title="Copy code">Copy</button></div>' +
      '<pre><code>' +
      highlight(fence.code, lang) +
      '</code></pre></div>'
    );
  }

  function blocksToHtml(text, fences) {
    const lines = text.split('\n');
    const out = [];
    let para = [];
    let quote = [];
    let listTag = '';
    let items = [];

    const flushPara = () => {
      if (para.length) {
        out.push('<p>' + inlineFormat(para.join('<br>')) + '</p>');
        para = [];
      }
    };
    const flushQuote = () => {
      if (quote.length) {
        out.push('<blockquote>' + inlineFormat(quote.join('<br>')) + '</blockquote>');
        quote = [];
      }
    };
    const flushList = () => {
      if (items.length && listTag) {
        out.push(
          '<' + listTag + '>' +
            items.map((i) => '<li>' + inlineFormat(i) + '</li>').join('') +
            '</' + listTag + '>'
        );
      }
      items = [];
      listTag = '';
    };
    const flushAll = () => { flushPara(); flushQuote(); flushList(); };

    for (const raw of lines) {
      const fence = FENCE_RE.exec(raw.trim());
      if (fence && fence.index === 0 && fence[0].length === raw.trim().length) {
        flushAll();
        out.push(codeBlockHtml(fences[Number(fence[1])] || { lang: '', code: '' }));
        continue;
      }
      if (!raw.trim()) {
        flushAll();
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
      if (heading) {
        flushAll();
        const level = heading[1].length;
        out.push('<h' + level + '>' + inlineFormat(heading[2].trim()) + '</h' + level + '>');
        continue;
      }

      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) {
        flushAll();
        out.push('<hr />');
        continue;
      }

      if (/^\s{0,3}&gt; ?/.test(raw)) {
        flushPara();
        flushList();
        quote.push(raw.replace(/^\s{0,3}&gt; ?/, ''));
        continue;
      }

      const bullet = /^\s*([-+*])\s+(.*)$/.exec(raw);
      const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(raw);
      if (bullet || ordered) {
        flushPara();
        flushQuote();
        const tag = ordered ? 'ol' : 'ul';
        if (listTag && listTag !== tag) flushList();
        listTag = tag;
        items.push((bullet ? bullet[2] : ordered[2]).trim());
        continue;
      }

      // lazy continuations (a wrapped line belongs to the open block)
      if (quote.length) { quote.push(raw); continue; }
      if (items.length) { items[items.length - 1] += ' ' + raw.trim(); continue; }

      para.push(raw);
    }

    flushAll();
    return out.join('\n');
  }

  function renderMarkdown(src) {
    const text = src == null ? '' : String(src);
    if (!text) return '';

    // 1. pull fenced code out first so highlighting sees raw (unescaped) text
    const fences = [];
    const working = text.replace(/```([^\n]*)\n?([\s\S]*?)(?:```|$)/g, (m, info, code) => {
      fences.push({
        lang: (info || '').trim().split(/\s+/)[0] || '',
        code: code.replace(/\n+$/, ''),
      });
      return '\n' + MARK + 'F' + (fences.length - 1) + MARK_END + '\n';
    });

    // 2. escape everything else, then build structure from the escaped text
    return blocksToHtml(escapeHtml(working), fences);
  }

  const api = { renderMarkdown, highlight, escapeHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) {
    global.renderMarkdown = renderMarkdown;
    global.highlightCode = highlight;
  }
})(typeof window !== 'undefined' ? window : null);
