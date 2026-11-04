// The unchanged lines the Review panel reveals around a diff's hunks
// (`expand` in mods/commit-review/diff.js), checked on real `git diff` output:
// whatever was revealed, every row shows the file line its numbers point at.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffRows, expand, revealOf, addRange, MORE_LINES } from "../mods/commit-review/diff.js";

const dir = mkdtempSync(join(tmpdir(), "commit-review-diff-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// The person's git settings (diff.context, for one) stay out of the inputs.
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

/** git's diff of two files, from its first hunk on, as the panel's diffOf reads it. */
function gitDiff(oldLines, newLines, { newline = true, args = [] } = {}) {
  const end = newline ? "\n" : "";
  writeFileSync(join(dir, "a"), oldLines.join("\n") + end);
  writeFileSync(join(dir, "b"), newLines.join("\n") + end);
  const r = spawnSync("git", ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", ...args, "--", "a", "b"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(r.status, 1, r.stderr);
  const all = r.stdout.replace(/\n$/, "").split("\n");
  return all.slice(all.findIndex((l) => l.startsWith("@@")));
}

// Lines that start with a letter, so git names a function in each hunk header.
const numbered = (n) => Array.from({ length: n }, (_, i) => `function f${i + 1}() { return ${i + 1}; }`);
const OLD = numbered(200);
/** OLD with each old line number in `changes` changed, then two lines added after `insertAfter` and `remove` removed. */
function edited({ changes = [], insertAfter = null, remove = null }) {
  const lines = [...OLD];
  if (remove !== null) lines.splice(remove - 1, 1);
  if (insertAfter !== null) lines.splice(insertAfter, 0, "added 1", "added 2");
  for (const n of changes) lines[n - 1] = `changed ${n}`;
  return lines;
}
const FAR = edited({ changes: [50], insertAfter: 120, remove: 190 });
const CLOSE = edited({ changes: [50, 65] });
const LAST = [...OLD.slice(0, -1), "changed last"];

const FIXTURES = {
  "far apart": { new: FAR },
  "far apart, no context (-U0)": { new: FAR, args: ["-U0"] },
  "close together": { new: CLOSE },
  "last line changed, no final newline": { new: LAST, newline: false },
  "middle changed, no final newline": { new: edited({ changes: [100] }), newline: false },
};
for (const f of Object.values(FIXTURES)) f.lines = gitDiff(OLD, f.new, f);

const headerOf = (raw) => {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
  return { old: m[2] === undefined ? 1 : Number(m[2]), new: m[4] === undefined ? 1 : Number(m[4]) };
};

/** The rules every expanded diff keeps: each row shows the line its numbers
 *  point at, each header counts the rows under it, and the shown old lines
 *  plus the hidden runs are every old line exactly once. `cut`: the diff was
 *  cut inside its last hunk, which keeps git's header (counting lines that
 *  are not there) and has nothing after it. */
function check(newLines, shown, cut = false) {
  const rows = diffRows(shown.lines, null), seen = new Map();
  const count = (o) => seen.set(o, (seen.get(o) ?? 0) + 1);
  const lastHeader = rows.map((r) => r.kind).lastIndexOf("@");
  rows.forEach((r, i) => {
    if (r.kind === "@" && !(cut && i === lastHeader)) {
      const under = [];
      for (let j = i + 1; j < rows.length && rows[j].kind !== "@"; j++) under.push(rows[j]);
      assert.deepEqual(headerOf(r.raw), {
        old: under.filter((u) => u.kind === " " || u.kind === "-").length,
        new: under.filter((u) => u.kind === " " || u.kind === "+").length,
      }, `the counts of ${r.raw}`);
    }
    if (r.kind === " " || r.kind === "-") { assert.equal(r.raw, OLD[r.old - 1], `old line ${r.old}`); count(r.old); }
    if (r.kind === " " || r.kind === "+") assert.equal(r.raw, newLines[r.number - 1], `new line ${r.number}`);
  });
  const runs = new Map(shown.gaps.map((g) => [`${g.from}:${g.to}`, g]));
  for (const g of runs.values()) for (let o = g.from; o <= g.to; o++) count(o);
  for (const [o, n] of seen) assert.equal(n, 1, `old line ${o} is shown or hidden once`);
  if (!cut) for (let o = 1; o <= OLD.length; o++) assert.ok(seen.has(o), `old line ${o} is shown or hidden`);
  return rows;
}

/** Clicks expanders (`pick` chooses one) until none is left, checking every step. */
function revealAll(f, pick, cut = false) {
  let ranges = [], shown = expand(f.lines, OLD, ranges), clicks = 0;
  check(f.new, shown, cut);
  while (shown.gaps.length) {
    assert.ok(++clicks < 100, "the expanders run out");
    ranges = addRange(ranges, revealOf(pick(shown.gaps)));
    shown = expand(f.lines, OLD, ranges);
    check(f.new, shown, cut);
  }
  return shown;
}

test("a diff with nothing revealed is git's own, line for line", () => {
  for (const [name, f] of Object.entries(FIXTURES)) assert.deepEqual(expand(f.lines, OLD, []).lines, f.lines, name);
});

test("every row shows its line however the lines are revealed, until the whole file is one hunk", () => {
  const picks = { first: (g) => g[0], last: (g) => g[g.length - 1], middle: (g) => g[Math.floor(g.length / 2)] };
  for (const [name, f] of Object.entries(FIXTURES)) {
    for (const [order, pick] of Object.entries(picks)) {
      const shown = revealAll(f, pick);
      assert.equal(diffRows(shown.lines, null).filter((r) => r.kind === "@").length, 1, `${name}, ${order} first`);
    }
  }
});

test("a long hidden run shows MORE_LINES lines below the hunk above, or above the hunk below", () => {
  const f = FIXTURES["far apart"], shown = expand(f.lines, OLD, []);
  const pair = shown.gaps.filter((g) => g.above && g.below);
  assert.deepEqual(pair.map((g) => g.dir), ["down", "up", "down", "up"]);
  const [down, up] = pair, rows = diffRows(shown.lines, null);
  const header = rows[up.at].raw, suffix = header.slice(header.lastIndexOf("@@") + 2);
  assert.ok(suffix.trim(), "git named a function in the header");

  const below = expand(f.lines, OLD, addRange([], revealOf(down)));
  const belowRows = check(f.new, below), last = rows[down.at - 1];
  const at = belowRows.findIndex((r) => r.old === last.old && r.kind === last.kind);
  assert.deepEqual(belowRows.slice(at + 1, at + 1 + MORE_LINES).map((r) => [r.kind, r.old]),
    Array.from({ length: MORE_LINES }, (_, i) => [" ", down.from + i]), "the lines follow the hunk above, under no header");
  assert.ok(below.gaps.some((g) => g.from === down.from + MORE_LINES && g.to === down.to));

  const above = expand(f.lines, OLD, addRange([], revealOf(up)));
  const aboveRows = check(f.new, above), moved = aboveRows.findIndex((r) => r.old === up.to - MORE_LINES + 1) - 1;
  assert.equal(aboveRows[moved].kind, "@", "the hunk's header moved up above the revealed lines");
  assert.ok(aboveRows[moved].raw.endsWith(suffix), "and kept its function name");
  assert.ok(above.gaps.some((g) => g.from === up.from && g.to === up.to - MORE_LINES));
});

test("a short hidden run opens whole and joins the hunks around it", () => {
  const f = FIXTURES["close together"], shown = expand(f.lines, OLD, []);
  const short = shown.gaps.find((g) => g.above && g.below);
  assert.equal(short.dir, "all");
  assert.ok(short.to - short.from + 1 <= MORE_LINES);
  const headers = (s) => diffRows(s.lines, null).filter((r) => r.kind === "@").length;
  const joined = expand(f.lines, OLD, addRange([], revealOf(short)));
  check(f.new, joined);
  assert.equal(headers(joined), headers(shown) - 1);
});

test("a diff cut inside its last hunk offers nothing below that hunk", () => {
  const f = FIXTURES["far apart"], cut = { ...f, lines: f.lines.slice(0, -2) };
  const shown = expand(cut.lines, OLD, []);
  assert.deepEqual(shown.lines, cut.lines);
  assert.ok(shown.gaps.length > 0 && shown.gaps.every((g) => g.below), "no expander after the last hunk");
  revealAll(cut, (g) => g[0], true);
});

test("without the old lines nothing is revealed or offered", () => {
  const f = FIXTURES["far apart"];
  assert.deepEqual(expand(f.lines, null, [[1, 200]]), { lines: f.lines, gaps: [] });
});
