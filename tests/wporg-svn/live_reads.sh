#!/usr/bin/env bash
# Test-only and read-only: run the actions' read helpers against a real
# wordpress.org plugin and print what they saw. It never calls a write helper,
# and the tests run it with the write guard first on PATH.
# Usage: live_reads.sh SLUG
ACTION_NAME="wporg-svn live reads"
# shellcheck source=SCRIPTDIR/../../.github/actions/wporg-svn/lib/svn.sh
. "${BASH_SOURCE[0]%/*}/../../.github/actions/wporg-svn/lib/svn.sh"

[ -z "${WPORG_SVN_TEST_ROOT:-}" ] || fail "live reads go to wordpress.org: unset WPORG_SVN_TEST_ROOT"
WPORG_SLUG=${1:-}
validate_slug
prepare

STAGE="reading $SLUG"
snapshot
R=$REPLY
echo "revision=$R"
svn_kind "$BASE/trunk" readme.txt "$R"
echo "trunk-readme=$REPLY"
svn_cat "$BASE/trunk/readme.txt" "$R" "$WORK/readme.txt"
S=$(python3 "$LIB_DIR/release.py" stable-tag "$WORK/readme.txt")
python3 "$LIB_DIR/release.py" version "$S" || fail "the Stable Tag is not numeric"
echo "stable=$S"
svn_kind "$BASE/tags" "$S" "$R"
echo "stable-kind=$REPLY"
svn_kind "$BASE/tags" 0.0.0.0.0.1 "$R"
echo "probe-kind=$REPLY"
svn_names "$BASE/tags" "$R"
echo "tags=$(printf '%s\n' "$REPLY" | python3 -c 'import sys; print(",".join(l.strip() for l in sys.stdin))')"
last_changed "$BASE/tags/$S" "$R"
echo "stable-last-changed=$REPLY"
check_tag_props "$BASE/tags/$S" "$R" "tags/$S"
echo "props=ok"
