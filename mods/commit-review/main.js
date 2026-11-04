// Commit review: work reviewed like a pull request, in threads that coding
// agents read and answer. Branch mode shows everything a branch adds since it
// left its base (merge base to tip); Commits mode shows each selected commit
// as its own diff; Uncommitted mode shows the working tree against HEAD. Every
// file has a Viewed tick, which clears itself when the file changes again.
//
// The mod is a panel of its own, or the "Review" half of a Changes panel: a
// layout column with a switch strip (this mod again, with props
// { switch: true }) above a stack VIEWS that holds Herdr's Changes panel or
// another mod (WORK) and this panel (COMMITTED). The README shows both layouts.
//
// With props { reader: true } the mod is a reader pane: only the diff of the
// file the panel has open (shared as FOLLOW), with its threads and comment
// card, for more room to read. The panel's button opens it beside the terminal.
//
// Threads are stored by the `herdr-review` command (store.js) under the
// repository's git directory. The person's comments stay pending until
// "Submit review" sends them to an agent through the send dialog (dialog.js,
// this mod opened as an overlay with props { dialog: true }); agents reply,
// resolve and open threads with the same command, and the panel shows those
// within seconds.
//
// Mod commands: "commit-review.submit", "commit-review.next" (the next file
// not viewed yet), "commit-review.mode" (the next of Branch, Commits and
// Uncommitted).
// Props: { font_size: px (default: the terminal's font size minus one),
//          base: the branch reviews compare against (default: origin/HEAD's
//          branch, else main, else master) }.
// Shared: "commit-review.request" { root, on, commits, at } shows those commits
// (another mod's "review this commit"); "commit-review.view" keeps the mode,
// branch and selected commits of each repository; "commit-review.follow" is
// the panel's open file, which the reader pane shows.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar, v_virtual_list, VirtualListScrollHandle, Popover } from "gpui-base";
import { spaces, panes, focused, theme, settings, nextCommand, props, shared, setShared, watchFolder, openOverlay, notify, knownAgents, run, layout } from "herdr";
import { languageOf } from "./highlight.js";
import { palette } from "./palette.js";
import { SendDialog } from "./dialog.js";
import { gitIn, repoOf, branchesOf, baseOf, commitsOf, commitsByHash, emptyTreeOf, headOf, filesOf, uncommittedOf, diffOf, oldLinesOf } from "./git.js";
import { loadThreads, loadViewed, addThread, reply, resolve, reopen, editComment, deleteComment, publish, setViewed, unsetViewed } from "./store.js";
import { diffRows, anchorOf, place, expand, revealOf, addRange, MORE_LINES } from "./diff.js";
import { reviewText, reviewTask, whereOf } from "./agent.js";

const VIEW = "commit-review.view", REQUEST = "commit-review.request", SENT = "commit-review.sent", FOLLOW = "commit-review.follow";
const MODES = ["branch", "commits", "uncommitted"];
const NONE = "#00000000", ICONS = "mods/commit-review";
// The ids the switch strip selects in the layout (the README's Changes
// layout). Another mod that opens this view selects COMMITTED in VIEWS too.
const VIEWS = "changes-views", WORK = "changes-work", COMMITTED = "changes-commits";
// A thread card in the diff shows its last few comments, each cut to a few
// lines, so its height stays bounded; the comment card shows the whole thread.
const CARD_COMMENTS = 3, CARD_LINES = 5, CARD_QUOTE = 3;
// A commit's message card shows this many wrapped lines until it is clicked.
const MESSAGE_LINES = 8;
// The fixed parts of a thread card's height, px: its margins, padding and
// border; one small text line; the gap between its children.
const CARD_FRAME = 24, SMALL_LINE = 15, CARD_GAP = 4;

// The folder and machine the panel reviews: those of the focused terminal,
// and that terminal's pane (the reader pane opens beside it). A focused mod
// pane (this panel opened as a pane, for one) has no folder, so the first
// terminal of its tab stands in for it.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  let pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane && !pane.terminal) pane = panes().find((p) => p.tab === pane.tab && p.terminal) ?? pane;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, pane: pane?.pane ?? null };
}
const key = () => { const { cwd, on } = location(); return JSON.stringify({ cwd, on }); };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = find(child, id); if (found) return found; }
  return null;
}

// The code font: the terminal's, one size smaller; props.font_size overrides.
const codeFont = () => (typeof settings().font === "string" && settings().font) || "JetBrains Mono";
const codeSize = () => Number(props()?.font_size) || Math.max(9, (Number(settings().font_size) || 14) - 1);
const rowOf = (size) => Math.round(size * 1.8);
const charOf = (size) => size * 0.62;

// A row's identity across reloads: its kind, line number and text.
const desc = (r) => ({ kind: r.kind, n: (r.kind === "-" ? r.old : r.number) ?? null, text: r.raw });
const descKey = (d) => `${d.kind}|${d.n}|${d.text}`;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const statusColor = (f, t) => f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : t.blocked;

// A Viewed tick stores the file's blobs before and after: the file reads
// "changed" once they differ. A commit's ticks are kept under its `change`
// (git.js), so they carry over to the commit an amend or a rebase makes.
const blobsOf = (f) => `${f.oldBlob}..${f.newBlob}`;
const commitViewKey = (commit, path) => `change:${commit.change}:${path}`;

function ago(when) {
  const seconds = Math.max(0, Date.now() / 1000 - (typeof when === "number" ? when : Date.parse(when) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 86400 * 60) return `${Math.floor(seconds / 86400)}d`;
  return `${Math.floor(seconds / 86400 / 30)}mo`;
}

const wrapped = (line, cpl) => Math.max(1, Math.ceil(line.length / cpl));

/** The text cut to at most `max` wrapped lines of `cpl` characters, and how many lines it takes. */
function clip(text, cpl, max) {
  const kept = [];
  let used = 0;
  for (const line of text.split("\n")) {
    const need = wrapped(line, cpl);
    if (used + need > max) {
      const room = max - used;
      if (room > 0) kept.push(line.slice(0, room * cpl - 1));
      return { text: `${kept.join("\n")}…`, lines: max };
    }
    kept.push(line);
    used += need;
  }
  return { text: kept.join("\n"), lines: used };
}

// An agent that gave no --author is just "agent".
const who = (c) => `${c.author}${c.role === "agent" && c.author !== "agent" ? " · agent" : ""} · ${ago(c.at)}${c.pending ? " · pending" : ""}`;

function spanOf(thread) {
  if (thread.line === null || thread.line === undefined) return "whole file";
  const lines = thread.end_line === thread.line ? `line ${thread.line}` : `lines ${thread.line}–${thread.end_line}`;
  return thread.side === "old" ? `removed ${lines}` : lines;
}

export default class Review extends View {
  init(_props, cx) {
    // Opened as the send dialog, or as the switch strip above the Changes
    // panel's two views: this copy is only that.
    if (props()?.dialog) { this.dialog = new SendDialog(); this.dialog.init(cx); return; }
    if (props()?.switch) { this.strip = true; this.shown = WORK; return; }
    // The reader follows the panel's open file and leaves key commands to the panel.
    this.reader = Boolean(props()?.reader);
    this.followAt = this.reader ? shared(FOLLOW)?.at ?? null : null;
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.fontSize = codeSize(); this.row = rowOf(this.fontSize);
    this.note = TextareaState.new({ placeholder: "Leave a comment…", rows: 3 });
    this.note.set_auto_grow(3, 12);
    // Enter saves; shift-enter is the textarea's own newline.
    this.note.on("submit", (e, cx) => { if (!e?.shift) this.saveComposer(cx); });
    this.note.on("change", (_e, cx) => { this.noteText = this.note.value(); cx.notify(); });
    this.noteText = "";
    this.gen = 0;
    this.picked = null;
    this.reset();
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    if (!this.reader) cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "submit") this.submit(cx);
        else if (c === "next") this.nextUnviewed(cx);
        else if (c === "mode") this.setMode(this.nextMode(), cx);
        cx.notify();
      }
    });
  }

  reset() {
    this.repo = null; this.on = null; this.git = null; this.error = null; this.storeError = null; this.note_ = null;
    this.branches = []; this.current = null; this.branch = null; this.base = null; this.merge = null; this.tip = null;
    this.commits = []; this.extra = []; this.emptyTree = null;
    this.mode = "branch"; this.selected = null; this.lastClicked = null; this.showCommits = false;
    this.units = []; this.threads = []; this.viewed = {}; this.seen = null; this.watched = null;
    this.open = null; this.closed = false; this.choosing = null; this.agentList = null; this.expanded = new Set();
    this.lines = null; this.linesPath = null; this.rows = []; this.index = new Map(); this.items = []; this.sizes = []; this.diffWidth = 0; this.gutter = 30;
    this.raw = null; this.gaps = []; this.oldText = null; this.revealed = new Map();
    this.composer = null; this.note?.set_value(""); this.noteText = "";
  }

  // What a load belongs to: the reader's file, or the panel's folder and machine.
  contextKey() {
    if (!this.reader) return key();
    const f = shared(FOLLOW);
    return JSON.stringify(f?.path ? [f.repo.id, f.unit.key, f.path] : null);
  }

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    const { cwd, on } = location(), context = this.contextKey();
    if (this.reader) this.context = context;
    else {
      if (context !== this.context) { this.context = context; this.reset(); }
      if (!cwd) return;
    }
    this.loading = true;
    const gen = this.gen;
    cx.spawn(async (cx) => {
      try { await (this.reader ? this.loadReader(shared(FOLLOW), context, cx) : this.load(cwd, on, context, gen, cx)); }
      catch (e) { if (this.contextKey() === context) this.error = String(e?.message ?? e); }
      finally {
        this.loading = false;
        cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  // Reads everything the panel shows. A change the person made while it ran
  // (another branch, mode or selection) makes it start over instead.
  async load(cwd, on, context, gen, cx) {
    const stale = () => key() !== context || gen !== this.gen;
    const repo = await repoOf(cwd, on);
    if (stale()) { this.again = true; return; }
    if (!repo) { this.reset(); this.error = "Not a git repository"; return; }
    const id = `${on ?? ""}:${repo.root}`, same = this.repo?.id === id, git = gitIn(repo.root, on);
    const saved = (shared(VIEW) ?? {})[id] ?? {};
    const { branches, current } = await branchesOf(git);
    if (!branches.length) { this.reset(); this.error = "This repository has no commits yet"; return; }
    const { base, ref } = await baseOf(git, typeof props()?.base === "string" ? props().base : null);

    // Git Graph's "Review commit" for this repository shows that commit alone.
    // The request is cleared only by a load that is not stale, so it is never lost.
    const request = shared(REQUEST);
    const asked = request && request.root === repo.root && (request.on ?? null) === (on ?? null) ? request.commits : null;

    let branch = same ? this.branch : saved.branch ?? current;
    if (!branches.includes(branch)) branch = current ?? branches[0];
    const { tip, merge, commits } = await commitsOf(git, branch, ref);
    const strip = new Set(commits.map((c) => c.sha));
    let mode = same ? this.mode : saved.mode ?? (merge ? "branch" : "commits");
    let selected = same ? this.selected : saved.selected ?? null;
    let extraShas = same ? this.extra.map((c) => c.sha) : [];
    if (asked) { mode = "commits"; selected = asked; extraShas = asked.filter((s) => !strip.has(s)); }
    if (mode === "branch" && !merge) mode = "commits";
    const extra = await commitsByHash(git, extraShas);
    // Listed commits that share a `change` keep their own ticks and threads.
    const changes = new Map();
    for (const c of [...extra, ...commits]) changes.set(c.change, (changes.get(c.change) ?? 0) + 1);
    for (const c of [...extra, ...commits]) if (changes.get(c.change) > 1) c.change = `${c.change} ${c.sha}`;
    const known = new Set([...strip, ...extra.map((c) => c.sha)]);
    if (selected) selected = selected.filter((s) => known.has(s));
    if (mode === "commits" && selected === null) selected = commits.length ? [commits[0].sha] : [];

    const emptyTree = same && this.emptyTree ? this.emptyTree : await emptyTreeOf(git);
    // `match`: which threads a unit shows (threadsOn). A branch also shows the
    // threads written on its commits and on its uncommitted work; a commit
    // thread matches by hash, or by `change` once the commit was amended or
    // rebased. The uncommitted unit compares the working tree (`to` null) to HEAD.
    const head = mode === "uncommitted" ? await headOf(git) : null;
    const units = mode === "uncommitted"
      ? [{ key: "uncommitted", target: { kind: "uncommitted", worktree: repo.root, branch: current, head }, from: head, to: null, label: "Uncommitted changes", match: { worktree: repo.root, commits: [], changes: [] } }]
      : mode === "branch"
      ? [{ key: "branch", target: { kind: "branch", branch, base, head: tip }, from: merge, to: tip, label: `${branch} since ${base}`, match: { branch, commits: commits.map((c) => c.sha), changes: commits.map((c) => c.change) } }]
      : [...extra, ...commits].filter((c) => selected.includes(c.sha)).map((c) => ({
        key: c.sha, commit: c, target: { kind: "commit", commit: c.sha, subject: c.subject },
        from: c.parents[0] ?? emptyTree, to: c.sha, label: `${c.short} ${c.subject}`, match: { commits: [c.sha], changes: [c.change] },
        message: { short: c.short, author: c.author, time: c.time, text: c.body ? `${c.subject}\n\n${c.body}` : c.subject },
      }));
    const lists = await Promise.all(units.map((u) => u.to === null ? uncommittedOf(git, u.from) : filesOf(git, u.from, u.to)));
    units.forEach((u, i) => { u.files = lists[i].files; u.limited = lists[i].limited; });

    let threads = same ? this.threads : [], viewed = same ? this.viewed : {}, store = null, storeError = null;
    try {
      const loaded = await loadThreads(repo.root, on);
      threads = loaded.threads; store = loaded.store;
      viewed = await loadViewed(repo.root, on);
    } catch (e) { storeError = String(e?.message ?? e); }
    if (stale()) { this.again = true; return; }

    if (!same) { this.reset(); }
    if (request) {
      setShared(REQUEST, null);
      if (!asked) this.note_ = `Git Graph asked to review a commit of ${request.root}, but this panel shows ${repo.root}`;
    }
    Object.assign(this, { repo: { ...repo, id }, on, git, branches, current, branch, base, merge, tip, commits, extra, mode, selected, units, emptyTree, viewed, storeError, error: null });
    this.setThreads(threads);
    if (asked) { this.remember(); this.open = null; this.closed = false; }
    if (store) this.watchStore(store, cx);
    if (this.open && !this.fileOf(this.open)) { this.open = null; this.setLines([]); }
    // A commit just picked opens on its first file, so its message shows at
    // once; otherwise the first unit's first file opens.
    if (!this.open && !this.closed) {
      const u = units.find((u) => u.key === this.picked && u.files.length) ?? units.find((u) => u.files.length);
      if (u) this.open = { unit: u.key, path: u.files[0].path };
    }
    this.picked = null;
    if (this.open) await this.loadDiff(context);
    else this.setLines([]);
    this.rebuild();
    this.follow();
  }

  // The reader pane's load: the file the panel has open (FOLLOW), its threads
  // and its diff, else the selected commits' messages. Another file closes a
  // new comment; a thread stays open.
  async loadReader(follow, context, cx) {
    if (!follow?.path) { this.reset(); this.units = follow?.units ?? []; this.rebuild(); return; }
    const { repo, unit, path } = follow;
    if (this.repo?.id !== repo.id) this.reset();
    const open = this.open?.unit === unit.key && this.open?.path === path ? this.open : { unit: unit.key, path };
    if (open !== this.open && this.composer && this.composer.kind !== "thread") this.closeComposer();
    Object.assign(this, { repo, on: repo.on, git: gitIn(repo.root, repo.on), units: [unit], open, closed: false, error: null });
    try {
      const loaded = await loadThreads(repo.root, repo.on);
      if (this.contextKey() !== context) { this.again = true; return; }
      this.storeError = null;
      this.setThreads(loaded.threads);
      if (loaded.store) this.watchStore(loaded.store, cx);
    } catch (e) { this.storeError = String(e?.message ?? e); }
    await this.loadDiff(context);
    this.rebuild();
  }

  // Shares the open file, and what loading it takes, with the reader pane;
  // with no file open, the selected commits' messages. Only a change is
  // shared: setShared redraws every mod.
  follow() {
    if (this.reader) return;
    const found = this.repo && this.fileOf(this.open);
    const value = found ? {
      repo: { root: this.repo.root, on: this.on, id: this.repo.id },
      unit: { key: found.unit.key, target: found.unit.target, from: found.unit.from, to: found.unit.to, label: found.unit.label, match: found.unit.match, message: found.unit.message, files: [found.file] },
      path: found.file.path,
    } : { path: null, units: this.units.filter((u) => u.message).map((u) => ({ key: u.key, message: u.message, files: [] })) };
    const text = JSON.stringify(value);
    if (text === this.followed) return;
    this.followed = text;
    setShared(FOLLOW, { ...value, at: Date.now() });
  }

  // Opens the reader pane beside the terminal the panel follows.
  openReader(cx) {
    const { pane } = location();
    if (!pane) { this.note_ = "Focus a terminal first: the reader pane opens beside it"; cx.notify(); return; }
    this.follow();
    run("pane.split", { direction: "right", pane, mod: "commit-review", props: { reader: true } });
    cx.notify();
  }

  // The store folder changes whenever anyone writes a thread: reload the
  // threads then. Only for this machine; a remote space waits for the timer.
  // `herdr-review list` names no folder until the first thread exists.
  watchStore(dir, cx) {
    if (this.on || this.watched === dir) return;
    this.watched = dir;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === dir) {
          await watchFolder(dir);
          if (this.watched === dir) await this.reloadThreads(cx);
        }
      } catch (e) {
        // The timer's next reload starts the watch again.
        console.log(`commit-review: not watching ${dir}: ${e}`);
        if (this.watched === dir) this.watched = null;
      }
    });
  }

  async reloadThreads(cx) {
    if (!this.repo) return;
    const { root, id } = this.repo, on = this.on;
    try {
      const loaded = await loadThreads(root, on);
      const viewed = await loadViewed(root, on);
      if (this.repo?.id !== id) return;
      this.viewed = viewed; this.storeError = null;
      this.setThreads(loaded.threads);
      this.watchStore(loaded.store, cx);
    } catch (e) { this.storeError = String(e?.message ?? e); }
    cx.notify();
  }

  // New threads, and a toast for each comment an agent submitted since the
  // last load. The reader leaves the toasts to the panel, so each shows once.
  setThreads(threads) {
    const ids = new Set(), fresh = [];
    for (const t of threads) for (const c of t.comments) {
      ids.add(c.id);
      if (this.seen && !this.reader && !this.seen.has(c.id) && c.role === "agent" && !c.pending) fresh.push({ t, c });
    }
    this.seen = ids;
    for (const { t, c } of fresh.slice(0, 3)) {
      notify({ title: `${c.author} commented on ${t.path.split("/").pop()}${t.line === null || t.line === undefined ? "" : `:${t.line}`}`, body: c.text.slice(0, 160), level: "info" });
    }
    this.threads = threads;
    this.rebuild();
  }

  fileOf(open) {
    const unit = open && this.units.find((u) => u.key === open.unit), file = unit?.files.find((f) => f.path === open.path);
    return file ? { unit, file } : null;
  }

  async loadDiff(context) {
    const found = this.fileOf(this.open), open = this.open;
    if (!found) return;
    let lines;
    try { lines = await diffOf(this.git, found.unit.from, found.unit.to, found.file); }
    catch (e) { lines = [`Cannot show this diff: ${e?.message ?? e}`]; }
    // git counts no lines of an untracked file: its diff does, as in Herdr's Changes panel.
    if (found.file.untracked) found.file.add = lines.filter((l) => l[0] === "+").length;
    let old = null;
    try { old = await this.oldOf(found.file); }
    catch (e) { this.note_ = `Cannot show the lines around the changes: ${e?.message ?? e}`; }
    if (this.contextKey() === context && this.open === open) this.setLines(lines, found.file.path, old);
  }

  // The open file's old lines, kept by blob so that the timer's reloads do not read them again.
  async oldOf(file) {
    if (this.oldText?.blob === file.oldBlob) return this.oldText.lines;
    const lines = await oldLinesOf(this.git, file);
    if (lines) this.oldText = { blob: file.oldBlob, lines };
    return lines;
  }

  // `old`: the file's lines before the change, which the person can reveal around the hunks.
  setLines(lines, path, old = null) {
    this.raw = { lines, path, old };
    this.showRows();
  }

  // The lines the person revealed in the open file, while its old side is the one they were revealed in.
  rangesOf() {
    const found = this.fileOf(this.open), r = found && this.revealed.get(`${this.open.unit}\0${this.open.path}`);
    return r && r.blob === found.file.oldBlob ? r.ranges : [];
  }

  // A click on an expander row shows more of the unchanged lines around the hunks.
  reveal(key, cx) {
    const gap = this.gaps.find((g) => g.key === key), found = this.fileOf(this.open);
    if (!gap || !found) return;
    this.revealed.set(`${this.open.unit}\0${this.open.path}`, { blob: found.file.oldBlob, ranges: addRange(this.rangesOf(), revealOf(gap)) });
    this.showRows();
    this.rebuild();
    cx.notify();
  }

  // The rows: git's hunks with the lines revealed around them.
  showRows() {
    const { path, old } = this.raw, shown = expand(this.raw.lines, old, this.rangesOf()), lines = shown.lines;
    this.gaps = shown.gaps;
    const same = this.lines && this.linesPath === path && lines.length === this.lines.length && lines.every((l, i) => l === this.lines[i]);
    if (same) return;
    this.lines = lines; this.linesPath = path;
    this.rows = diffRows(lines, languageOf(path));
    this.index = new Map();
    this.rows.forEach((r, i) => { const k = descKey(desc(r)); if (!this.index.has(k)) this.index.set(k, i); });
    this.measure();
  }

  // Sizes that depend on the font: the gutter (wide enough for the largest
  // line number), the diff's width, and the rows.
  measure() {
    const ch = charOf(this.fontSize), digits = String(Math.max(0, ...this.rows.map((r) => Math.max(r.number ?? 0, r.old ?? 0)))).length;
    this.gutter = Math.max(30, Math.ceil(digits * ch + 10));
    this.diffWidth = Math.max(300, ...(this.lines ?? []).map((line) => Math.ceil(line.length * ch) + this.gutter + 36));
    this.rebuild();
  }

  at(d) { return d ? (this.index.get(descKey(d)) ?? -1) : -1; }

  // The threads shown with a file of a unit, by its `match`. A branch also
  // shows the threads written on its commits, placed where their lines still are.
  threadsOn(unit, path) {
    const m = unit.match;
    return this.threads.filter((t) => {
      if (t.path !== path) return false;
      const target = t.target;
      if (target.kind === "commit") return m.commits.includes(target.commit) || m.changes.includes(target.change);
      if (target.kind === "uncommitted") return target.worktree === m.worktree || (m.branch !== undefined && target.branch === m.branch);
      return target.kind === "branch" && m.branch !== undefined && target.branch === m.branch;
    });
  }

  // The list's items: a commit's message, the threads that have no place in
  // the diff, then the diff rows, each placed thread under its last line.
  // With no file open, the message of every selected commit.
  rebuild() {
    this.items = [];
    const found = this.fileOf(this.open);
    const messageOf = (u) => ({ key: `m:${u.key}`, kind: "message", unit: u.key, message: u.message, height: this.messageHeight(u.message, this.expanded.has(u.key)) });
    if (!found) {
      this.items = this.units.filter((u) => u.message).map(messageOf);
      this.sizes = this.items.map((it) => it.height);
      return;
    }
    if (found.unit.message) this.items.push(messageOf(found.unit));
    const under = new Map(), top = [];
    for (const t of this.threadsOn(found.unit, found.file.path)) {
      const at = place(t, this.rows), unplaced = !at && t.line !== null && t.line !== undefined;
      const it = { key: `t:${t.id}`, kind: "thread", id: t.id, unplaced, at, height: this.cardHeight(t, unplaced) };
      if (at) (under.get(at.to) ?? under.set(at.to, []).get(at.to)).push(it);
      else top.push(it);
    }
    this.items.push(...top);
    // An expander row sits where its hidden lines are: before row `at`, after the thread cards of the row above.
    const gapsAt = new Map();
    for (const g of this.gaps) (gapsAt.get(g.at) ?? gapsAt.set(g.at, []).get(g.at)).push({ key: g.key, kind: "gap", gap: g, height: this.row });
    this.rows.forEach((_r, i) => {
      for (const it of gapsAt.get(i) ?? []) this.items.push(it);
      this.items.push({ key: `r:${i}`, kind: "row", i, height: this.row });
      for (const it of under.get(i) ?? []) this.items.push(it);
    });
    for (const it of gapsAt.get(this.rows.length) ?? []) this.items.push(it);
    this.sizes = this.items.map((it) => it.height);
  }

  cpl() { return Math.max(24, Math.floor(((this.size?.width ?? 368) - 90) / charOf(this.fontSize))); }
  lineHeight() { return Math.round(this.fontSize * 1.45); }

  cardHeight(t, unplaced) {
    const shown = t.comments.slice(-CARD_COMMENTS), hidden = t.comments.length - shown.length;
    let h = CARD_FRAME + SMALL_LINE;
    if (unplaced && t.quote) h += CARD_GAP + Math.min(CARD_QUOTE, t.quote.split("\n").length) * SMALL_LINE;
    if (hidden) h += CARD_GAP + SMALL_LINE;
    for (const c of shown) h += CARD_GAP + SMALL_LINE + clip(c.text, this.cpl(), CARD_LINES).lines * this.lineHeight();
    return h;
  }

  messageHeight(message, open) {
    return CARD_FRAME + SMALL_LINE + CARD_GAP + clip(message.text, this.cpl(), open ? Infinity : MESSAGE_LINES).lines * this.lineHeight();
  }

  // A click on a long message shows all of it, or cuts it again; the choice
  // holds for the commit's other files.
  toggleMessage(unitKey, cx) {
    if (this.expanded.has(unitKey)) this.expanded.delete(unitKey);
    else this.expanded.add(unitKey);
    this.rebuild();
    cx.notify();
  }

  // The composer's lines in the current diff, or null.
  target() {
    const c = this.composer;
    if (!c || c.kind !== "line" || c.unit !== this.open?.unit || c.path !== this.open?.path) return null;
    const from = this.at(c.from), to = this.at(c.to);
    return from < 0 || to < 0 ? null : { from: Math.min(from, to), to: Math.max(from, to) };
  }

  // A click on a diff row opens a new comment there, or widens the chosen lines.
  clickRow(i, cx) {
    const row = this.rows[i];
    if (!row || row.kind === "" || !this.open) return;
    let from = i, to = i;
    if (row.kind === "@") {
      const members = this.rows.map((_r, j) => j).filter((j) => j !== i && this.rows[j].hunk === i && this.rows[j].kind !== "");
      if (!members.length) return;
      from = members[0]; to = members[members.length - 1];
    }
    const t = this.target();
    if (t && !this.noteText.trim()) {
      // A click inside the chosen lines clears them; outside, it widens them.
      if (from >= t.from && to <= t.to) { this.closeComposer(cx); return; }
      from = Math.min(t.from, from); to = Math.max(t.to, to);
    }
    if (this.composer?.kind === "thread") { this.note.set_value(""); this.noteText = ""; }
    this.composer = { kind: "line", unit: this.open.unit, path: this.open.path, from: desc(this.rows[from]), to: desc(this.rows[to]) };
    this.openBox(cx);
  }

  commentFile(unit, path, cx) {
    if (this.open?.unit !== unit.key || this.open?.path !== path) this.show(unit.key, path, cx);
    if (this.composer?.kind === "thread") { this.note.set_value(""); this.noteText = ""; }
    this.composer = { kind: "file", unit: unit.key, path };
    this.openBox(cx);
  }

  openThread(id, cx) {
    if (this.composer?.kind === "thread" && this.composer.id === id) return;
    this.note.set_value(""); this.noteText = "";
    this.composer = { kind: "thread", id, editing: null };
    this.openBox(cx);
  }

  editPending(comment, cx) {
    this.composer = { ...this.composer, editing: comment.id };
    this.note.set_value(comment.text); this.noteText = comment.text;
    this.openBox(cx);
  }

  // Gives the textarea the keyboard (again once the frame is drawn).
  openBox(cx) {
    this.rebuild();
    this.note.focus();
    cx.timer.after(300, () => this.note.focus());
    cx.notify();
  }

  closeComposer(cx) {
    this.composer = null; this.note.set_value(""); this.noteText = ""; this.rebuild(); this.handle.focus();
    cx?.notify();
  }

  saveComposer(cx) {
    const c = this.composer, text = this.note.value().trim();
    if (!c || !text || this.saving || !this.repo) return;
    const { root } = this.repo, on = this.on;
    let job;
    if (c.kind === "thread") {
      job = c.editing ? () => editComment(root, on, c.id, c.editing, text) : () => reply(root, on, c.id, text);
    } else {
      const unit = this.units.find((u) => u.key === c.unit);
      if (!unit) { this.note_ = "That commit is no longer shown"; cx.notify(); return; }
      let where = { line: null };
      if (c.kind === "line") {
        const t = this.target(), anchor = t && anchorOf(this.rows, t.from, t.to);
        if (!anchor) { this.note_ = "Those lines are no longer in the diff"; cx.notify(); return; }
        where = anchor;
      }
      job = () => addThread(root, on, { target: unit.target, path: c.path, ...where, text });
    }
    this.saving = true; this.note_ = null;
    cx.spawn(async (cx) => {
      try {
        await job();
        this.note.set_value(""); this.noteText = "";
        if (c.kind === "thread") this.composer = { ...c, editing: null };
        else this.composer = null;
        await this.reloadThreads(cx);
      } catch (e) { this.note_ = `Not saved: ${e?.message ?? e}`; }
      finally { this.saving = false; this.rebuild(); cx.notify(); }
    });
    cx.notify();
  }

  // Runs a store change, then reloads the threads; `after` runs once it worked.
  act(job, cx, after) {
    cx.spawn(async (cx) => {
      try { await job(); after?.(); await this.reloadThreads(cx); }
      catch (e) { this.note_ = String(e?.message ?? e); }
      cx.notify();
    });
  }

  viewKey(unit, f) {
    const target = unit.target;
    if (target.kind === "commit") return commitViewKey(unit.commit, f.path);
    return target.kind === "uncommitted" ? `uncommitted:${target.worktree}:${f.path}` : `branch:${target.branch}:${f.path}`;
  }
  viewState(unit, f) { return this.stateOf(this.viewKey(unit, f), blobsOf(f)); }
  stateOf(key, blobs) {
    const v = this.viewed[key];
    return v === undefined ? "no" : v === blobs ? "yes" : "changed";
  }

  // A commit's review progress, from its files' ticks in Commits mode:
  // "changed" when a file viewed before an amend or rebase differs now,
  // "reviewed" when every file is viewed, "partial" when some are.
  commitState(c) {
    let viewed = 0, changed = 0;
    for (const f of c.files) {
      const state = this.stateOf(commitViewKey(c, f.path), blobsOf(f));
      if (state === "yes") viewed++;
      else if (state === "changed") changed++;
    }
    const state = changed ? "changed" : c.files.length && viewed === c.files.length ? "reviewed" : viewed ? "partial" : "none";
    return { state, viewed, total: c.files.length };
  }

  progressMark(p, id, t) {
    if (p.state === "changed") return div().id(id).flex_none().text_size(10).text_color(t.blocked).tooltip("A file you viewed is different now: the commit was amended or rebased").child("changed");
    if (p.state === "partial") return div().id(id).flex_none().text_size(10.5).text_color(t.dim).tooltip(`In review: ${p.viewed} of ${plural(p.total, "file")} viewed`).child(`${p.viewed}/${p.total}`);
    return div().id(id).flex_none().tooltip("Reviewed: every file viewed").child(svg(`${ICONS}/check.svg`).size(12).text_color(t.ansi2));
  }

  toggleViewed(unit, f, cx) {
    if (!this.repo) return;
    const k = this.viewKey(unit, f), on = this.viewState(unit, f) !== "yes", value = blobsOf(f);
    const { root } = this.repo, where = this.on;
    if (on) this.viewed = { ...this.viewed, [k]: value };
    else { const { [k]: _gone, ...rest } = this.viewed; this.viewed = rest; }
    if (on && this.open?.unit === unit.key && this.open?.path === f.path) this.nextUnviewed(cx);
    this.act(() => on ? setViewed(root, where, k, value) : unsetViewed(root, where, k), cx);
    cx.notify();
  }

  nextUnviewed(cx) {
    const all = this.units.flatMap((u) => u.files.map((f) => ({ u, f })));
    const at = all.findIndex(({ u, f }) => this.open?.unit === u.key && this.open?.path === f.path);
    for (let k = 1; k <= all.length; k++) {
      const { u, f } = all[(at + k + all.length) % all.length];
      if (this.viewState(u, f) !== "yes") { this.show(u.key, f.path, cx); return; }
    }
  }

  // Shows a file's diff; `pick` is the file list's click, which also hides it again.
  show(unitKey, path, cx) {
    this.open = { unit: unitKey, path }; this.closed = false; this.note_ = null; this.setLines([]);
    if (this.composer && this.composer.kind !== "thread") this.closeComposer();
    this.rebuild();
    this.follow();
    const context = this.context;
    cx.spawn(async (cx) => { await this.loadDiff(context); this.rebuild(); cx.notify(); });
    cx.notify();
  }

  pick(unitKey, path, cx) {
    if (this.open?.unit === unitKey && this.open?.path === path) {
      this.open = null; this.closed = true; this.setLines([]); this.rebuild(); this.follow(); cx.notify();
    } else this.show(unitKey, path, cx);
  }

  remember() {
    if (!this.repo) return;
    const all = { ...(shared(VIEW) ?? {}) };
    all[this.repo.id] = { mode: this.mode, branch: this.branch, selected: this.selected };
    setShared(VIEW, all);
  }

  // A change of what is reviewed: the next load starts from it.
  changed(cx) {
    this.gen++; this.remember();
    this.open = null; this.closed = false; this.setLines([]); this.units = [];
    if (this.composer?.kind !== "thread") this.closeComposer();
    this.rebuild();
    this.follow();
    this.refresh(cx); cx.notify();
  }

  // The mode after this one; Branch only when the branch has commits of its own.
  nextMode() {
    const modes = MODES.filter((m) => m !== "branch" || this.merge);
    return modes[(modes.indexOf(this.mode) + 1) % modes.length];
  }

  setMode(mode, cx) {
    if (!this.repo || mode === this.mode) return;
    if (mode === "branch" && !this.merge) { this.note_ = `${this.branch} has no commits of its own since ${this.base ?? "its base"}`; cx.notify(); return; }
    this.mode = mode;
    this.changed(cx);
  }

  setBranch(branch, cx) {
    this.choosing = null;
    if (branch === this.branch) { cx.notify(); return; }
    this.branch = branch; this.selected = null; this.extra = []; this.showCommits = false;
    this.changed(cx);
  }

  toggleCommit(sha, shift, cx) {
    const order = this.commits.map((c) => c.sha), selected = new Set(this.selected ?? []);
    if (shift && this.lastClicked && order.includes(this.lastClicked) && order.includes(sha)) {
      const [a, b] = [order.indexOf(this.lastClicked), order.indexOf(sha)].sort((x, y) => x - y);
      for (let i = a; i <= b; i++) selected.add(order[i]);
    } else if (selected.has(sha)) selected.delete(sha);
    else selected.add(sha);
    this.lastClicked = sha;
    this.picked = selected.has(sha) ? sha : null;
    this.selected = [...selected];
    this.changed(cx);
  }

  // A commit clicked in Branch mode's list: review that commit alone.
  reviewOnly(sha, cx) {
    this.mode = "commits"; this.selected = [sha]; this.lastClicked = sha; this.picked = sha;
    this.changed(cx);
  }

  // Sends threads to an agent through the send dialog. Their pending comments
  // are submitted once the dialog reports the text sent (`SENT`).
  send(threads, title, cx) {
    if (!this.repo || !threads.length) return;
    const text = reviewText({ root: this.repo.root, on: this.on, threads });
    this.sending = { at: Date.now(), ids: threads.map((t) => t.id), root: this.repo.root, on: this.on };
    try { openOverlay({ mod: "commit-review", kind: "dialog", width: 680, height: 560, props: { dialog: true, title, text, sent: SENT } }); }
    catch (e) { this.sending = null; this.note_ = `The send dialog did not open: ${e}`; }
    cx.notify();
  }

  submit(cx) {
    const threads = this.threads.filter((t) => t.comments.some((c) => c.pending));
    const n = threads.reduce((sum, t) => sum + t.comments.filter((c) => c.pending).length, 0);
    this.send(threads, `Review · ${plural(n, "comment")}`, cx);
  }

  published(sending, cx) {
    this.act(() => publish(sending.root, sending.on, sending.ids), cx);
  }

  openAgents(open, cx) {
    this.choosing = open ? "agents" : null;
    if (open) {
      this.agentList = null;
      cx.spawn(async (cx) => {
        try { this.agentList = (await knownAgents({ on: this.on })).filter((a) => a.installed); }
        catch (e) { this.agentList = []; this.note_ = `Could not list the agents: ${e?.message ?? e}`; }
        cx.notify();
      });
    }
    cx.notify();
  }

  // Starts an agent in a new tab, told to review what the panel shows and to leave its findings as threads.
  startReview(agent, cx) {
    this.choosing = null;
    const f = focused(), commits = this.units.filter((u) => u.commit).map((u) => u.commit);
    if (!f?.space || !this.repo) { this.note_ = "No space is shown"; cx.notify(); return; }
    if (this.mode === "commits" && !commits.length) { this.note_ = "Select the commits to review first"; cx.notify(); return; }
    const task = reviewTask({ root: this.repo.root, on: this.on, mode: this.mode, branch: this.branch, base: this.base, merge: this.merge, commits });
    const name = this.mode === "branch" ? `Review ${this.branch}` : this.mode === "uncommitted" ? "Review uncommitted" : `Review ${commits.map((c) => c.short).join(" ")}`;
    run("tab.new", { space: f.space, name: name.slice(0, 40), folder: this.repo.root, argv: agent.run, task });
    cx.notify();
  }

  // Focuses the agent that wrote a comment, when its terminal still runs.
  focusAgent(c) {
    if (!c.terminal) return;
    run("agent.focus", { terminal: this.on ? `${this.on}/${c.terminal}` : c.terminal });
  }

  // A tick box, drawn: Checkbox is unstyled. `changed`: ticked once, changed since.
  tick(on, t, changed = false) {
    return div().size(14).flex_none().rounded(4).border_1().flex().items_center().justify_center()
      .border_color(on ? t.accent : changed ? t.blocked : t.input).bg(on ? t.accent : NONE)
      .when(on, (e) => e.child(svg(`${ICONS}/check.svg`).size(10).text_color(t.accent_foreground)));
  }

  badge(count, t) {
    return div().h(16).min_w(16).px(4).flex().items_center().justify_center().rounded(4).bg(t.accent + "33").text_size(10).text_color(t.foreground).child(String(count));
  }

  modeSwitch(t) {
    const pill = (mode, label, ok) => div().id(`mode-${mode}`).h(22).px(9).flex().items_center().rounded(5).text_size(12)
      .bg(this.mode === mode ? t.selected : NONE).text_color(this.mode === mode ? t.foreground : t.muted)
      .when(ok, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.setMode(mode, cx)))
      .when(!ok, (e) => e.opacity(0.5).tooltip(`${this.branch} has nothing of its own since ${this.base ?? "its base"}`))
      .child(label);
    return h_flex().h(26).p(2).gap(2).items_center().rounded(7).border_1().border_color(t.border).bg(t.raised)
      .child(pill("branch", "Branch", Boolean(this.merge))).child(pill("commits", "Commits", true)).child(pill("uncommitted", "Uncommitted", true));
  }

  branchPicker(t) {
    const box = h_flex().id("branch-box").h(26).max_w(220).px(8).gap(6).items_center().rounded(6).border_1().border_color(this.choosing === "branch" ? t.accent : t.border).bg(t.raised)
      .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("The branch whose commits are reviewed")
      .child(div().min_w(0).truncate().text_size(12).child(this.branch ?? "")).child(svg(`${ICONS}/chevron-down.svg`).size(11).flex_none().text_color(t.dim));
    return Popover.new("branch").open(this.choosing === "branch").on_open_change((open, cx) => { this.choosing = open ? "branch" : null; cx.notify(); })
      .trigger(box)
      .content(v_flex().id("branch-list").mt(4).min_w(220).max_h(320).overflow_y_scrollbar().p(4).gap(1).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_md()
        .children(this.branches.map((b) => h_flex().id(`branch-${b}`).h(26).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.setBranch(b, cx))
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(b))
          .when(b === this.current, (e) => e.child(div().text_size(10.5).text_color(t.dim).child("checked out")))
          .when(b === this.base, (e) => e.child(div().text_size(10.5).text_color(t.dim).child("base")))
          .child(b === this.branch ? svg(`${ICONS}/check.svg`).size(12).text_color(t.accent) : div().w(12)))));
  }

  agentPicker(t) {
    const box = h_flex().id("ask-box").h(26).px(9).gap(6).items_center().rounded(6).border_1().border_color(this.choosing === "agents" ? t.accent : t.border).bg(t.raised)
      .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Start an agent in a new tab that reviews what is shown here and leaves its findings as threads")
      .child(div().text_size(12).child("Ask agent")).child(svg(`${ICONS}/chevron-down.svg`).size(11).text_color(t.dim));
    const list = this.agentList;
    return Popover.new("agents").open(this.choosing === "agents").on_open_change((open, cx) => this.openAgents(open, cx))
      .trigger(box)
      .content(v_flex().id("agent-list").mt(4).min_w(240).max_h(320).overflow_y_scrollbar().p(4).gap(1).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_md()
        .child(div().px(8).py(4).text_size(11).text_color(t.dim).child(this.mode === "branch" ? `Review ${this.branch} with…`
          : this.mode === "uncommitted" ? "Review the uncommitted changes with…" : `Review ${plural(this.units.length, "commit")} with…`))
        .when(list === null, (e) => e.child(div().px(8).py(6).text_size(12).text_color(t.dim).child("Looking for agents…")))
        .when(Array.isArray(list) && !list.length, (e) => e.child(div().px(8).py(6).text_size(12).text_color(t.dim).child("No agent is installed here")))
        .children((list ?? []).map((a) => h_flex().id(`agent-${a.key}`).h(28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.startReview(a, cx))
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(a.name)))));
  }

  commitStrip(t) {
    if (this.mode === "uncommitted") {
      const head = this.units[0]?.target.head;
      return h_flex().h(28).flex_none().px(12).items_center().border_b(1).border_color(t.border).text_size(11.5).text_color(t.muted)
        .child(div().min_w(0).truncate().child(`Uncommitted changes on ${this.current ?? "a detached HEAD"}${head ? ` · against HEAD ${head.slice(0, 7)}` : ""}`));
    }
    const selecting = this.mode === "commits", list = [...this.extra.map((c) => ({ ...c, extra: true })), ...this.commits];
    const count = (this.selected ?? []).length, reviewed = list.filter((c) => this.commitState(c).state === "reviewed").length;
    const link = (id, label, action) => div().id(id).px(6).rounded(4).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action).child(label);
    const head = h_flex().id("commits-head").h(28).flex_none().px(12).gap(8).items_center().text_size(11.5).text_color(t.muted)
      .when(!selecting, (e) => e.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.showCommits = !this.showCommits; cx.notify(); })
        .child(div().min_w(0).truncate().child(this.merge ? `${plural(this.commits.length, "commit")} on ${this.branch} since ${this.base} · merge base ${this.merge.slice(0, 7)}` : `${this.branch} is the base branch`))
        .child(svg(`${ICONS}/chevron-down.svg`).size(10).flex_none()))
      .when(selecting, (e) => e.child(div().flex_none().child(`${count} of ${plural(list.length, "commit")} selected${reviewed ? ` · ${reviewed} reviewed` : ""}`))
        .child(div().min_w(0).truncate().text_color(t.dim).child("shift-click: a range"))
        .child(div().flex_1())
        .child(link("select-all", "All", (_e, cx) => { this.selected = list.map((c) => c.sha); this.changed(cx); }))
        .child(link("select-none", "None", (_e, cx) => { this.selected = []; this.changed(cx); })));
    return v_flex().flex_none().border_b(1).border_color(t.border).child(head)
      .when((selecting || this.showCommits) && list.length > 0, (e) => e.child(v_flex().id("commits-list").flex_none().h(Math.min(160, list.length * 26 + 6)).overflow_y_scrollbar().px(6).pb(6)
        .children(list.map((c) => this.commitRow(c, t, selecting)))));
  }

  commitRow(c, t, selecting) {
    const on = selecting && (this.selected ?? []).includes(c.sha), progress = this.commitState(c);
    const open = this.threads.filter((th) => th.target.kind === "commit" && (th.target.commit === c.sha || th.target.change === c.change) && th.status === "open").length;
    return h_flex().id(`commit-${c.sha}`).h(26).flex_none().px(6).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).when(on, (e) => e.bg(t.selected))
      .tooltip(selecting ? `${c.subject}\n${c.author}` : "Review this commit alone")
      .on_click((e, cx) => selecting ? this.toggleCommit(c.sha, Boolean(e?.modifiers?.shift), cx) : this.reviewOnly(c.sha, cx))
      .when(selecting, (e) => e.child(this.tick(on, t)))
      .child(div().min_w(56).flex_none().font_family(codeFont()).text_size(11).text_color(t.dim).child(c.short))
      .child(div().flex_1().min_w(0).truncate().text_size(12).when(progress.state === "reviewed", (e) => e.opacity(0.5)).child(c.subject))
      .when(Boolean(c.extra), (e) => e.child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).child(`not on ${this.branch}`)))
      .when(progress.state !== "none", (e) => e.child(this.progressMark(progress, `progress-${c.sha}`, t)))
      .when(open > 0, (e) => e.child(this.badge(open, t)))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(ago(c.time)));
  }

  fileRow(unit, f, t) {
    const parts = f.path.split("/"), name = parts.pop(), state = this.viewState(unit, f);
    const open = this.open?.unit === unit.key && this.open?.path === f.path, id = `${unit.key}-${f.path}`;
    const threads = this.threadsOn(unit, f.path), openCount = threads.filter((th) => th.status === "open").length;
    return h_flex().id(`file-${id}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(open, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.pick(unit.key, f.path, cx))
      .child(div().id(`viewed-${id}`).flex_none().tooltip(state === "yes" ? "Viewed · click to unmark" : state === "changed" ? "Changed since you viewed it · click to mark it viewed again" : "Mark as viewed")
        .on_click((_e, cx) => { cx.stop_propagation(); this.toggleViewed(unit, f, cx); }).child(this.tick(state === "yes", t, state === "changed")))
      .child(div().w(12).flex_none().text_size(11).text_color(statusColor(f, t)).child(f.status))
      .child(h_flex().flex_1().min_w(0).when(state === "yes", (e) => e.opacity(0.5))
        .child(div().text_color(t.dim).truncate().child(parts.length ? `${parts.join("/")}/` : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(state === "changed", (e) => e.child(div().flex_none().text_size(10).text_color(t.blocked).child("changed")))
      // One speech bubble: the open thread count, and a click comments on the whole file.
      .child(h_flex().id(`comment-file-${id}`).h(18).min_w(18).px(openCount ? 5 : 0).gap(3).flex_none().items_center().justify_center().rounded(4).cursor_pointer()
        .when(openCount > 0, (e) => e.bg(t.accent + "33").text_size(10).text_color(t.foreground))
        .when(!openCount, (e) => e.text_color(t.muted))
        .hover((s) => s.bg(openCount ? t.accent + "55" : t.hover).text_color(t.foreground))
        .tooltip(openCount ? `${plural(openCount, "open thread")} · click to comment on the whole file` : "Comment on the whole file")
        .on_click((_e, cx) => { cx.stop_propagation(); this.commentFile(unit, f.path, cx); })
        .when(openCount > 0, (e) => e.child(String(openCount))).child(svg(`${ICONS}/comment.svg`).size(openCount ? 10 : 12)))
      .when(f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  fileList(t) {
    const several = this.units.length > 1, rows = [];
    for (const u of this.units) {
      if (several) {
        const progress = this.commitState(u.commit);
        rows.push(h_flex().id(`unit-${u.key}`).h(24).flex_none().px(8).pt(4).gap(8).items_center().text_size(11)
          .child(div().flex_none().font_family(codeFont()).text_color(t.dim).child(u.commit.short))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(u.commit.subject))
          .when(progress.state !== "none", (e) => e.child(this.progressMark(progress, `unit-progress-${u.key}`, t))));
      }
      for (const f of u.files) rows.push(this.fileRow(u, f, t));
      if (u.limited) rows.push(div().px(8).py(2).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files"));
    }
    const empty = this.error || (this.loading && !this.repo ? "Loading…" : !this.repo ? "No folder"
      : this.mode === "commits" && !(this.selected ?? []).length ? "Select the commits to review above"
      : this.mode === "uncommitted" ? "No uncommitted changes" : "No changes");
    return v_flex().id("review-files").flex_none().h(Math.min(220, Math.max(40, rows.length * 28 + 12))).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border)
      .children(rows).when(!rows.length, (e) => e.child(div().p(8).text_color(t.dim).child(empty)));
  }

  threadCard(it, t) {
    const th = this.threads.find((x) => x.id === it.id);
    if (!th) return div().w_full().h(it.height);
    const shown = th.comments.slice(-CARD_COMMENTS), hidden = th.comments.length - shown.length, resolved = th.status === "resolved";
    const active = this.composer?.kind === "thread" && this.composer.id === th.id, cpl = this.cpl();
    const label = `${spanOf(th)}${th.target.kind === "commit" && this.mode === "branch" ? ` · on ${th.target.commit.slice(0, 7)}` : ""}${it.unplaced ? " · not in this diff" : ""} · ${th.status} · click to open`;
    return div().w_full().h(it.height).flex_none().pl(42).pr(12).py(4).cursor_pointer()
      .child(v_flex().max_w((this.size?.width ?? 368) - 60).h_full().overflow_hidden().rounded(8).border_1().px(10).py(6).gap(CARD_GAP).bg(t.surface)
        .border_color(active ? t.accent : resolved ? t.border : t.accent + "66").when(resolved, (e) => e.opacity(0.7))
        .child(div().h(SMALL_LINE).flex_none().truncate().text_size(10).text_color(active ? t.accent : t.dim).child(label))
        .when(it.unplaced && Boolean(th.quote), (e) => e.child(v_flex().flex_none().font_family(codeFont()).text_size(10.5).text_color(t.dim)
          .children(th.quote.split("\n").slice(0, CARD_QUOTE).map((l, i) => div().h(SMALL_LINE).truncate().child(`${String(th.line + i).padStart(5)} | ${l}`)))))
        .when(hidden > 0, (e) => e.child(div().h(SMALL_LINE).flex_none().text_size(10).text_color(t.dim).child(`${plural(hidden, "earlier comment")}`)))
        .children(shown.map((c) => v_flex().flex_none()
          .child(div().h(SMALL_LINE).truncate().text_size(10).text_color(c.role === "agent" ? t.accent : t.muted).child(who(c)))
          .child(div().text_size(this.fontSize).line_height(`${this.lineHeight()}px`).whitespace_normal().text_color(t.foreground).child(clip(c.text, cpl, CARD_LINES).text)))));
  }

  // The commit's whole message above its diff, cut to MESSAGE_LINES until clicked.
  messageCard(it, t) {
    const m = it.message, open = this.expanded.has(it.unit), cpl = this.cpl();
    const all = clip(m.text, cpl, Infinity).lines, long = all > MESSAGE_LINES;
    const hint = !long ? "" : open ? " · click to show less" : ` · ${plural(all - MESSAGE_LINES, "more line")} · click to show all`;
    return div().w_full().h(it.height).flex_none().pl(42).pr(12).py(4).when(long, (e) => e.cursor_pointer())
      .child(v_flex().max_w((this.size?.width ?? 368) - 60).h_full().overflow_hidden().rounded(8).border_1().border_color(t.border).px(10).py(6).gap(CARD_GAP).bg(t.surface)
        .child(div().h(SMALL_LINE).flex_none().truncate().text_size(10).text_color(t.dim).child(`commit ${m.short} · ${m.author} · ${ago(m.time)}${hint}`))
        .child(div().text_size(this.fontSize).line_height(`${this.lineHeight()}px`).whitespace_normal().text_color(t.foreground).child(clip(m.text, cpl, open ? Infinity : MESSAGE_LINES).text)));
  }

  // An expander row, drawn like a hunk header: ↓ shows the lines below the
  // hunk above, ↑ those above the hunk below, and a short run opens whole.
  gapRow(it, t) {
    const g = it.gap, hidden = g.to - g.from + 1;
    const sign = g.dir === "down" ? "↓" : g.dir === "up" ? "↑" : g.above && g.below ? "↕" : g.below ? "↑" : "↓";
    const label = g.dir === "all" ? `Show ${plural(hidden, "hidden line")}` : `Show ${MORE_LINES} more lines${g.first ? ` · ${hidden} hidden` : ""}`;
    return h_flex().w_full().h(this.row).flex_none().items_center().cursor_pointer().bg(t.raised).border_l(2).border_color(NONE).text_color(t.dim)
      .child(div().w(this.gutter + 16).flex_none().text_center().child(sign))
      .child(div().flex_1().min_w(0).truncate().child(label));
  }

  item(it, t, colors, target, marked) {
    if (it.kind === "message") return this.messageCard(it, t);
    if (it.kind === "thread") return this.threadCard(it, t);
    if (it.kind === "gap") return this.gapRow(it, t);
    const row = this.rows[it.i], i = it.i, on = target && i >= target.from && i <= target.to;
    if (row.kind === "@") {
      return h_flex().w_full().h(this.row).flex_none().items_center().cursor_pointer().bg(t.raised).border_l(2).border_color(on ? t.accent : NONE)
        .child(div().w(this.gutter + 16).flex_none()).child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(row.spans[0].text));
    }
    // Added and removed rows get a tint (stronger when chosen), a colored sign and a tinted gutter, like a GitHub diff.
    const tint = row.kind === "+" ? colors.added : row.kind === "-" ? colors.removed : null, number = row.kind === "-" ? row.old : row.number;
    return h_flex().w_full().h(this.row).flex_none().cursor_pointer().border_l(2).border_color(on ? t.accent : marked.has(i) ? t.accent + "66" : NONE)
      .when(Boolean(tint), (e) => e.bg(tint + (on ? "5c" : "30")))
      .when(!tint && on, (e) => e.bg(t.selected))
      .child(div().w(this.gutter).flex_none().text_right().pr(4).when(Boolean(tint), (e) => e.bg(tint + "26")).text_color(on ? t.foreground : tint ? t.foreground + "cc" : t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(16).flex_none().text_center().font_bold().text_color(tint ?? NONE).child(row.kind === "+" ? "+" : row.kind === "-" ? "−" : " "))
      .child(h_flex().flex_1().min_w(0).whitespace_nowrap().children(row.spans.map((s) => s.cls ? div().text_color(colors[s.cls] ?? t.foreground).child(s.text) : div().child(s.text))));
  }

  // A panel under 600px has no room for the comment card over the diff.
  narrow() { return (this.size?.width ?? 368) < 600; }

  // The comment card: a new comment on lines or a file, or a whole thread
  // with its reply box. A list row may hold no input, so the card floats over
  // the diff (a strip under it on a narrow panel) instead of sitting in it.
  composerCard(t, target, docked) {
    const c = this.composer, th = c.kind === "thread" ? this.threads.find((x) => x.id === c.id) : null;
    if ((c.kind === "thread" && !th) || !this.repo) return div();
    const stop = (action) => (e, cx) => { cx.stop_propagation(); action(e, cx); };
    const button = (id, label, primary, action, tip) => div().id(id).h(26).px(10).flex().items_center().rounded(6).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).text_size(11).font_medium().cursor_pointer().hover((s) => s.opacity(0.88)).on_click(stop(action)).tooltip(tip).child(label);
    const link = (id, label, color, action, tip) => div().id(id).h(26).px(7).flex().items_center().rounded(6).text_size(11).text_color(color).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(stop(action)).tooltip(tip).child(label);
    const { root } = this.repo, on = this.on;
    let title, where;
    if (th) { title = `Thread · ${th.status}`; where = whereOf(th); }
    else {
      title = "New comment";
      const name = c.path.split("/").pop();
      where = c.kind === "file" ? `${name} · whole file` : !target ? "those lines are no longer in the diff"
        : (() => { const a = anchorOf(this.rows, target.from, target.to); return a ? `${name} · ${spanOf({ line: a.line, end_line: a.endLine, side: a.side })}` : name; })();
    }
    const primary = th ? (c.editing ? "Save" : "Reply") : "Add comment";
    return v_flex().id("comment-card").flex_none().gap(8).p(10).text_size(12)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_mouse_up("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => cx.stop_propagation())
      .when(!docked, (e) => e.absolute().top(12).right(14).w(340).rounded(10).border_1().border_color(t.border).bg(t.surface + "f2").shadow_lg())
      .when(docked, (e) => e.w_full().bg(t.surface).border_t(1).border_color(t.border))
      .child(h_flex().items_center().gap(6)
        .child(div().font_semibold().child(title))
        .child(div().flex_1())
        .child(div().id("card-close").size(20).flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(stop((_e, cx) => this.closeComposer(cx))).tooltip("Close (Esc)").child("×")))
      .child(div().text_size(11).text_color(t.dim).whitespace_normal().child(where))
      .when(Boolean(th), (e) => e.child(v_flex().id("thread-comments").max_h(260).overflow_y_scrollbar().gap(6)
        .when(th.line !== null && th.line !== undefined && Boolean(th.quote), (e) => e.child(v_flex().p(6).rounded(6).bg(t.background).font_family(codeFont()).text_size(10.5).text_color(t.dim)
          .children(th.quote.split("\n").slice(0, 8).map((l, i) => div().truncate().child(`${String(th.line + i).padStart(5)} | ${l}`)))))
        .children(th.comments.map((cm) => {
          const mine = cm.pending && cm.role === "person";
          return v_flex().id(`cm-${cm.id}`).flex_none().gap(2).p(6).rounded(6).bg(c.editing === cm.id ? t.selected : t.raised)
            .child(h_flex().gap(6).items_center()
              .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(cm.role === "agent" ? t.accent : t.muted).child(who(cm)))
              .when(cm.role === "agent" && Boolean(cm.terminal), (e) => e.child(link(`focus-${cm.id}`, "Go to agent", t.dim, () => this.focusAgent(cm), `Focus terminal ${cm.terminal}`)))
              .when(mine && c.editing !== cm.id, (e) => e.child(link(`edit-${cm.id}`, "Edit", t.dim, (_e, cx) => this.editPending(cm, cx), "Not submitted yet: you can still change it"))))
            .child(div().text_size(12).whitespace_normal().child(cm.text));
        }))))
      .child(div().w_full().child(Textarea.new(this.note).w_full().px(8).py(6).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground)))
      .child(div().text_size(10.5).text_color(t.dim).whitespace_normal().child(th ? "Your comments stay pending until Submit review sends them. Enter saves, shift-enter starts a new line, Esc closes."
        : c.kind === "file" ? "Click a line to comment on lines instead. Enter adds, Esc cancels." : "Click another line to widen the range. Enter adds, shift-enter starts a new line, Esc cancels."))
      .child(h_flex().items_center().gap(6).flex_wrap()
        .child(button("card-save", this.saving ? "Saving…" : primary, true, (_e, cx) => this.saveComposer(cx), "Enter"))
        .when(Boolean(c.editing), (e) => e.child(link("card-delete", "Delete", t.ansi1, (_e, cx) => this.act(() => deleteComment(root, on, c.id, c.editing), cx, () => { this.composer = { ...c, editing: null }; this.note.set_value(""); this.noteText = ""; }), "Remove this comment")))
        .when(Boolean(c.editing), (e) => e.child(link("card-cancel-edit", "Cancel", t.dim, (_e, cx) => { this.composer = { ...c, editing: null }; this.note.set_value(""); this.noteText = ""; cx.notify(); }, "Stop editing")))
        .when(!th, (e) => e.child(link("card-cancel", "Cancel", t.dim, (_e, cx) => this.closeComposer(cx), "Esc")))
        .when(Boolean(th) && !c.editing, (e) => e.child(div().flex_1())
          .child(link("card-status", th.status === "open" ? "Resolve" : "Reopen", t.dim, (_e, cx) => this.act(() => (th.status === "open" ? resolve : reopen)(root, on, th.id), cx), th.status === "open" ? "Mark this thread done" : "Open this thread again"))
          .child(link("card-send", "Send to agent", t.accent, (_e, cx) => this.send([th], `Thread ${th.id}`, cx), "Paste this thread into an agent's terminal, with how to answer it"))));
  }

  // Changes (Herdr's Changes panel, with its Commit box) or Review (this
  // panel). The layout's stack holds the choice; the copy kept here draws the
  // click at once.
  renderSwitch() {
    const t = theme(), active = find(layout(), VIEWS)?.active ?? this.shown;
    const pill = (child, label, tip) => div().id(`view-${child}`).h(24).px(10).flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .bg(active === child ? t.selected : NONE).text_color(active === child ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).tooltip(tip)
      .on_click((_e, cx) => { this.shown = child; run("layout.select", { stack: VIEWS, child }); cx.notify(); })
      .child(label);
    return h_flex().id("changes-switch").size_full().px(4).gap(4).items_center().bg(t.background)
      .child(pill(WORK, "Changes", "The working tree's changes, and committing them"))
      .child(pill(COMMITTED, "Review", "Uncommitted work, a branch or chosen commits, reviewed in threads that agents answer"));
  }

  // The reader pane's header: the open file and what it is a diff of.
  readerHeader(t) {
    const found = this.fileOf(this.open);
    const bar = h_flex().h(32).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(12);
    if (!found) return bar.child(div().font_semibold().child("Review"));
    const { unit, file } = found, parts = file.path.split("/"), name = parts.pop();
    return bar
      .child(div().w(12).flex_none().text_size(11).text_color(statusColor(file, t)).child(file.status))
      .child(h_flex().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? `${parts.join("/")}/` : "")).child(div().flex_none().font_medium().child(name)))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(unit.label))
      .when(file.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${file.add}`)))
      .when(file.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${file.del}`)));
  }

  // The diff with its thread cards and the comment card. `empty`: the text
  // shown while no file is open.
  diffArea(t, colors, target, empty) {
    // The rows under a thread keep a faint mark in their margin.
    const marked = new Set();
    for (const it of this.items) if (it.at) for (let j = it.at.from; j <= it.at.to; j++) marked.add(j);
    return h_flex().flex_1().min_h(0).items_stretch()
      .child(div().flex_1().min_w(0).min_h(0).relative().font_family(codeFont()).text_size(this.fontSize)
        .child(div().id("review-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("review-diff", this.items.length, this.sizes.length ? this.sizes : this.row, (i) => this.items[i].key,
            (range) => this.items.slice(range.start, range.end).map((it) => this.item(it, t, colors, target, marked))).size_full().track_scroll(this.scroll)
            .on_item_click((k, cx) => {
              if (k.startsWith("m:")) this.toggleMessage(k.slice(2), cx);
              else if (k.startsWith("t:")) this.openThread(k.slice(2), cx);
              else if (k.startsWith("x:")) this.reveal(k, cx);
              else this.clickRow(Number(k.slice(2)), cx);
            }))))
        .child(Scrollbar.vertical("review-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && !this.items.length && Boolean(empty), (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child(empty)))
        .when(Boolean(this.open) && this.rows.length > 0 && !this.composer, (e) => e.child(div().absolute().bottom(6).right(14).px(8).py(3).rounded(6).bg(t.raised + "e0").text_size(10).text_color(t.dim).child("Click a line to comment · click a thread to answer it"))))
      .when(Boolean(this.composer) && !this.narrow(), (e) => e.child(this.composerCard(t, target, false)));
  }

  render(cx) {
    if (this.dialog) return this.dialog.render(cx);
    if (this.strip) return this.renderSwitch();
    if (this.reader) {
      // The panel shared another file, or the same one changed: load it.
      const at = shared(FOLLOW)?.at ?? null;
      if (at !== this.followAt) { this.followAt = at; cx.timer.after(1, (cx) => this.refresh(cx)); }
    } else if (key() !== this.context) this.refresh(cx);
    const size = codeSize();
    if (size !== this.fontSize) { this.fontSize = size; this.row = rowOf(size); this.measure(); }
    // Git Graph asked for a commit: the next load shows it.
    const request = this.reader ? null : shared(REQUEST);
    if (request && request.at !== this.requestAt) { this.requestAt = request.at; this.gen++; cx.timer.after(1, (cx) => this.refresh(cx)); }
    // The send dialog reports a sent text through `SENT`: the sent comments are submitted.
    const sentAt = shared(SENT);
    if (this.sending && typeof sentAt === "number" && sentAt >= this.sending.at) { const sending = this.sending; this.sending = null; cx.timer.after(1, (cx) => this.published(sending, cx)); }

    const t = theme(), colors = palette(t), target = this.target();
    const problem = this.error ?? this.storeError ?? this.note_;
    const root = v_flex().id("commit-review").size_full().min_h(0).relative().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_size_change((size, cx) => { const w = this.size?.width; this.size = size; if (w !== size.width) { this.rebuild(); cx.notify(); } })
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.composer) { this.closeComposer(cx); cx.stop_propagation(); }
        else if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control) && this.composer) { this.saveComposer(cx); cx.stop_propagation(); }
      });
    if (this.reader) {
      return root.child(this.readerHeader(t))
        .when(Boolean(problem), (e) => e.child(div().px(12).py(5).text_size(11).text_color(t.ansi1).whitespace_normal().child(problem)))
        .child(this.diffArea(t, colors, target, "Pick a file in the review panel to read it here"))
        .when(Boolean(this.composer) && this.narrow(), (e) => e.child(this.composerCard(t, target, true)));
    }

    const files = this.units.flatMap((u) => u.files.map((f) => ({ u, f })));
    const viewedCount = files.filter(({ u, f }) => this.viewState(u, f) === "yes").length;
    const add = files.reduce((n, { f }) => n + f.add, 0), del = files.reduce((n, { f }) => n + f.del, 0);
    const pending = this.threads.reduce((n, th) => n + th.comments.filter((c) => c.pending).length, 0);
    const button = (id, label, primary, action, tip) => div().id(id).h(24).px(10).flex().items_center().rounded(6).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).text_size(12).font_medium().cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action).tooltip(tip).child(label);
    const note = this.storeError ?? this.note_;
    return root
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .when(!this.repo, (e) => e.child(div().font_semibold().child("Review")))
        // Uncommitted work is always the checked-out branch's: no branch to pick.
        .when(Boolean(this.repo), (e) => e.child(this.modeSwitch(t)).when(this.mode !== "uncommitted", (e) => e.child(this.branchPicker(t))))
        .child(div().flex_1())
        .when(Boolean(this.repo), (e) => e.child(this.agentPicker(t))))
      .when(Boolean(this.repo), (e) => e.child(h_flex().h(30).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(11.5)
        .child(div().id("viewed-count").text_color(files.length && viewedCount === files.length ? t.ansi2 : t.muted).tooltip("Files marked viewed · the next one: commit-review.next").child(`${viewedCount}/${files.length} viewed`))
        .child(div().text_color(t.ansi2).child(`+${add}`)).child(div().text_color(t.ansi1).child(`−${del}`))
        .child(div().flex_1())
        .when(Boolean(this.open), (e) => e.child(div().id("open-reader").size(22).flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Read this diff in a pane beside the terminal")
          .on_click((_e, cx) => this.openReader(cx)).child(svg(`${ICONS}/panel-right.svg`).size(13))))
        .when(pending > 0, (e) => e.child(button("review-submit", `Submit review · ${pending}`, true, (_e, cx) => this.submit(cx), "Send your pending comments to an agent; they become visible to agents once sent")))))
      .when(Boolean(this.repo), (e) => e.child(this.commitStrip(t)))
      .child(this.fileList(t))
      .when(Boolean(note), (e) => e.child(div().px(12).py(5).text_size(11).text_color(t.ansi1).whitespace_normal().child(note)))
      .child(this.diffArea(t, colors, target, files.length > 0 ? "Select a file to review it" : null))
      .when(Boolean(this.composer) && this.narrow(), (e) => e.child(this.composerCard(t, target, true)));
  }
}
