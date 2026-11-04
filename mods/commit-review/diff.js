// Diff rows for the Review panel, the unchanged lines the person can reveal
// around the hunks, and where a thread sits among them.
import { tokenize } from "./highlight.js";

// `herdr-review` keeps at most this many quoted lines per thread.
const MAX_QUOTE_LINES = 60;
/** The lines one click on an expander row shows. A hidden run this long or
 *  shorter opens whole, in one click. */
export const MORE_LINES = 20;

/** Numbers and tokenizes each diff line once, so a frame only draws the rows
 *  on screen. A row has `kind` ("@" a hunk header, "+", "-", " " context, ""
 *  anything else), `old` and `number` (its line before and after the change;
 *  a context row has both), `raw` (the file's text) and `hunk` (its header's index). */
export function diffRows(lines, lang) {
  let old = 0, next = 0, state = null, hunk = -1;
  return lines.map((line, i) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) {
      old = Number(match[1]); next = Number(match[2]); state = null; hunk = i;
      return { kind: "@", raw: line, text: line, hunk: i, spans: [{ text: line, cls: "" }] };
    }
    const kind = line[0];
    let row;
    if (kind === "-") row = { kind, old: old++ };
    else if (kind === "+") row = { kind, number: next++ };
    else if (kind === " ") row = { kind, old: old++, number: next++ };
    else row = { kind: "" };
    row.raw = row.kind ? line.slice(1) : line;
    row.text = row.raw || " ";
    row.hunk = hunk;
    const t = tokenize(row.text.replace(/\t/g, "    "), lang, state);
    row.spans = t.spans; state = t.state;
    return row;
  });
}

/** A row's line number in the file before ("old") or after ("new") the change. */
export const lineOn = (row, side) => side === "old" ? row.old : row.number;
/** Whether a row is a line of the file on that side (context rows are on both). */
export const onSide = (row, side) => row.kind === " " || row.kind === (side === "old" ? "-" : "+");

/** What a new thread on rows `from`..`to` is about: the side (old only when
 *  every chosen line is a removed one), its first and last line there, and
 *  those lines' text. Null when the rows hold no file line. */
export function anchorOf(rows, from, to) {
  const chosen = rows.slice(from, to + 1).filter((r) => r.kind === "+" || r.kind === "-" || r.kind === " ");
  if (!chosen.length) return null;
  const side = chosen.some((r) => r.kind !== "-") ? "new" : "old";
  const lines = chosen.filter((r) => onSide(r, side)), numbers = lines.map((r) => lineOn(r, side));
  return { side, line: Math.min(...numbers), endLine: Math.max(...numbers), quote: lines.slice(0, MAX_QUOTE_LINES).map((r) => r.raw).join("\n") };
}

/** The rows a thread is about in this diff, or null when its first quoted line
 *  is not among them (the line changed since, or the thread is about a line
 *  outside the hunks). Among equal lines, the one nearest its line number wins. */
export function place(thread, rows) {
  if (thread.line === null || thread.line === undefined) return null;
  const side = thread.side, first = (thread.quote ?? "").split("\n")[0];
  let start = -1, best = Infinity;
  rows.forEach((r, i) => {
    if (!onSide(r, side) || r.raw !== first) return;
    const distance = Math.abs(lineOn(r, side) - thread.line);
    if (distance < best) { best = distance; start = i; }
  });
  if (start < 0) return null;
  const last = lineOn(rows[start], side) + ((thread.end_line ?? thread.line) - thread.line);
  let end = start;
  for (let i = start + 1; i < rows.length; i++) {
    if (!onSide(rows[i], side)) continue;
    if (lineOn(rows[i], side) > last) break;
    end = i;
  }
  return { from: start, to: end };
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/s;

// git prints the line before a hunk as its start when the hunk has no lines on
// that side; this is the last line ahead of the hunk either way.
const lineBefore = (start, count) => count > 0 ? start - 1 : start;

/** The diff's hunks: their header, function name (`suffix`), lines, and the
 *  last line before and first line after them on each side. A hunk with fewer
 *  lines than its header counts was cut short (diffOf's line limit). */
function hunksOf(lines) {
  const hunks = [];
  for (const line of lines) {
    const m = HEADER.exec(line);
    if (!m) { if (hunks.length) hunks[hunks.length - 1].body.push(line); continue; }
    const oldStart = Number(m[1]), newStart = Number(m[3]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]), newCount = m[4] === undefined ? 1 : Number(m[4]);
    const oldBefore = lineBefore(oldStart, oldCount), newBefore = lineBefore(newStart, newCount);
    hunks.push({ header: line, suffix: m[5], oldStart, newStart, oldCount, newCount, oldBefore, newBefore, oldAfter: oldBefore + oldCount + 1, newAfter: newBefore + newCount + 1, body: [] });
  }
  for (const h of hunks) {
    const oldSeen = h.body.filter((l) => l[0] === " " || l[0] === "-").length;
    const newSeen = h.body.filter((l) => l[0] === " " || l[0] === "+").length;
    h.complete = oldSeen === h.oldCount && newSeen === h.newCount;
  }
  return hunks;
}

// The unchanged lines before each hunk and after the last one, as old line
// numbers and the offset to their new numbers; nothing after a hunk that was
// cut short. Null when the hunks do not fit together or into the old lines:
// then no line is offered rather than lines that could be the wrong ones.
function spansOf(hunks, old) {
  const last = hunks[hunks.length - 1];
  if (hunks.slice(0, -1).some((h) => !h.complete) || last.oldAfter - 1 > old.length) return null;
  const spans = [];
  for (let k = 0; k < hunks.length; k++) {
    const h = hunks[k], prev = hunks[k - 1];
    const from = prev ? prev.oldAfter : 1, newFrom = prev ? prev.newAfter : 1;
    if (h.oldBefore - from !== h.newBefore - newFrom) return null;
    spans.push({ from, to: h.oldBefore, delta: newFrom - from, end: false });
  }
  if (last.complete) spans.push({ from: last.oldAfter, to: old.length, delta: last.newAfter - last.oldAfter, end: true });
  return spans;
}

/** The diff with the old lines in `revealed` (sorted, disjoint `[from, to]`
 *  old line numbers) shown around its hunks as context lines, and the runs
 *  still hidden. Each hidden run gets one or two expanders `{ key, at, from,
 *  to, dir, above, below, first }`, drawn before output line `at`: "down"
 *  shows the lines just below the hunk above, "up" those just above the hunk
 *  below, "all" the whole run (MORE_LINES or fewer). A hunk joined to the
 *  lines above it loses its header; a header moved up keeps its hunk's
 *  function name. Without `old`, the file's old lines, nothing changes. */
export function expand(lines, old, revealed) {
  const hunks = old ? hunksOf(lines) : [];
  const spans = hunks.length ? spansOf(hunks, old) : null;
  if (!spans) return { lines, gaps: [] };
  // `nums`: each output line's old and new line number (null on a side it is
  // not on, and in place of a header); `joined`: the next line continues the
  // run above it, with no hidden line between them.
  const out = [], nums = [], heads = [], gaps = [];
  let joined = false;
  const hide = (from, to, below) => {
    if (from > to) return;
    const above = out.length > 0;
    const dirs = to - from + 1 <= MORE_LINES ? ["all"] : [above && "down", below && "up"].filter(Boolean);
    dirs.forEach((dir, i) => gaps.push({ key: `x:${dir}:${from}:${to}`, at: out.length, from, to, dir, above, below, first: i === 0 }));
    joined = false;
  };
  const head = (h) => { heads.push({ at: out.length, ...h }); out.push(null); nums.push(null); };
  // `lead`: the hunk a run that starts among revealed lines leads into.
  const reveal = (span, lead) => {
    let at = span.from;
    for (const [a, b] of revealed) {
      const s = Math.max(a, at), e = Math.min(b, span.to);
      if (s > e) continue;
      hide(at, s - 1, true);
      if (!joined) head({ lead, suffix: "", header: null });
      for (let o = s; o <= e; o++) { out.push(` ${old[o - 1]}`); nums.push([o, o + span.delta]); }
      joined = true; at = e + 1;
    }
    hide(at, span.to, !span.end);
  };
  hunks.forEach((h, k) => {
    reveal(spans[k], k);
    if (!joined) head({ lead: k, suffix: h.suffix, oldStart: h.oldStart, newStart: h.newStart, header: h.complete ? null : h.header });
    else if (heads[heads.length - 1].lead === k) heads[heads.length - 1].suffix = h.suffix;
    let o = h.oldBefore + 1, n = h.newBefore + 1;
    for (const line of h.body) {
      out.push(line);
      nums.push(line[0] === " " ? [o++, n++] : line[0] === "-" ? [o++, null] : line[0] === "+" ? [null, n++] : [null, null]);
    }
    joined = true;
  });
  if (spans.length > hunks.length) reveal(spans[hunks.length], null);

  // Each header counts the lines under it, in git's format: the count is left
  // out when it is 1, and with no line on a side the start is git's own.
  const side = (start, count, fallback) => `${count ? start : fallback}${count === 1 ? "" : `,${count}`}`;
  heads.forEach((hd, i) => {
    if (hd.header) { out[hd.at] = hd.header; return; }
    const end = i + 1 < heads.length ? heads[i + 1].at : out.length;
    let oldStart = null, newStart = null, oldCount = 0, newCount = 0;
    for (let j = hd.at + 1; j < end; j++) {
      const [o, n] = nums[j];
      if (o !== null) { if (oldStart === null) oldStart = o; oldCount++; }
      if (n !== null) { if (newStart === null) newStart = n; newCount++; }
    }
    out[hd.at] = `@@ -${side(oldStart, oldCount, hd.oldStart)} +${side(newStart, newCount, hd.newStart)} @@${hd.suffix}`;
  });
  return { lines: out, gaps };
}

/** The old lines a click on an expander shows. */
export function revealOf(gap) {
  if (gap.dir === "down") return [gap.from, Math.min(gap.to, gap.from + MORE_LINES - 1)];
  if (gap.dir === "up") return [Math.max(gap.from, gap.to - MORE_LINES + 1), gap.to];
  return [gap.from, gap.to];
}

/** `ranges` (sorted, disjoint) with `[from, to]` added; touching ones merge. */
export function addRange(ranges, [from, to]) {
  const merged = [];
  for (const [a, b] of [...ranges, [from, to]].sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}
