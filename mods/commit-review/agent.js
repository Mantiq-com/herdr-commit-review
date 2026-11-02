// What the Review panel sends to agents: a submitted review (pasted into an
// agent's terminal through the send dialog), and the first message of
// an agent started to review commits. Both tell the agent how to answer with
// `herdr-review`, because the agent may never have seen the command.

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Where a thread is, in words: "commit 3f2a1c9 "subject", src/app.rs, lines 40-44". */
export function whereOf(thread) {
  const t = thread.target;
  const on = t.kind === "commit" ? `commit ${t.commit.slice(0, 7)} "${t.subject ?? ""}"` : `branch ${t.branch} since ${t.base}`;
  if (thread.line === null || thread.line === undefined) return `${on}, ${thread.path}, whole file`;
  const lines = thread.end_line === thread.line ? `line ${thread.line}` : `lines ${thread.line}-${thread.end_line}`;
  return `${on}, ${thread.path}, ${thread.side === "old" ? `removed ${lines}` : lines}`;
}

const quoteOf = (thread) => thread.line === null || thread.line === undefined || !thread.quote ? []
  : thread.quote.split("\n").map((l, i) => `${String(thread.line + i).padStart(5)} | ${l}`);

const indent = (text) => text.split("\n").join("\n    ");

/** The review message for these threads: each with its lines and every
 *  comment, the person's unsent ones marked "new". */
export function reviewText({ root, on, threads }) {
  const fresh = threads.reduce((n, t) => n + t.comments.filter((c) => c.pending).length, 0);
  const head = `Code review of ${root}${on ? ` (on ${on})` : ""}: ${plural(fresh, "new comment")} in ${plural(threads.length, "thread")}.`;
  const how = [
    "Each thread has an id. In that repository, answer each one with herdr-review, passing your name (for example --author Codex) so the person sees who answered:",
    "- after handling it, reply with what you did: herdr-review reply <id> --author <name> -- \"...\"",
    "- when it is fixed, also resolve it: herdr-review resolve <id>",
    "- a question only needs a reply.",
    "herdr-review show <id> prints a thread; herdr-review list lists the open ones.",
  ].join("\n");
  const parts = threads.map((t) => [
    `### Thread ${t.id}: ${whereOf(t)}`,
    ...quoteOf(t),
    ...t.comments.map((c) => `- ${c.author}${c.role === "agent" && c.author !== "agent" ? " (agent)" : ""}${c.pending ? " (new)" : ""}: ${indent(c.text)}`),
  ].join("\n"));
  return `${head}\n${how}\n\n${parts.join("\n\n")}`;
}

const TAIL = [
  "Add --author with your name (for example --author Codex) to every herdr-review comment and reply, so the person sees who wrote it.",
  "Before you start, run herdr-review list to see the open threads; when your finding is already there, reply to that thread (herdr-review reply <id> -- \"...\") instead of opening another.",
  "herdr-review --help explains the rest.",
  "Do not change any file and do not commit: only leave comments. When you are done, say how many comments you left.",
];

/** The first message of an agent asked to review: a branch (`merge` is its
 *  merge base with `base`) or a list of commits. */
export function reviewTask({ root, on, mode, branch, base, merge, commits }) {
  const where = `${root}${on ? ` (on ${on})` : ""}`;
  if (mode === "branch") {
    return [
      `Review the branch ${branch} in ${where}: everything it adds since it left ${base}.`,
      `Read it with: git diff ${merge} ${branch}   (its commits: git log --oneline ${merge}..${branch})`,
      "Record every finding as a review comment on the lines it is about, one finding per comment:",
      `  herdr-review comment --branch ${branch} --base ${base} --path <file> --line <n> [--end-line <m>] -- "<finding>"`,
      `Line numbers are the file's lines at the tip of ${branch}. For a removed line, add --side old and use its number at the merge base. Leave out --line for a comment on a whole file.`,
      ...TAIL,
    ].join("\n");
  }
  return [
    `Review ${commits.length === 1 ? "this commit" : `these ${commits.length} commits, each on its own,`} in ${where}:`,
    ...commits.map((c) => `- ${c.short} ${c.subject}   (read it with: git show ${c.short})`),
    "Record every finding as a review comment on the lines it is about, one finding per comment:",
    "  herdr-review comment --commit <commit> --path <file> --line <n> [--end-line <m>] -- \"<finding>\"",
    "Line numbers are the file's lines in that commit. For a removed line, add --side old and use its number in the commit's parent. Leave out --line for a comment on a whole file.",
    ...TAIL,
  ].join("\n");
}
