#!/usr/bin/env bash
# scripts/ci/check-merge-fidelity.sh
#
# Orchestrates the merge-fidelity passes. Ported from hushh-labs/hushh-research, where it runs as
# an advisory `merge-fidelity-gate` alongside the blocking freshness gate.
#
# WHY IT IS SEPARATE FROM FRESHNESS. scripts/git/check-main-sync.sh proves a branch CONTAINS the
# base's commits as ancestors. It says nothing about whether the branch's CONTENT still has what
# those commits landed. There are three ways to hold the first property and lose the second:
#
#   A. A sync merge whose conflict resolution kept the stale side. Leaves a merge commit, so
#      walking the branch's own sync-merges finds it.
#   B. A clean revert inside the branch. No conflict and no merge commit, so pass A is blind to
#      it; comparing the fork point to the base tip and asking whether the base's content survived
#      into HEAD does find it.
#   C. A revert committed straight onto the base tip, days earlier. The branch is fresh and has no
#      sync merge, so A and B both see nothing. Widening the comparison to "the base as of N days
#      ago" catches it, narrowed to the files this branch actually touches — a file the branch
#      never opened cannot have been reverted by it.
#
# ADVISORY BY DESIGN. Every pass is a text heuristic with a real false-positive rate: it flags a
# deliberate supersession exactly as loudly as a silent revert. It reports and a human decides.
# What it must never do is stay quiet when it failed to look — hence INCONCLUSIVE below, which is
# reported as a failure to check and never as a clean result.
#
# ONE ADAPTATION FROM THE UPSTREAM IMPLEMENTATION. There, the escape hatch for a deliberate revert
# is an `intentional-revert` label plus a `Merge-Regression-Ack:` line in the pull-request body,
# read live through `gh`. The default CI runner here is Cloud Build, which receives no label, no
# pull-request body and no GitHub credential, so that hatch would be permanently shut — and a
# check whose only escape is unreachable is a check people switch off. The ack is therefore a
# `Merge-Regression-Ack: <reason>` trailer in a commit message on the branch. It costs a commit
# rather than a label, and it resolves identically in Cloud Build, in GitHub Actions and locally,
# with no network call and no token.
#
# Env:
#   MERGE_FIDELITY_BASE_REF     base to compare against (default: origin/main)
#   MERGE_FIDELITY_WINDOW_DAYS  pass C look-back window (default: 14)
#   MERGE_FIDELITY_MODE         warn (default) | block — governs the exit code only
#   MERGE_FIDELITY_PASS_TIMEOUT seconds per pass before it is called INCONCLUSIVE (default: 600)
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
BASE_REF="${MERGE_FIDELITY_BASE_REF:-origin/main}"
WINDOW_DAYS="${MERGE_FIDELITY_WINDOW_DAYS:-14}"
MODE="${MERGE_FIDELITY_MODE:-warn}"
PASS_TIMEOUT="${MERGE_FIDELITY_PASS_TIMEOUT:-600}"

DETECTOR="$REPO_ROOT/scripts/git/check-merge-regression.sh"
MERGE_SCAN="$REPO_ROOT/scripts/git/scan-pr-merges-for-regression.sh"

FLAGGED=0
INCONCLUSIVE=0

emit() {
  printf '%s\n' "$*"
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf '%s\n' "$*" >>"$GITHUB_STEP_SUMMARY"
  return 0
}

# Runs one pass and classifies its exit code. 0 = clean, 1 = findings, anything else = the pass
# itself broke. That third case matters most: a detector that dies before printing is, under an
# advisory gate, indistinguishable from one that passed.
run_pass() {
  local title="$1"; shift
  local out rc
  echo ""
  echo "=============================================================="
  echo "PASS: $title"
  echo "=============================================================="
  if command -v timeout >/dev/null 2>&1; then
    out="$(timeout "$PASS_TIMEOUT" "$@" 2>&1)"
  else
    out="$("$@" 2>&1)"
  fi
  rc=$?
  printf '%s\n' "$out"
  case "$rc" in
    0) echo "[merge-fidelity] $title: clean." ;;
    1) FLAGGED=1; echo "[merge-fidelity] $title: FINDINGS above." ;;
    124)
      INCONCLUSIVE=1
      echo "[merge-fidelity] $title: INCONCLUSIVE — hit the ${PASS_TIMEOUT}s budget before finishing."
      echo "[merge-fidelity] Check the revert-shaped parts of this diff by hand, or re-run with"
      echo "[merge-fidelity] MERGE_FIDELITY_PASS_TIMEOUT raised."
      ;;
    *)
      INCONCLUSIVE=1
      echo "[merge-fidelity] $title: INCONCLUSIVE — the check exited $rc before finishing."
      echo "[merge-fidelity] Do not read this as clean. Re-run, or check by hand."
      ;;
  esac
}

if [ ! -r "$DETECTOR" ] || [ ! -r "$MERGE_SCAN" ]; then
  echo "[merge-fidelity] Detector scripts missing — nothing checked." >&2
  exit 1
fi

BASE_SHA="$(git rev-parse --verify --quiet "${BASE_REF}^{commit}" || true)"
if [ -z "$BASE_SHA" ]; then
  echo "[merge-fidelity] Could not resolve $BASE_REF — nothing checked." >&2
  echo "[merge-fidelity] Fetch it first: git fetch origin main" >&2
  exit 1
fi

# ---- Pass A: this branch's own sync merges ---------------------------------
run_pass "A · conflict resolutions in this branch's sync merges" \
  env MERGE_REGRESSION_MODE=block bash "$MERGE_SCAN" "$BASE_REF"

# Passes B and C both ask "the base has this content — does HEAD still?". That question only means
# "this branch dropped it" once HEAD already contains the base. On a branch that is merely BEHIND,
# every commit the base gained since the fork point answers "missing" and the check becomes pure
# noise. Being behind is the freshness gate's job, and that gate blocks, so there is nothing for
# this advisory check to add.
if git merge-base --is-ancestor "$BASE_SHA" HEAD 2>/dev/null; then
  BASE_IN_HEAD=1
else
  BASE_IN_HEAD=0
  echo ""
  echo "[merge-fidelity] PASSES B and C skipped — HEAD does not contain $BASE_REF's tip"
  echo "                 (${BASE_SHA:0:9}). This branch is behind its base, which the freshness"
  echo "                 gate already blocks on. Sync and re-run."
fi

# ---- Pass B: what each sync merge brought in — is it still in HEAD? --------
#
# CORRECTED RELATIVE TO UPSTREAM, WHICH CANNOT RUN THIS PASS AT ALL. There, pass B compares the
# branch's fork point to the base tip and skips itself when the two are equal. But passes B and C
# only run once BASE_SHA is an ancestor of HEAD, and when that holds `git merge-base HEAD BASE_SHA`
# IS BASE_SHA by definition — so the skip fires every single time and pass B is unreachable. The
# loss mode it names ("a later commit on the branch simply removes what the base landed") therefore
# goes unchecked upstream, caught only incidentally by pass C when its window happens to span the
# right commits. Verified against that implementation before rewriting it here.
#
# The question pass B wants to ask is answerable from the branch's own sync merges. Each one has a
# base side (the parent that is an ancestor of the base) carrying the content that came in. Pass A
# asks whether the merge COMMIT preserved it; this asks whether HEAD still does, after every commit
# the branch made afterwards. That is exactly the clean-revert shape, and it is the difference
# between the two passes.
if [ "$BASE_IN_HEAD" -eq 0 ]; then
  :
else
  SYNC_MERGES="$(git rev-list --merges "${BASE_SHA}..HEAD" 2>/dev/null || true)"
  if [ -z "$SYNC_MERGES" ]; then
    echo ""
    echo "[merge-fidelity] PASS B skipped — no sync merges in ${BASE_REF}..HEAD, so nothing came"
    echo "                 in that a later commit could have taken back out."
  else
    while IFS= read -r merge; do
      [ -z "$merge" ] && continue
      p1="$(git rev-parse --verify --quiet "${merge}^1" || true)"
      p2="$(git rev-parse --verify --quiet "${merge}^2" || true)"
      [ -n "$p1" ] && [ -n "$p2" ] || continue

      # The base side is whichever parent the base branch contains. A merge of two feature
      # branches has neither, and says nothing about base content, so it is skipped.
      if git merge-base --is-ancestor "$p2" "$BASE_SHA" 2>/dev/null; then
        incoming="$p2"
      elif git merge-base --is-ancestor "$p1" "$BASE_SHA" 2>/dev/null; then
        incoming="$p1"
      else
        continue
      fi

      fork="$(git merge-base "$p1" "$p2" 2>/dev/null || true)"
      [ -n "$fork" ] && [ "$fork" != "$incoming" ] || continue

      run_pass "B · content ${merge:0:9} brought in from $BASE_REF, as HEAD has it now" \
        env MERGE_REGRESSION_MODE=block bash "$DETECTOR" "$fork" "$incoming" HEAD
    done <<< "$SYNC_MERGES"
  fi
fi

# ---- Pass C: wide window, narrowed to the files this branch touches --------
WINDOW_SHA="$(git rev-list -1 --before="${WINDOW_DAYS} days ago" "$BASE_SHA" 2>/dev/null || true)"
if [ "$BASE_IN_HEAD" -eq 0 ]; then
  :
elif [ -z "$WINDOW_SHA" ] || [ "$WINDOW_SHA" = "$BASE_SHA" ]; then
  echo ""
  echo "[merge-fidelity] PASS C skipped — no commit on $BASE_REF older than ${WINDOW_DAYS} days."
else
  echo ""
  echo "[merge-fidelity] PASS C window: $BASE_REF as of ${WINDOW_DAYS} days ago = ${WINDOW_SHA:0:9}"
  run_pass "C · content landed on $BASE_REF in the last ${WINDOW_DAYS} days, in files this branch touches" \
    env MERGE_REGRESSION_MODE=block \
        MERGE_REGRESSION_LIMIT_TO="${BASE_SHA}...HEAD" \
        bash "$DETECTOR" "$WINDOW_SHA" "$BASE_SHA" HEAD
fi

# ---- Verdict ---------------------------------------------------------------
echo ""
if [ "$FLAGGED" -eq 0 ] && [ "$INCONCLUSIVE" -eq 0 ]; then
  emit "### Merge fidelity: clean"
  emit "No landed content appears to have been dropped by this branch."
  exit 0
fi

if [ "$INCONCLUSIVE" -eq 1 ] && [ "$FLAGGED" -eq 0 ]; then
  emit "### Merge fidelity: INCONCLUSIVE"
  emit "A pass exited before finishing. This is **not** a pass — read the job log."
  [ "$MODE" = "block" ] && exit 1
  exit 0
fi

# Findings. Read the ack before deciding what to say about them. Trailers only, and only on
# commits this branch adds: a reason inherited from the base would acknowledge somebody else's
# revert forever.
ACK_REASON="$(git log "${BASE_SHA}..HEAD" --format=%B 2>/dev/null \
  | sed -nE 's/^Merge-Regression-Ack:[[:space:]]*(.+)$/\1/p' | head -1)"

if [ -n "$ACK_REASON" ]; then
  emit "### Merge fidelity: findings acknowledged"
  emit "A commit on this branch declares the removal deliberate, so the findings below are"
  emit "treated as intended."
  emit ""
  emit "> $ACK_REASON"
  exit 0
fi

emit "### Merge fidelity: possible dropped work"
emit "One or more passes found content that \`$BASE_REF\` already had and this branch does not."
emit "Read the log — each finding names the file and the commits that landed it."
emit ""
emit "If the removal is deliberate, put a \`Merge-Regression-Ack: <reason>\` trailer in a commit"
emit "message on this branch and re-run."

[ "$MODE" = "block" ] && exit 1
exit 0
