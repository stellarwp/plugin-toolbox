#!/usr/bin/env bash
#
# Downloads the baseline.json that the Plugin Check workflow wrote for a branch: the
# plugin-check-report artifact of an earlier run. That run checked the branch as it really is, so
# the baseline always matches it. Nothing is committed, so two branches worked on at the same time
# can never leave a stale baseline behind. See this action's README.
#
# Usage:
#   fetch-baseline.sh [--workflow <file>] [--sha <commit>] [--wait <seconds>] [--before-run <run-id>] <branch> [<output-file>]
#
# --workflow is the file name of the workflow whose runs hold the baseline (default:
# plugin-check.yml). When the check runs as a reusable workflow, the runs belong to the CALLER's
# file, so the action passes that name, read from GITHUB_WORKFLOW_REF.
#
# Runs are tried in this order, and the first one with the artifact wins:
#   1. runs for --sha (a pull request's base commit), when given. With --wait, a run for that
#      commit that is still going is waited for, up to that many seconds. A run that does not
#      show up at all is waited for only a short time (GRACE seconds), since the commit may never
#      have had one;
#   2. the latest runs on <branch>, newest first.
# --before-run keeps only runs started before that one (run ids only grow), so a run never
# compares with itself, and a re-run of an older push never compares with a newer one.
#
# <output-file> defaults to baseline.json next to this script, which ratchet.sh reads by default
# and git ignores.
#
# Prints "<run-id> <run-url> <match>". <match> is "exact" when the run is for --sha (or no --sha
# was given), and "older" when --sha was given but only an older run on the branch had a baseline.
#
# Exit status:
#   0  baseline written
#   1  no run has the artifact (none finished yet, or all expired)
#   2  the lookup itself failed (GitHub API or download error), so "no baseline" is not known
#
# Needs the GitHub CLI, signed in (GH_TOKEN in CI) with read access to Actions.

set -euo pipefail

workflow=plugin-check.yml
sha=""
wait_for=0
before_run=""
# How long to wait for a run for --sha to show up at all.
GRACE=120
usage="Usage: $0 [--workflow <file>] [--sha <commit>] [--wait <seconds>] [--before-run <run-id>] <branch> [<output-file>]"

lookup_failed() {
    echo "Could not look up Plugin Check runs: $1" >&2
    exit 2
}

# A missing or malformed argument exits 2, like any other lookup that cannot be trusted. Exit 1 is
# kept for "no run has a baseline", so a typo must never read as that.
need_value() {
    [ "$#" -ge 2 ] && [ -n "$2" ] || lookup_failed "$1 needs a value. $usage"
}

# A plain count of seconds or a run id. At most 18 digits keeps it inside bash's 64-bit integers,
# and 10# keeps a leading zero from being read as octal later.
number() {
    case "$2" in
        '' | *[!0-9]*) lookup_failed "$1 must be a whole number, not '$2'" ;;
    esac
    [ "${#2}" -le 18 ] || lookup_failed "$1 is too large: '$2'"
    echo $((10#$2))
}

while [ $# -gt 0 ]; do
    case "$1" in
        --workflow) need_value "$@"; workflow=$2; shift 2 ;;
        --sha) need_value "$@"; sha=$2; shift 2 ;;
        --wait) need_value "$@"; wait_for=$(number --wait "$2"); shift 2 ;;
        --before-run) need_value "$@"; before_run=$(number --before-run "$2"); shift 2 ;;
        *) break ;;
    esac
done

[ "$#" -ge 1 ] && [ -n "$1" ] || lookup_failed "a branch is needed. $usage"
branch=$1
output=${2:-"$(cd "$(dirname "$0")" && pwd)/baseline.json"}

# Any other command that fails (mktemp, mkdir, cp, ...) is a failure too, never "no baseline":
# exit 1 is kept for the one place below that means it.
trap 'echo "fetch-baseline.sh failed at line $LINENO." >&2; exit 2' ERR

repo=${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)} || lookup_failed "no repository"
# Only a bare file name: it goes into an API path, and a path or a ref there would ask for some
# other resource.
case "$workflow" in
    */* | *@* | "") lookup_failed "--workflow must be a file name such as plugin-check.yml, not '$workflow'" ;;
esac
runs="repos/$repo/actions/workflows/$workflow/runs"

# Only runs of this repository's own branches count. The runs API matches `branch` and `head_sha`
# against the head of a pull request too, so a run for a pull request from a fork, from a branch
# named like the target, would otherwise be taken for a run of the target, and its artifact is
# whatever that fork's workflow chose to upload.
#
# jq reads $repo, so the filters stay in single quotes.
# shellcheck disable=SC2016
own='select((.head_repository.full_name // "" | ascii_downcase) == ($repo | ascii_downcase))'
# shellcheck disable=SC2016
own_runs='.workflow_runs[] | '"$own"' | "\(.id) \(.html_url) \(.head_sha)"'
# shellcheck disable=SC2016
own_counts='[.workflow_runs[] | '"$own"'] | "\(length) \([.[] | select(.status != "completed")] | length)"'

# The run for the base commit may still be going: a pull request opened right after a merge starts
# at the same time as the push run on the target branch. Waiting for it beats comparing with an
# older run.
if [ -n "$sha" ] && [ "$wait_for" -gt 0 ]; then
    started=$(date +%s)
    deadline=$((started + wait_for))
    while :; do
        # "<all runs> <runs still going>" for the commit.
        counts=$(gh api "$runs?head_sha=$sha&per_page=20" \
            | jq -r --arg repo "$repo" "$own_counts") \
            || lookup_failed "runs for $sha"
        read -r total going <<< "$counts"
        # A run can take a moment to show up after its push. After GRACE seconds with none, the
        # commit never had one.
        if [ "$total" -eq 0 ] && [ "$(date +%s)" -ge $((started + GRACE)) ]; then
            break
        fi
        [ "$total" -eq 0 ] || [ "$going" -gt 0 ] || break
        if [ "$(date +%s)" -ge "$deadline" ]; then
            echo "The run for $sha is still going after $wait_for seconds; trying older runs." >&2
            break
        fi
        sleep 30
    done
fi

# "<run-id> <run-url> <head-sha>" lines, best first. Captured, not streamed, so a failed API call
# stops here instead of looking like an empty list.
candidates=""
if [ -n "$sha" ]; then
    candidates=$(gh api "$runs?status=completed&head_sha=$sha&per_page=10" \
        | jq -r --arg repo "$repo" "$own_runs") || lookup_failed "runs for $sha"
fi
# Newest first by run id (ids only grow), not by the order the API happens to return. One page of
# 100, the most the API gives, is plenty: if none of them has a baseline, an older one would be
# stale anyway. Fork runs are dropped after the page is read, so a flood of them could push ours
# off it; the result is then "no baseline", which passes with a warning, and no fork baseline is
# taken.
on_branch=$(gh api "$runs?status=completed&branch=$branch&per_page=100" \
    | jq -r --arg repo "$repo" "$own_runs" | sort -k1,1nr) || lookup_failed "runs on $branch"
candidates+=${candidates:+$'\n'}$on_branch

tried=" "
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

while read -r id url head; do
    [ -n "$id" ] || continue
    if [ -n "$before_run" ] && [ "$id" -ge "$before_run" ]; then
        continue
    fi
    case "$tried" in *" $id "*) continue ;; esac
    tried+="$id "

    # A run that broke before the report job, or whose artifact expired, has nothing to give.
    found=$(gh api "repos/$repo/actions/runs/$id/artifacts?name=plugin-check-report" \
        --jq '[.artifacts[] | select(.expired | not)] | length') || lookup_failed "artifacts of run $id"
    [ "$found" -gt 0 ] || continue

    rm -rf "$tmp/report"
    gh run download "$id" --repo "$repo" --name plugin-check-report --dir "$tmp/report" > /dev/null \
        || lookup_failed "download of the artifact of run $id"
    [ -s "$tmp/report/baseline.json" ] || continue

    match=exact
    if [ -n "$sha" ] && [ "$head" != "$sha" ]; then
        match=older
    fi

    mkdir -p "$(dirname "$output")"
    cp "$tmp/report/baseline.json" "$output"
    echo "$id $url $match"
    exit 0
done <<< "$candidates"

echo "No Plugin Check run on $branch${sha:+ or $sha} has a baseline." >&2
exit 1
