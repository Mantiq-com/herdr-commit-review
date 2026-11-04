#!/usr/bin/env bash
# Checks the herdr-review command against a throwaway repository: the rules the
# Commit review panel and the agents rely on, not the wording of its output.
# It needs git and jq, and exits non-zero on the first failed check, so a
# package build can run it.
#
# Usage: test.sh <path to herdr-review>
set -o errexit -o nounset -o pipefail

review="${1}"
work=$(mktemp --directory)
trap 'rm --recursive --force "${work}"' EXIT

# A fresh home and no git configuration, so the person's settings (commit
# signing, hooks) cannot change what the commits below do.
export HOME="${work}/home" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME="Alice Smith" GIT_AUTHOR_EMAIL="alice@example.com"
export GIT_COMMITTER_NAME="Alice Smith" GIT_COMMITTER_EMAIL="alice@example.com"
unset HC_TERMINAL_ID HERDR_REVIEW_AUTHOR
mkdir --parents "${HOME}"

repo="${work}/repo"
git init --quiet --initial-branch=main "${repo}"
cd "${repo}"
printf 'one\ntwo\nthree\n' > app.txt
git add app.txt
git commit --quiet --message "first"
git switch --quiet --create feat
printf 'one\ntwo\nthree\nfour\n' > app.txt
git commit --quiet --all --message "second"

fail() {
  echo "FAIL: ${1}" >&2
  exit 1
}
count() {
  "${review}" list --json --status all "$@" | jq '.threads | length'
}

# A person's comment stays hidden from agents until the review is submitted.
"${review}" comment --commit HEAD --path app.txt --line 4 --pending \
  --role person --author "Alice Smith" -- "pending note" > /dev/null
[ "$(count)" = 0 ] || fail "a pending comment is visible to agents"
[ "$(count --include-pending)" = 1 ] || fail "the panel cannot see a pending comment"
"${review}" publish > /dev/null
[ "$(count)" = 1 ] || fail "publish did not make the comment visible"

# An agent's comment quotes the lines from the commit it names, and records
# the terminal it came from.
id=$(HC_TERMINAL_ID=t7 "${review}" comment --commit HEAD~1 --path app.txt \
  --line 2 --end-line 3 -- "agent note")
thread=$("${review}" show "${id}" --json)
[ "$(jq --raw-output .thread.quote <<< "${thread}")" = $'two\nthree' ] \
  || fail "the quote is not the commit's lines 2-3"
[ "$(jq --raw-output '.thread.comments[0].role' <<< "${thread}")" = agent ] \
  || fail "a comment without --role is not an agent's"
[ "$(jq --raw-output '.thread.comments[0].terminal' <<< "${thread}")" = t7 ] \
  || fail "the agent's terminal was not recorded"

# A line the file does not have in that commit is refused.
if "${review}" comment --commit HEAD~1 --path app.txt --line 4 -- "x" 2> /dev/null; then
  fail "a comment on line 4 of a 3-line file was accepted"
fi

# A branch thread records the branch tip it was written against.
branch_id=$("${review}" comment --branch feat --path app.txt --line 4 -- "branch note")
[ "$("${review}" show "${branch_id}" --json | jq --raw-output .thread.target.head)" \
  = "$(git rev-parse feat)" ] || fail "the branch thread does not record the tip"

# Writers at the same time never overwrite each other's comments.
pids=()
for i in $(seq 1 20); do
  "${review}" reply "${branch_id}" -- "reply ${i}" &
  pids+=("${!}")
done
for pid in "${pids[@]}"; do
  wait "${pid}" || fail "a parallel reply failed"
done
replies=$("${review}" show "${branch_id}" --json | jq '.thread.comments | length')
[ "${replies}" = 21 ] || fail "parallel replies were lost: ${replies} of 21 comments"

# A submitted comment can no longer be edited.
first=$("${review}" show "${branch_id}" --json | jq --raw-output '.thread.comments[0].id')
if "${review}" edit-comment "${branch_id}" "${first}" -- "changed" 2> /dev/null; then
  fail "a submitted comment was edited"
fi

# A thread on a commit stays with it when the commit is amended: the amended
# commit keeps the author, author date and subject that identify it.
[ "$(count --commit HEAD)" = 1 ] || fail "the commit does not have its one thread"
printf 'notes\n' > notes.txt
git add notes.txt
git commit --quiet --amend --no-edit
[ "$(count --commit HEAD)" = 1 ] || fail "the amended commit lost its thread"
[ "$(count --commit HEAD~1)" = 1 ] || fail "the parent commit's thread moved"

# Viewed ticks round-trip.
"${review}" viewed set "branch:feat:app.txt" "a..b"
[ "$("${review}" viewed list | jq --raw-output '.viewed["branch:feat:app.txt"]')" = "a..b" ] \
  || fail "viewed set did not store the value"
"${review}" viewed unset "branch:feat:app.txt"
[ "$("${review}" viewed list | jq '.viewed | length')" = 0 ] || fail "viewed unset left the key"

# A comment on uncommitted work quotes the working tree's lines, a new file
# included, and only the worktree it was written in lists it.
printf 'one\ntwo\nthree\nfour\nfive\n' > app.txt
uncommitted_id=$("${review}" comment --uncommitted --path app.txt --line 5 -- "uncommitted note")
[ "$("${review}" show "${uncommitted_id}" --json | jq --raw-output .thread.quote)" = five ] \
  || fail "the quote is not the working tree's line 5"
if "${review}" comment --uncommitted --path app.txt --line 6 -- "x" 2> /dev/null; then
  fail "a comment on line 6 of a 5-line working tree file was accepted"
fi
printf 'new file\n' > fresh.txt
"${review}" comment --uncommitted --path fresh.txt --line 1 -- "untracked note" > /dev/null \
  || fail "a comment on an untracked file was refused"
[ "$(count --uncommitted)" = 2 ] || fail "list --uncommitted does not find both comments"
[ "$(count --commit HEAD)" = 1 ] || fail "an uncommitted comment is listed as the commit's"
git worktree add --quiet "${work}/other" main
[ "$("${review}" --repo "${work}/other" list --json --status all --uncommitted | jq '.threads | length')" = 0 ] \
  || fail "another worktree lists this worktree's uncommitted comments"

echo "herdr-review: all checks passed"
