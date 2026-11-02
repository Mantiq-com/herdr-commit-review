// Diff rows for the Review panel, and where a thread sits among them.
import { tokenize } from "./highlight.js";

// `herdr-review` keeps at most this many quoted lines per thread.
const MAX_QUOTE_LINES = 60;

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
