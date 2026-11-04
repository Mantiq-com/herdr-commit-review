// The review threads and Viewed ticks of a repository, read and written with
// the `herdr-review` command on the space's machine (`herdr-review --help`
// describes the store). The panel never touches the files itself: the command
// holds the one lock that the panel and the agents share, and it also works
// for a remote space, where Herdr's writeTextFile cannot write.
import { exec, home } from "herdr";

// The JSON format of `herdr-review`. A machine whose command prints another
// one has not been rebuilt since the format changed.
const FORMAT = 2;

async function call(root, on, args) {
  let r;
  try { r = await exec("herdr-review", ["--repo", root, ...args], { cwd: root, on }); }
  catch (e) { throw new Error(`herdr-review could not run${on ? ` on ${on}` : ""}: ${e}`); }
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `herdr-review ${args[0]} failed`);
  return r.stdout;
}

async function callJson(root, on, args) {
  const data = JSON.parse(await call(root, on, args));
  if (data.version !== FORMAT) throw new Error(`herdr-review${on ? ` on ${on}` : ""} writes format ${data.version}, this panel reads ${FORMAT}: rebuild that machine`);
  return data;
}

// Option values are passed as `--name=value`: a quoted line can start with "-",
// which argparse would otherwise read as an option.
// The person's name on their comments: their account name.
const person = () => ["--role=person", `--author=${home().split("/").pop()}`];

const targetArgs = (target) => target.kind === "commit"
  ? [`--commit=${target.commit}`]
  : [`--branch=${target.branch}`, `--base=${target.base}`];

/** Every thread, pending comments included, and the store's folder (null until the first thread is written). */
export async function loadThreads(root, on) {
  const data = await callJson(root, on, ["list", "--json", "--status", "all", "--include-pending"]);
  return { threads: data.threads, store: data.store };
}

export async function loadViewed(root, on) {
  return (await callJson(root, on, ["viewed", "list"])).viewed;
}

/** Opens a thread with a pending comment. `line` null: the whole file. Resolves the new thread's id. */
export async function addThread(root, on, { target, path, side, line, endLine, quote, text }) {
  const where = line === null ? [] : [`--line=${line}`, `--end-line=${endLine}`, `--side=${side}`, `--quote=${quote}`];
  return (await call(root, on, ["comment", ...targetArgs(target), `--path=${path}`, ...where, "--pending", ...person(), "--", text])).trim();
}

export const reply = (root, on, id, text) => call(root, on, ["reply", id, "--pending", ...person(), "--", text]);
export const resolve = (root, on, id) => call(root, on, ["resolve", id, ...person()]);
export const reopen = (root, on, id) => call(root, on, ["reopen", id, ...person()]);
export const editComment = (root, on, id, cid, text) => call(root, on, ["edit-comment", id, cid, "--", text]);
export const deleteComment = (root, on, id, cid) => call(root, on, ["delete-comment", id, cid]);
/** Submits the pending comments of these threads, so agents see them. */
export const publish = (root, on, ids) => call(root, on, ["publish", ...ids]);
export const setViewed = (root, on, key, value) => call(root, on, ["viewed", "set", key, value]);
export const unsetViewed = (root, on, key) => call(root, on, ["viewed", "unset", key]);
