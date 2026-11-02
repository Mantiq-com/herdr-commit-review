// A small tokenizer for diff rows: each row is scanned on its own, left to
// right, into spans of one class (keyword, string, comment, number, type,
// function, constant, property, or "" for plain text). `state` carries a block
// comment or multi-line string left open on one row into the next.
//
// It is not a parser: it colors what a reader scans for and leaves the rest
// plain. A language it does not know gets no colors at all.

const words = (text) => new Set(text.split(" ").filter(Boolean));

const C_LIKE = { line: "//", block: ["/*", "*/"], quotes: "\"'" };

const RULES = {
  js: {
    ...C_LIKE, quotes: "\"'`",
    keywords: words("as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface keyof let new of readonly return satisfies set static super switch this throw try type typeof var void while with yield"),
    constants: words("true false null undefined NaN Infinity"),
  },
  rust: {
    ...C_LIKE, quotes: "\"",
    keywords: words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while"),
    constants: words("true false None Some Ok Err"),
  },
  go: {
    ...C_LIKE, quotes: "\"'`",
    keywords: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
    constants: words("true false nil iota"),
  },
  c: {
    ...C_LIKE, directives: true,
    keywords: words("auto bool break case char class const constexpr continue default delete do double else enum explicit extern float for friend goto if inline int long mutable namespace new noexcept operator override private protected public register return short signed sizeof static struct switch template this throw try typedef typename union unsigned using virtual void volatile while"),
    constants: words("true false NULL nullptr"),
  },
  java: {
    ...C_LIKE,
    keywords: words("abstract boolean break byte case catch char class const continue data default do double else enum extends final finally float for fun if implements import in instanceof int interface internal is long new object open override package private protected public return sealed short static super switch synchronized this throw throws try val var void volatile when while"),
    constants: words("true false null"),
  },
  python: {
    line: "#", triple: ['"""', "'''"], quotes: "\"'",
    keywords: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return self try while with yield"),
    constants: words("True False None"),
  },
  ruby: {
    line: "#", quotes: "\"'",
    keywords: words("alias and begin break case class def do else elsif end ensure for if in module next not or redo require rescue retry return self super then unless until when while yield"),
    constants: words("true false nil"),
  },
  shell: {
    line: "#", quotes: "\"'", variables: true,
    keywords: words("case do done elif else esac export fi for function if in local readonly return set shift source then trap unset until while"),
    constants: words("true false"),
  },
  nix: {
    line: "#", block: ["/*", "*/"], quotes: "\"",
    keywords: words("assert else if import in inherit let or rec then with"),
    constants: words("true false null"),
  },
  sql: {
    line: "--", block: ["/*", "*/"], quotes: "'", anyCase: true,
    keywords: words("add all alter and as asc begin by case commit create default delete desc distinct drop else end exists foreign from group having if in index inner insert into is join key left like limit not null offset on or order outer primary references returning right rollback select set table then union unique update values view when where with"),
    constants: words("true false"),
  },
  yaml: { line: "#", quotes: "\"'", keys: true, keywords: words(""), constants: words("true false null yes no on off") },
  toml: { line: "#", quotes: "\"'", keys: true, keywords: words(""), constants: words("true false") },
  json: { quotes: "\"", keywords: words(""), constants: words("true false null") },
  css: { block: ["/*", "*/"], quotes: "\"'", keywords: words("important media import supports keyframes"), constants: words("") },
  markup: { block: ["<!--", "-->"], quotes: "\"'", tags: true, keywords: words(""), constants: words("") },
};

const BY_EXTENSION = {
  js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js", mts: "js", cts: "js",
  rs: "rust", go: "go",
  c: "c", h: "c", cc: "c", cpp: "c", cxx: "c", hh: "c", hpp: "c", m: "c", mm: "c",
  java: "java", kt: "java", kts: "java", scala: "java", cs: "java", swift: "java", dart: "java",
  py: "python", pyi: "python", rb: "ruby",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  nix: "nix", sql: "sql", yml: "yaml", yaml: "yaml", toml: "toml", json: "json", jsonc: "json",
  css: "css", scss: "css", less: "css",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", svelte: "markup",
};
const BY_NAME = { dockerfile: "shell", makefile: "shell", justfile: "shell", ".bashrc": "shell", ".zshrc": "shell" };

/** The tokenizer language of a file, or null when it gets no colors. */
export function languageOf(path) {
  const name = (path ?? "").split("/").pop().toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1)] ?? null : null;
}

// Past this length a row stays plain: a minified line would cost more to draw
// in pieces than its colors are worth.
const MAX_LENGTH = 600;
// Each span is drawn as an element, so a row keeps at most this many; the rest is plain.
const MAX_SPANS = 40;

const NUMBER = /(?:0[xXbBoO][\dA-Fa-f_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[A-Za-z\d_]*/y;
const WORD = /[A-Za-z_$][\w$]*/y;
const TAG = /<\/?[A-Za-z][\w:.-]*/y;
const VARIABLE = /\$(?:\{[^}]*\}|[A-Za-z_]\w*|[@#?*!$\d-])/y;
const KEY = /^(\s*-?\s*)("[^"]*"|'[^']*'|[\w.-]+)(\s*[:=])/;

function match(pattern, text, at) {
  pattern.lastIndex = at;
  return pattern.exec(text)?.[0] ?? null;
}

function classify(word, rules, next) {
  if ((rules.anyCase ? rules.keywords.has(word.toLowerCase()) : rules.keywords.has(word))) return "keyword";
  if (rules.constants.has(word)) return "constant";
  if (next === "(") return "function";
  if (/^[A-Z][A-Z\d_]+$/.test(word)) return "constant";
  if (/^[A-Z]/.test(word)) return "type";
  return "";
}

/** Splits one row into spans. `state` is what the row before returned (null for a hunk's first row). */
export function tokenize(text, lang, state) {
  const rules = RULES[lang];
  if (!rules || text.length > MAX_LENGTH) return { spans: [{ text, cls: "" }], state: null };
  const spans = [];
  const emit = (part, cls) => {
    if (!part) return;
    if (spans.length >= MAX_SPANS) cls = "";
    const last = spans[spans.length - 1];
    if (last && last.cls === cls) last.text += part;
    else spans.push({ text: part, cls });
  };
  let at = 0;

  if (state) {
    const end = text.indexOf(state.close);
    if (end < 0) { emit(text, state.cls); return { spans, state }; }
    at = end + state.close.length;
    emit(text.slice(0, at), state.cls);
  } else if (rules.keys) {
    const key = KEY.exec(text);
    if (key) { emit(key[1], ""); emit(key[2], "property"); emit(key[3], ""); at = key[0].length; }
  }
  if (rules.directives && /^\s*#/.test(text)) { emit(text.slice(at), "keyword"); return { spans, state: null }; }

  while (at < text.length) {
    const c = text[at];
    if (rules.line && text.startsWith(rules.line, at)) { emit(text.slice(at), "comment"); break; }
    const open = rules.block?.[0];
    if (open && text.startsWith(open, at)) {
      const close = rules.block[1], end = text.indexOf(close, at + open.length);
      if (end < 0) { emit(text.slice(at), "comment"); return { spans, state: { close, cls: "comment" } }; }
      emit(text.slice(at, end + close.length), "comment"); at = end + close.length; continue;
    }
    const triple = rules.triple?.find((q) => text.startsWith(q, at));
    if (triple) {
      const end = text.indexOf(triple, at + triple.length);
      if (end < 0) { emit(text.slice(at), "string"); return { spans, state: { close: triple, cls: "string" } }; }
      emit(text.slice(at, end + triple.length), "string"); at = end + triple.length; continue;
    }
    if (rules.quotes.includes(c)) {
      let end = at + 1;
      while (end < text.length && text[end] !== c) end += text[end] === "\\" ? 2 : 1;
      emit(text.slice(at, end + 1), "string"); at = end + 1; continue;
    }
    if (rules.tags && c === "<") {
      const tag = match(TAG, text, at);
      if (tag) { emit(tag, "keyword"); at += tag.length; continue; }
    }
    if (rules.variables && c === "$") {
      const variable = match(VARIABLE, text, at);
      if (variable) { emit(variable, "property"); at += variable.length; continue; }
    }
    if (c >= "0" && c <= "9" && !/[\w$]/.test(text[at - 1] ?? "")) {
      const number = match(NUMBER, text, at);
      emit(number, "number"); at += number.length; continue;
    }
    const word = match(WORD, text, at);
    if (word) {
      let after = at + word.length;
      while (text[after] === " ") after++;
      emit(word, classify(word, rules, text[after])); at += word.length; continue;
    }
    emit(c, ""); at++;
  }
  return { spans, state: null };
}
