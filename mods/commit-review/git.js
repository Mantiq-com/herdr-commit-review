// The git reads of the Review panel. Every command runs on the space's machine
// and only reads: the flags keep git from taking the index lock or refreshing
// the index, which would get in the way of the agents' own git commands.
import { exec } from "herdr";

export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const SEP = "\x1f", RECORD = "\x1e";
// The most commits the strip lists: a branch's since its base, or the latest on the base itself.
const BRANCH_COMMITS = 200, BASE_COMMITS = 50;
// Limits, so that one huge file or commit cannot stall the panel.
const MAX_FILES = 1000, MAX_LINES = 1500, MAX_LINE = 4000;

export function gitIn(root, on) {
  return (args) => exec("git", [...READ, ...args], { cwd: root, on });
}

async function out(git, args) {
  const r = await git(args);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function must(git, args) {
  const r = await git(args);
  if (r.code !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** The repository around `cwd`: its root and its git common directory (shared by its worktrees), or null. */
export async function repoOf(cwd, on) {
  const r = await exec("git", [...READ, "rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], { cwd, on });
  if (r.code !== 0) return null;
  const [root, common] = r.stdout.trim().split("\n");
  return { root, common };
}

/** Local branch names, and the checked-out one (null when HEAD is detached). */
export async function branchesOf(git) {
  const list = (await must(git, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).split("\n").filter(Boolean);
  return { branches: list, current: await out(git, ["symbolic-ref", "-q", "--short", "HEAD"]) };
}

/** The branch reviews compare against: `preferred` (the mod's `base` prop), else
 *  origin/HEAD's branch, else main, else master; with the ref that names it here
 *  (the local branch, else origin's copy). The same order as `herdr-review`. */
export async function baseOf(git, preferred) {
  let base = preferred || null;
  if (!base) { const h = await out(git, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]); if (h) base = h.replace(/^refs\/remotes\/origin\//, ""); }
  if (!base) for (const b of ["main", "master"]) { if (await out(git, ["rev-parse", "--verify", "-q", `refs/heads/${b}`]) !== null) { base = b; break; } }
  if (!base) return { base: null, ref: null };
  if (await out(git, ["rev-parse", "--verify", "-q", `refs/heads/${base}`]) !== null) return { base, ref: base };
  if (await out(git, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${base}`]) !== null) return { base, ref: `origin/${base}` };
  return { base, ref: null };
}

/** Commits as LOG prints them: each record, then the commit's files with their
 *  blobs. `change` is the commit's identity across amend and rebase, which keep
 *  the author and the author date; the subject keeps apart two commits made in
 *  the same second. `herdr-review` writes the same string on commit threads. */
function parseLog(stdout) {
  const commits = [], parts = stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i].replace(/^\n/, "");
    if (token.startsWith(RECORD)) {
      const [sha, short, subject, author, email, time, parents] = token.slice(1).split(SEP);
      commits.push({ sha, short, subject, author, time: Number(time), parents: parents ? parents.split(" ") : [], change: `${email} ${time} ${subject}`, files: [] });
    } else if (token.startsWith(":") && commits.length) {
      const [, , oldBlob, newBlob, status] = token.slice(1).split(" ");
      commits[commits.length - 1].files.push({ path: parts[++i], status: status[0], oldBlob, newBlob });
    }
  }
  return commits;
}
// Each commit's files are its diff to its first parent, as filesOf reads it.
const LOG = ["log", "-z", "--raw", "--no-abbrev", "--no-renames", "--diff-merges=first-parent",
  `--format=${RECORD}%H${SEP}%h${SEP}%s${SEP}%an${SEP}%ae${SEP}%at${SEP}%P`];

/** A branch's tip, its merge base with the base (null when it is the base or
 *  has nothing of its own), and its commits, newest first. */
export async function commitsOf(git, branch, baseRef) {
  const tip = await out(git, ["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`]);
  if (!tip) throw new Error(`branch ${branch} does not exist`);
  let merge = null;
  if (baseRef) {
    merge = await out(git, ["merge-base", baseRef, tip]);
    if (merge === tip) merge = null;
  }
  const commits = parseLog(await must(git, merge ? [...LOG, `--max-count=${BRANCH_COMMITS}`, `${merge}..${tip}`] : [...LOG, `--max-count=${BASE_COMMITS}`, tip]));
  return { tip, merge, commits };
}

/** Commits by hash, for selected commits that are not in the strip (a Git Graph
 *  request). A hash this repository does not have is left out, because one
 *  unknown hash makes `git log` fail for all of them. */
export async function commitsByHash(git, shas) {
  const known = [];
  for (const sha of shas) if (await out(git, ["rev-parse", "--verify", "-q", `${sha}^{commit}`]) !== null) known.push(sha);
  return known.length ? parseLog(await must(git, [...LOG, "--no-walk=unsorted", ...known])) : [];
}

/** The empty tree's id, which a root commit is compared to. Asked of git, so
 *  SHA-256 repositories get theirs. */
export async function emptyTreeOf(git) {
  return (await must(git, ["hash-object", "-t", "tree", "/dev/null"])).trim();
}

/** HEAD's commit, or null before the first commit. */
export async function headOf(git) {
  return out(git, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
}

/** `diff --raw --numstat -z --no-renames --no-abbrev` output, by path: each
 *  file's status, blob ids before and after (the Viewed fingerprint), new mode
 *  and line counts. */
function parseDiff(stdout) {
  const parts = stdout.split("\0"), files = new Map();
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];
    if (token.startsWith(":")) {
      const [, newMode, oldBlob, newBlob, status] = token.slice(1).split(" ");
      const path = parts[++i];
      files.set(path, { path, status: status[0], oldBlob, newBlob, newMode, add: 0, del: 0, binary: false });
    } else {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(token);
      const f = m && files.get(m[3]);
      if (f) { f.binary = m[1] === "-"; f.add = Number(m[1]) || 0; f.del = Number(m[2]) || 0; }
    }
  }
  return files;
}

const byPath = (files) => [...files].sort((a, b) => a.path.localeCompare(b.path));

/** The files that differ between two commits, by path. */
export async function filesOf(git, from, to) {
  const all = byPath(parseDiff(await must(git, ["diff", "--raw", "--numstat", "-z", "--no-renames", "--no-abbrev", from, to])).values());
  return { files: all.slice(0, MAX_FILES), limited: all.length > MAX_FILES };
}

/** Each path's blob id as `git add` would make it, without writing it. One
 *  path git cannot read (a folder, a dangling link) fails the whole call:
 *  then each is hashed alone, and that one gets null. */
async function hashesOf(git, paths) {
  if (!paths.length) return [];
  const r = await git(["hash-object", "--", ...paths]);
  if (r.code === 0) return r.stdout.trim().split("\n");
  const hashes = [];
  for (const path of paths) {
    const one = await git(["hash-object", "--", path]);
    hashes.push(one.code === 0 ? one.stdout.trim() : null);
  }
  return hashes;
}

/** The working tree's changes against `head`, untracked files included, as
 *  Herdr's Changes panel lists them. A file's `newBlob` is the hash of its
 *  content now (a deleted file's is "deleted"), so a tick reads "changed"
 *  after the next edit. Untracked files have no line counts. */
export async function uncommittedOf(git, head) {
  const status = (await must(git, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"])).split("\0").filter(Boolean);
  const diff = parseDiff(await must(git, ["diff", "--raw", "--numstat", "-z", "--no-renames", "--no-abbrev", head]));
  const files = [];
  for (const entry of status) {
    const xy = entry.slice(0, 2), path = entry.slice(3), untracked = xy === "??", d = diff.get(path);
    // Staged, then deleted again: nothing differs from HEAD.
    if (!d && !untracked) continue;
    const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
    const file = d ?? { path, status: "A", oldBlob: "none", newBlob: null, newMode: null, add: 0, del: 0, binary: false };
    files.push({ ...file, status: conflict ? "U" : file.status, untracked });
  }
  const all = byPath(files), shown = all.slice(0, MAX_FILES);
  // A submodule is a folder: its commit, which git already gave, stands for it.
  const hashed = shown.filter((f) => f.status !== "D" && f.newMode !== "160000");
  const hashes = await hashesOf(git, hashed.map((f) => f.path));
  hashed.forEach((f, i) => { f.newBlob = hashes[i]; });
  for (const f of shown) if (f.status === "D") f.newBlob = "deleted";
  return { files: shown, limited: all.length > MAX_FILES };
}

const DIFF = ["--no-ext-diff", "--no-textconv", "--no-color"];

/** One file's diff between two commits, or from a commit to the working tree
 *  (`to` null, where an untracked file is compared to nothing): the lines
 *  from its first hunk on. */
export async function diffOf(git, from, to, file) {
  const args = to !== null ? ["diff", ...DIFF, from, to, "--", file.path]
    : file.untracked ? ["diff", "--no-index", ...DIFF, "--", "/dev/null", file.path]
    : ["diff", ...DIFF, from, "--", file.path];
  const r = await git(args);
  // `diff --no-index` exits 1 when the two differ, which they always do here.
  if (r.code !== 0 && !(file.untracked && r.code === 1)) throw new Error(`git diff: ${(r.stderr || r.stdout).trim()}`);
  const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
  const lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
  return lines.slice(0, MAX_LINES).map((line) => line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}… (line truncated)` : line);
}
