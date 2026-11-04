#!/usr/bin/env python3
"""Review threads on the commits of a git repository.

A thread is a discussion about some lines of one file, either in one commit
(--commit) or in everything a branch adds since it left its base branch
(--branch). People write threads in the Commit review panel of the Herdr app;
agents read and answer them with this command, and can open threads of their
own. The panel shows every change within seconds.

A thread on a commit stays with that commit when it is amended or rebased:
`list --commit` also finds threads written on an earlier version of it, by its
author, author date and subject.

Run it inside the repository, or pass --repo. The threads are stored under the
repository's git directory (see `herdr-review path`), so every worktree of the
repository shares them and they are never committed.

Line numbers are the numbers of the file's lines: in the commit itself (or at
the branch's tip) for --side new, the default; in the commit's parent (or at
the merge base) for --side old, which is only needed for a removed line. A
comment without --line is about the whole file.

Put "--" before a text that starts with "-".

Typical use by an agent:
  herdr-review list                  open threads (add --commit/--branch)
  herdr-review show k3x9a2           one thread with its lines
  herdr-review reply k3x9a2 -- "Fixed in 3f2a1c9: it returns Err now."
  herdr-review resolve k3x9a2
  herdr-review comment --commit 3f2a1c9 --path src/app.rs --line 42 \\
      -- "This clone is not needed: the value is moved below."
"""

import argparse
import datetime
import fcntl
import json
import os
import secrets
import subprocess
import sys
import tempfile
from contextlib import contextmanager

FORMAT = 2
MAX_QUOTE_LINES = 60


class ReviewError(Exception):
    pass


def git(repo, *args):
    result = subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True)
    if result.returncode != 0:
        message = (result.stderr or result.stdout).strip()
        raise ReviewError(f"git {args[0]} failed: {message}")
    return result.stdout


def git_maybe(repo, *args):
    """Like git(), but None when git exits non-zero (a missing ref)."""
    result = subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else None


def store_dir(repo):
    common = git(repo, "rev-parse", "--path-format=absolute",
                 "--git-common-dir").strip()
    return os.path.join(common, "herdr-review")


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(
        timespec="seconds")


class Store:
    def __init__(self, repo):
        self.repo = repo
        self.dir = store_dir(repo)
        self.threads_dir = os.path.join(self.dir, "threads")
        self.viewed_file = os.path.join(self.dir, "viewed.json")

    @contextmanager
    def lock(self):
        # Every writer (the panel and any number of agents) takes this lock
        # around its read-modify-write, so no change overwrites another.
        os.makedirs(self.threads_dir, exist_ok=True)
        fd = os.open(os.path.join(self.dir, ".lock"),
                     os.O_RDWR | os.O_CREAT, 0o644)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def write_json(self, path, data):
        # Readers never see a half-written file: write beside it, then
        # rename over it.
        folder = os.path.dirname(path)
        fd, tmp = tempfile.mkstemp(dir=folder, prefix=".tmp-")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(data, f, indent=1)
                f.write("\n")
            os.replace(tmp, path)
        except BaseException:
            os.unlink(tmp)
            raise

    def thread_path(self, thread_id):
        if not thread_id.isalnum():
            raise ReviewError(f"not a thread id: {thread_id}")
        return os.path.join(self.threads_dir, f"{thread_id}.json")

    def threads(self):
        if not os.path.isdir(self.threads_dir):
            return []
        found = []
        for name in os.listdir(self.threads_dir):
            if name.endswith(".json") and not name.startswith("."):
                with open(os.path.join(self.threads_dir, name)) as f:
                    found.append(json.load(f))
        found.sort(key=lambda t: (t["comments"][0]["at"], t["id"]))
        return found

    def thread(self, thread_id):
        path = self.thread_path(thread_id)
        if not os.path.exists(path):
            raise ReviewError(f"no thread {thread_id} in {self.dir}")
        with open(path) as f:
            return json.load(f)

    def save(self, thread):
        self.write_json(self.thread_path(thread["id"]), thread)

    def delete(self, thread_id):
        os.unlink(self.thread_path(thread_id))

    def new_id(self):
        while True:
            candidate = secrets.token_hex(3)
            if not os.path.exists(self.thread_path(candidate)):
                return candidate

    def viewed(self):
        if not os.path.exists(self.viewed_file):
            return {}
        with open(self.viewed_file) as f:
            return json.load(f)


def base_branch(repo, preferred):
    """The branch reviews compare against: --base, else origin/HEAD's
    branch, else main, else master."""
    if preferred:
        return preferred
    head = git_maybe(repo, "symbolic-ref", "-q", "refs/remotes/origin/HEAD")
    if head:
        return head.removeprefix("refs/remotes/origin/")
    for name in ("main", "master"):
        if git_maybe(repo, "rev-parse", "--verify", "-q",
                     f"refs/heads/{name}") is not None:
            return name
    raise ReviewError("no base branch found: pass --base")


def base_ref(repo, base):
    if git_maybe(repo, "rev-parse", "--verify", "-q",
                 f"refs/heads/{base}") is not None:
        return base
    if git_maybe(repo, "rev-parse", "--verify", "-q",
                 f"refs/remotes/origin/{base}") is not None:
        return f"origin/{base}"
    raise ReviewError(f"base branch {base} does not exist here")


def commit_of(repo, rev):
    sha = git_maybe(repo, "rev-parse", "--verify", "-q", f"{rev}^{{commit}}")
    if sha is None:
        raise ReviewError(f"not a commit: {rev}")
    return sha


def identity_of(repo, sha):
    """The commit's subject, and its identity across amend and rebase (which
    keep the author and the author date). The panel builds the same string, so
    it must not change on its own."""
    email, time, subject = git(repo, "log", "-1", "--format=%ae%x1f%at%x1f%s",
                               sha).rstrip("\n").split("\x1f", 2)
    return subject, f"{email} {time} {subject}"


def target_from(args):
    """The target record and the two revisions its sides are read from."""
    repo = args.repo
    if args.commit:
        sha = commit_of(repo, args.commit)
        parent = git_maybe(repo, "rev-parse", "--verify", "-q", f"{sha}^1")
        subject, change = identity_of(repo, sha)
        target = {"kind": "commit", "commit": sha, "subject": subject,
                  "change": change}
        return target, {"new": sha, "old": parent}
    branch = args.branch.removeprefix("refs/heads/")
    tip = commit_of(repo, f"refs/heads/{branch}")
    base = base_branch(repo, args.base)
    if base == branch:
        raise ReviewError(
            f"{branch} is the base branch: comment on its commits instead")
    merge = git(repo, "merge-base", base_ref(repo, base), tip).strip()
    target = {"kind": "branch", "branch": branch, "base": base, "head": tip}
    return target, {"new": tip, "old": merge}


def file_lines(repo, rev, path):
    if rev is None:
        return None
    result = subprocess.run(
        ["git", "show", f"{rev}:{path}"], cwd=repo, capture_output=True)
    if result.returncode != 0:
        return None
    return result.stdout.decode("utf-8", "replace").splitlines()


def author_of(args):
    role = args.role
    name = args.author or os.environ.get("HERDR_REVIEW_AUTHOR")
    if not name:
        name = "agent" if role == "agent" else os.environ.get("USER", "")
    terminal = os.environ.get("HC_TERMINAL_ID") if role == "agent" else None
    return {"author": name or role, "role": role, "terminal": terminal}


def text_of(args):
    text = sys.stdin.read() if args.text == "-" else args.text
    text = text.strip()
    if not text:
        raise ReviewError("the comment text is empty")
    return text


def new_comment(args, text):
    return {"id": secrets.token_hex(3), **author_of(args), "at": now(),
            "text": text, "pending": bool(getattr(args, "pending", False))}


def visible(thread, include_pending):
    if include_pending:
        return thread
    shown = [c for c in thread["comments"] if not c.get("pending")]
    return {**thread, "comments": shown} if shown else None


def matches(thread, args, commit):
    """`commit`: the hash and the identity of --commit, or None."""
    target = thread["target"]
    if args.status != "all" and thread["status"] != args.status:
        return False
    if args.path and thread["path"] != args.path:
        return False
    if commit and target.get("commit") != commit[0] \
            and target.get("change") != commit[1]:
        return False
    if args.branch and target.get("branch") != args.branch:
        return False
    return True


def where(thread):
    target = thread["target"]
    if target["kind"] == "commit":
        on = f'commit {target["commit"][:7]} "{target.get("subject", "")}"'
    else:
        on = (f'branch {target["branch"]} since {target["base"]}'
              f' (tip {target["head"][:7]} when written)')
    line, end = thread.get("line"), thread.get("end_line")
    if line is None:
        span = "whole file"
    else:
        lines = f"line {line}" if end == line else f"lines {line}-{end}"
        span = lines if thread["side"] == "new" else f"removed {lines}"
    return f'{on}, {thread["path"]}, {span}'


def print_thread(thread, full):
    count = len(thread["comments"])
    print(f'Thread {thread["id"]} ({thread["status"]}, '
          f'{count} comment{"s" if count != 1 else ""}): {where(thread)}')
    if not full:
        first = thread["comments"][0]["text"].splitlines()[0]
        print(f"  {first[:100]}")
        return
    quote = thread.get("quote") or ""
    if quote and thread.get("line") is not None:
        for n, text in enumerate(quote.split("\n"), start=thread["line"]):
            print(f"  {n:>5} | {text}")
    for c in thread["comments"]:
        who = c["author"]
        if c["role"] == "agent" and c.get("terminal"):
            who = f'{who} (agent, terminal {c["terminal"]})'
        elif c["role"] == "agent":
            who = f"{who} (agent)"
        mark = " [pending]" if c.get("pending") else ""
        print(f'\n{who}, {c["at"]}{mark}:')
        for text in c["text"].splitlines():
            print(f"  {text}")


def cmd_list(args, store):
    commit = None
    if args.commit:
        sha = commit_of(args.repo, args.commit)
        commit = (sha, identity_of(args.repo, sha)[1])
    shown = []
    for thread in store.threads():
        if not matches(thread, args, commit):
            continue
        thread = visible(thread, args.include_pending)
        if thread is not None:
            shown.append(thread)
    if args.json:
        # The panel watches the folder for changes; until the first thread
        # is written there is no folder to watch.
        folder = store.dir if os.path.isdir(store.dir) else None
        print(json.dumps({"version": FORMAT, "store": folder,
                          "threads": shown}))
        return
    if not shown:
        print("No threads.")
    for thread in shown:
        print_thread(thread, full=False)


def cmd_show(args, store):
    thread = visible(store.thread(args.id), args.include_pending)
    if thread is None:
        raise ReviewError(f"thread {args.id} has no submitted comments yet")
    if args.json:
        print(json.dumps({"version": FORMAT, "thread": thread}))
    else:
        print_thread(thread, full=True)


def cmd_comment(args, store):
    repo = args.repo
    target, revs = target_from(args)
    if args.line is None and args.end_line is not None:
        raise ReviewError("--end-line needs --line")
    lines = file_lines(repo, revs[args.side], args.path)
    other = "old" if args.side == "new" else "new"
    if lines is None and (args.line is not None
                          or file_lines(repo, revs[other], args.path) is None):
        raise ReviewError(
            f"{args.path} does not exist on the {args.side} side "
            f"({revs[args.side] or 'no parent'})")
    quote = args.quote
    if args.line is not None:
        end = args.end_line if args.end_line is not None else args.line
        if not 1 <= args.line <= end <= len(lines):
            raise ReviewError(
                f"lines {args.line}-{end} are outside {args.path}, which has "
                f"{len(lines)} lines on the {args.side} side")
        if quote is None:
            quote = "\n".join(lines[args.line - 1:end][:MAX_QUOTE_LINES])
    else:
        end = None
    text = text_of(args)
    with store.lock():
        thread = {
            "id": store.new_id(), "status": "open", "target": target,
            "path": args.path, "side": args.side, "line": args.line,
            "end_line": end, "quote": quote,
            "comments": [new_comment(args, text)],
        }
        store.save(thread)
    print(thread["id"])


def cmd_reply(args, store):
    text = text_of(args)
    with store.lock():
        thread = store.thread(args.id)
        thread["comments"].append(new_comment(args, text))
        store.save(thread)


def set_status(args, store, status):
    text = text_of(args) if args.text else None
    with store.lock():
        thread = store.thread(args.id)
        if text:
            args.pending = False
            thread["comments"].append(new_comment(args, text))
        thread["status"] = status
        store.save(thread)


def cmd_resolve(args, store):
    set_status(args, store, "resolved")


def cmd_reopen(args, store):
    set_status(args, store, "open")


def cmd_publish(args, store):
    count = 0
    with store.lock():
        for thread in store.threads():
            if args.ids and thread["id"] not in args.ids:
                continue
            pending = [c for c in thread["comments"] if c.get("pending")]
            for c in pending:
                c["pending"] = False
            if pending:
                store.save(thread)
                count += len(pending)
    print(count)


def pending_comment(thread, comment_id):
    for c in thread["comments"]:
        if c["id"] == comment_id:
            if not c.get("pending"):
                raise ReviewError(
                    "only a comment that was not submitted yet can change")
            return c
    raise ReviewError(f'no comment {comment_id} in thread {thread["id"]}')


def cmd_edit_comment(args, store):
    text = text_of(args)
    with store.lock():
        thread = store.thread(args.id)
        pending_comment(thread, args.comment)["text"] = text
        store.save(thread)


def cmd_delete_comment(args, store):
    with store.lock():
        thread = store.thread(args.id)
        gone = pending_comment(thread, args.comment)
        thread["comments"].remove(gone)
        if thread["comments"]:
            store.save(thread)
        else:
            store.delete(thread["id"])


def cmd_viewed(args, store):
    if args.action == "list":
        print(json.dumps({"version": FORMAT, "viewed": store.viewed()}))
        return
    if args.key is None or (args.action == "set" and args.value is None):
        raise ReviewError(f"viewed {args.action} needs a key"
                          + (" and a value" if args.action == "set" else ""))
    with store.lock():
        viewed = store.viewed()
        if args.action == "set":
            viewed[args.key] = args.value
        else:
            viewed.pop(args.key, None)
        store.write_json(store.viewed_file, viewed)


def cmd_path(args, store):
    print(store.dir)


def add_author(p):
    p.add_argument("--role", choices=["agent", "person"], default="agent",
                   help="who writes it (default: agent)")
    p.add_argument("--author",
                   help="the name shown; default: $HERDR_REVIEW_AUTHOR, "
                        "else 'agent' (or $USER for --role person)")


def add_text(p, optional=False):
    p.add_argument("text", nargs="?" if optional else None,
                   help='the comment; "-" reads it from stdin')


def parser():
    top = argparse.ArgumentParser(
        prog="herdr-review", description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    top.add_argument("--repo", default=".",
                     help="a folder inside the repository (default: here)")
    sub = top.add_subparsers(dest="command", required=True, metavar="command")

    p = sub.add_parser("list", help="list threads (open ones by default)")
    p.add_argument("--status", choices=["open", "resolved", "all"],
                   default="open")
    p.add_argument("--commit", help="only threads on this commit")
    p.add_argument("--branch", help="only threads on this branch")
    p.add_argument("--path", help="only threads on this file")
    p.add_argument("--json", action="store_true")
    p.add_argument("--include-pending", action="store_true",
                   help="also comments the person has not submitted yet")
    p.set_defaults(run=cmd_list)

    p = sub.add_parser("show", help="print one thread with its lines")
    p.add_argument("id")
    p.add_argument("--json", action="store_true")
    p.add_argument("--include-pending", action="store_true")
    p.set_defaults(run=cmd_show)

    p = sub.add_parser("comment", help="open a new thread")
    on = p.add_mutually_exclusive_group(required=True)
    on.add_argument("--commit", help="a commit (any revision naming one)")
    on.add_argument("--branch", help="a local branch, compared to its base")
    p.add_argument("--base", help="the branch's base (default: origin/HEAD, "
                                  "else main, else master)")
    p.add_argument("--path", required=True,
                   help="the file, relative to the repository root")
    p.add_argument("--line", type=int, help="first line (omit: whole file)")
    p.add_argument("--end-line", type=int, help="last line (default: --line)")
    p.add_argument("--side", choices=["new", "old"], default="new",
                   help="new: the file after the change (default); "
                        "old: before it, for removed lines")
    p.add_argument("--quote", help=argparse.SUPPRESS)
    p.add_argument("--pending", action="store_true", help=argparse.SUPPRESS)
    add_author(p)
    add_text(p)
    p.set_defaults(run=cmd_comment)

    p = sub.add_parser("reply", help="add a comment to a thread")
    p.add_argument("id")
    p.add_argument("--pending", action="store_true", help=argparse.SUPPRESS)
    add_author(p)
    add_text(p)
    p.set_defaults(run=cmd_reply)

    for name, run, about in (("resolve", cmd_resolve, "mark a thread done"),
                             ("reopen", cmd_reopen, "open a thread again")):
        p = sub.add_parser(name, help=f"{about}, with an optional comment")
        p.add_argument("id")
        add_author(p)
        add_text(p, optional=True)
        p.set_defaults(run=run)

    p = sub.add_parser("publish", help=argparse.SUPPRESS)
    p.add_argument("ids", nargs="*")
    p.set_defaults(run=cmd_publish)

    p = sub.add_parser("edit-comment", help=argparse.SUPPRESS)
    p.add_argument("id")
    p.add_argument("comment")
    add_text(p)
    p.set_defaults(run=cmd_edit_comment)

    p = sub.add_parser("delete-comment", help=argparse.SUPPRESS)
    p.add_argument("id")
    p.add_argument("comment")
    p.set_defaults(run=cmd_delete_comment)

    p = sub.add_parser("viewed", help=argparse.SUPPRESS)
    p.add_argument("action", choices=["list", "set", "unset"])
    p.add_argument("key", nargs="?")
    p.add_argument("value", nargs="?")
    p.set_defaults(run=cmd_viewed)

    p = sub.add_parser("path", help="print the folder the threads are in")
    p.set_defaults(run=cmd_path)
    return top


def main():
    args = parser().parse_args()
    try:
        args.run(args, Store(args.repo))
    except (ReviewError, OSError, json.JSONDecodeError) as e:
        print(f"herdr-review: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
