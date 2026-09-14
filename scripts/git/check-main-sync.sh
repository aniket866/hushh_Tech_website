#!/bin/sh
# scripts/git/check-main-sync.sh
#
# Branch freshness: does this checkout already CONTAIN the tip of its base branch?
#
# Ported from hushh-labs/hushh-research (scripts/git/check-main-sync.sh), which runs it as a
# blocking `main-freshness-gate` on every pull request. The rule it encodes is theirs and it is
# the right one: a branch that is behind its base has not been validated against the code that is
# actually on the base, so whatever CI says about it is a statement about a tree nobody will ever
# ship. Bypass cohorts waive review, never validation.
#
# Two deliberate differences from that implementation, both because this repository's default CI
# runner is Cloud Build rather than GitHub Actions:
#
#   1. NO SILENT SKIP ON A DETACHED HEAD. The original exits 0 when it cannot read a branch name.
#      Every Cloud Build checkout is detached, so ported verbatim this gate would no-op on one
#      hundred percent of builds while reporting green — the precise failure the merge-fidelity
#      orchestrator calls INCONCLUSIVE and refuses. The ancestry question does not need a branch
#      name to be answerable, so it is asked unconditionally and the branch name is used only for
#      the message. The original's "on the base branch, skip" shortcut is gone for the same
#      reason: a stale checkout of `main` is still stale, and a deploy from one still overwrites.
#
#   2. SHALLOW CLONES ARE DETECTED AND DEEPENED. `git merge-base --is-ancestor` walks history; on
#      a truncated one it can answer "not an ancestor" for a commit that is. Cloud Build and
#      actions/checkout both clone shallow by default, so this is the common case, not the corner.
#      If the clone cannot be deepened the result is INCONCLUSIVE and the gate fails in block
#      mode. A check that could not look is never reported as a check that passed.
#
# Env:
#   MAIN_SYNC_REMOTE   remote holding the base branch (default: origin)
#   MAIN_SYNC_BRANCH   base branch (default: main)
#   MAIN_SYNC_MODE     block (default) | warn — governs the exit code only; the report is identical
#   MAIN_SYNC_HEAD     ref under test (default: HEAD)
#   MAIN_SYNC_LABEL    human name for that ref in the output (default: the branch name, else the SHA)
#   MAIN_SYNC_DEEPEN   commits to deepen a shallow clone by before giving up (default: 1000)
#   MAIN_SYNC_FETCH    1 (default) fetch the base here; 0 requires a caller to have fetched it
#
# Exit: 0 fresh (or warn mode), 1 behind or inconclusive in block mode.

set -e

REMOTE="${MAIN_SYNC_REMOTE:-origin}"
BRANCH="${MAIN_SYNC_BRANCH:-main}"
MODE="${MAIN_SYNC_MODE:-block}"
HEAD_REF="${MAIN_SYNC_HEAD:-HEAD}"
DEEPEN="${MAIN_SYNC_DEEPEN:-1000}"
FETCH="${MAIN_SYNC_FETCH:-1}"

case "$MODE" in
  block|warn) ;;
  *)
    printf '[main-sync] Unsupported MAIN_SYNC_MODE "%s". Use "block" or "warn".\n' "$MODE" >&2
    exit 1
    ;;
esac

# GITHUB_HEAD_REF is the PR's source branch and GITHUB_REF_NAME the push ref; both are real
# environment variables in Actions. Cloud Build's BRANCH_NAME is a SUBSTITUTION, not an env var, so
# it is not visible here — the Cloud Build lane passes it in as MAIN_SYNC_LABEL instead. Without
# that, `git branch --show-current` answers "master" there: Cloud Build's source fetcher puts the
# checkout on a local branch of that name whatever the real one is, which is both a misleading
# label and the reason this gate must not skip itself by comparing branch names.
LABEL="${MAIN_SYNC_LABEL:-${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-$(git branch --show-current 2>/dev/null || true)}}}"

summary() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  while [ $# -gt 0 ]; do printf '%s\n' "$1" >>"$GITHUB_STEP_SUMMARY"; shift; done
  printf '\n' >>"$GITHUB_STEP_SUMMARY"
}

# One exit path for every non-fresh outcome, so "could not check" and "is behind" can never differ
# in how loudly they fail.
fail() {
  REASON="$1"; shift
  if [ "$MODE" = "warn" ]; then
    printf '\n[main-sync] WARNING %s\n' "$REASON"
  else
    printf '\n[main-sync] BLOCKED %s\n' "$REASON"
  fi
  while [ $# -gt 0 ]; do printf '           %s\n' "$1"; shift; done
  printf '\n'
  [ -n "${GITHUB_ACTIONS:-}" ] && [ "$MODE" = "warn" ] &&
    printf '::warning title=Branch Freshness Advisory::%s\n' "$REASON"
  summary "### Branch freshness: $([ "$MODE" = warn ] && echo advisory || echo blocked)" "" "$REASON"
  [ "$MODE" = "warn" ] && exit 0
  exit 1
}

# MAIN_SYNC_FETCH=0 means a caller already put the base ref in this repository and is answering
# for how recently. That is not a bypass — the ref still has to be there, and the ancestry check
# below is unchanged; it exists because a Cloud Build step cannot fetch this repository by itself.
# The trigger's clone credential is consumed by the source fetch and never reaches the steps, so a
# plain fetch here runs anonymously and gets a 403 on a private repository. The Cloud Build lane
# therefore runs scripts/ci/fetch-base-branch.mjs first, which mints a short-lived read token from
# the Cloud Build connection. Proven on build 1e1f743b before that helper existed.
if [ "$FETCH" = "1" ]; then
  git remote | grep -qx "$REMOTE" ||
    fail "Remote '$REMOTE' is not configured, so freshness could not be checked." \
         "Run: git remote add $REMOTE <repo-url>"

  # A shallow clone makes the ancestry walk unreliable, so deepen before asking. --unshallow is the
  # complete answer and the deepen is the fallback for a server that refuses it.
  if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo false)" = "true" ]; then
    printf '[main-sync] Shallow clone; deepening before the ancestry check.\n'
    git fetch --unshallow "$REMOTE" --quiet 2>/dev/null ||
      git fetch --deepen="$DEEPEN" "$REMOTE" --quiet 2>/dev/null || true
  fi

  # An explicit refspec, not `git fetch origin main`. Cloud Build and `actions/checkout` both make
  # single-branch clones whose configured refspec names only the branch under test, so a bare fetch
  # lands the base in FETCH_HEAD and never creates refs/remotes/origin/main. Naming the destination
  # ref makes this work under any remote configuration.
  git fetch "$REMOTE" "+refs/heads/$BRANCH:refs/remotes/$REMOTE/$BRANCH" --quiet 2>/dev/null || true
fi

# --verify --quiet, because a plain `git rev-parse <bad-ref>` ECHOES THE REF on stdout before it
# fails. Captured through `|| echo ""` that reads back as a resolved commit, and every downstream
# comparison then runs against the literal string "origin/main".
REMOTE_SHA=$(git rev-parse --verify --quiet "refs/remotes/$REMOTE/$BRANCH^{commit}" || true)
LOCAL_SHA=$(git rev-parse --verify --quiet "$HEAD_REF^{commit}" || true)

if [ -z "$REMOTE_SHA" ]; then
  if [ "$FETCH" = "1" ]; then
    fail "Could not fetch $REMOTE/$BRANCH, so freshness could not be checked." \
         "Locally: git fetch $REMOTE $BRANCH" \
         "In a Cloud Build step the fetch is anonymous and this repository is private, so it must" \
         "be done first: node scripts/ci/fetch-base-branch.mjs $BRANCH"
  fi
  fail "MAIN_SYNC_FETCH=0 was set but $REMOTE/$BRANCH is not present in this repository." \
       "Whatever was supposed to fetch it did not. Do not relax this to make the step pass."
fi
[ -n "$LOCAL_SHA" ] || fail "Could not resolve $HEAD_REF to a commit."

[ -z "$LABEL" ] && LABEL="$(echo "$LOCAL_SHA" | cut -c1-8) (detached)"

if git merge-base --is-ancestor "$REMOTE_SHA" "$LOCAL_SHA" 2>/dev/null; then
  printf '[main-sync] %s contains the latest %s/%s.\n' "$LABEL" "$REMOTE" "$BRANCH"
  printf '           head: %s\n' "$(echo "$LOCAL_SHA" | cut -c1-8)"
  printf '           base: %s\n' "$(echo "$REMOTE_SHA" | cut -c1-8)"
  summary "### Branch freshness: fresh" "" \
    "\`$LABEL\` already contains the latest \`$REMOTE/$BRANCH\`." \
    "- head: \`$(echo "$LOCAL_SHA" | cut -c1-8)\`" \
    "- base: \`$(echo "$REMOTE_SHA" | cut -c1-8)\`"
  exit 0
fi

# Not an ancestor. Distinguish "genuinely behind" from "the history is too short to tell", because
# the second is not a finding about the branch and must not be reported as one.
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo false)" = "true" ]; then
  fail "INCONCLUSIVE — the clone is still shallow, so ancestry cannot be decided." \
       "Do not read this as fresh. Re-run with a full clone:" \
       "  Cloud Build: the trigger must not set a fetch depth" \
       "  GitHub Actions: actions/checkout with fetch-depth: 0"
fi

BEHIND=$(git rev-list "$LOCAL_SHA".."$REMOTE_SHA" --count 2>/dev/null || echo "an unknown number of")
fail "$LABEL is behind $REMOTE/$BRANCH by $BEHIND commit(s)." \
     "head: $(echo "$LOCAL_SHA" | cut -c1-8)" \
     "base: $(echo "$REMOTE_SHA" | cut -c1-8)" \
     "Sync before this branch is validated or shipped:" \
     "  git fetch $REMOTE $BRANCH && git merge $REMOTE/$BRANCH" \
     "then re-run scripts/ci/check-merge-fidelity.sh to prove the merge kept the base's work."
