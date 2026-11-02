// The git reads of the Review panel. Every command runs on the space's machine
// and only reads: the flags keep git from taking the index lock or refreshing
// the index, which would get in the way of the agents' own git commands.
import { exec } from "herdr";

export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const SEP = "\x1f";
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

function parseLog(stdout) {
  return stdout.split("\0").map((s) => s.replace(/^\n/, "")).filter(Boolean).map((record) => {
    const [sha, short, subject, author, time, parents] = record.split(SEP);
    return { sha, short, subject, author, time: Number(time), parents: parents ? parents.split(" ") : [] };
  });
}
const LOG = ["log", "-z", `--format=%H${SEP}%h${SEP}%s${SEP}%an${SEP}%at${SEP}%P`];

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

/** The files that differ between two commits, by path, with their blob ids
 *  before and after (the Viewed fingerprint) and their line counts. */
export async function filesOf(git, from, to) {
  const parts = (await must(git, ["diff", "--raw", "--numstat", "-z", "--no-renames", "--no-abbrev", from, to])).split("\0");
  const files = new Map();
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];
    if (token.startsWith(":")) {
      const [, , oldBlob, newBlob, status] = token.slice(1).split(" ");
      const path = parts[++i];
      files.set(path, { path, status: status[0], oldBlob, newBlob, add: 0, del: 0, binary: false });
    } else {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(token);
      const f = m && files.get(m[3]);
      if (f) { f.binary = m[1] === "-"; f.add = Number(m[1]) || 0; f.del = Number(m[2]) || 0; }
    }
  }
  const all = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { files: all.slice(0, MAX_FILES), limited: all.length > MAX_FILES };
}

/** One file's diff between two commits: the lines from its first hunk on. */
export async function diffOf(git, from, to, file) {
  const stdout = await must(git, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", from, to, "--", file.path]);
  const all = stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
  const lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
  return lines.slice(0, MAX_LINES).map((line) => line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}… (line truncated)` : line);
}
