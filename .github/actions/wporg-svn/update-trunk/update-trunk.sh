#!/usr/bin/env bash
# Post-release housekeeping: replace trunk with tags/<version> in one atomic
# commit (rm + copy of the tag pinned at the snapshot revision). No checkout,
# export or local transfer. This also replaces trunk/readme.txt, so it refuses
# to run until set-stable has pointed trunk's Stable Tag at the version.
ACTION_NAME="wporg-svn update-trunk"
# shellcheck source=SCRIPTDIR/../lib/svn.sh
. "${BASH_SOURCE[0]%/*}/../lib/svn.sh"

require_tools svn svnmucc python3
validate_slug
validate_version
validate_expected_revision
validate_credentials
prepare

STAGE="reading trunk and tags/$VERSION"
snapshot
R=$REPLY
note_revision "snapshot r$R"
svn_kind "$BASE" trunk "$R"
[ "$REPLY" = dir ] || fail "trunk does not exist at r$R"
svn_kind "$BASE/tags" "$VERSION" "$R"
[ "$REPLY" = dir ] || fail "tags/$VERSION does not exist at r$R"
check_expected_revision "$R"
svn_kind "$BASE/trunk" readme.txt "$R"
[ "$REPLY" = file ] || fail "trunk/readme.txt is not a file at r$R"
svn_cat "$BASE/trunk/readme.txt" "$R" "$WORK/trunk-readme.txt"
[ "$(python3 "$LIB_DIR/release.py" stable-tag "$WORK/trunk-readme.txt")" = "$VERSION" ] ||
	fail "the trunk/readme.txt Stable Tag is not $VERSION at r$R; run set-stable for $VERSION first"

# trunk and the tag hold the same tree, files and properties, at REV?
same_tree() {
	local status=0
	svn_read diff --summarize --xml --old="$BASE/tags/$VERSION@$R" --new="$BASE/trunk@$1"
	python3 "$LIB_DIR/svnxml.py" diff-empty <"$WORK/out" 2>/dev/null || status=$?
	[ "$status" -le 1 ] || fail "could not read svn's diff output"
	return "$status"
}

if same_tree "$R"; then
	output version "$VERSION"
	output revision "$R"
	summary "### $ACTION_NAME: verified no-op" "" "trunk already matches tags/$VERSION at r$R. Nothing was committed."
	exit 0
fi

STAGE="replacing trunk with tags/$VERSION@$R"
if ! mucc_write -r "$R" -m "Release $VERSION: sync trunk with tags/$VERSION" \
	rm "$BASE/trunk" cp "$R" "$BASE/tags/$VERSION" "$BASE/trunk"; then
	svn_error
	ERROR=$REPLY
	STAGE="inspecting trunk after a failed write"
	snapshot
	if same_tree "$REPLY"; then
		STAGE="replacing trunk with tags/$VERSION@$R"
		fail "the write reported an error ($ERROR), but trunk now matches tags/$VERSION. Rerunning is safe: it verifies and reports a no-op."
	fi
	STAGE="replacing trunk with tags/$VERSION@$R"
	fail "the write failed ($ERROR); trunk was not changed by this run. Check who else is committing before rerunning."
fi
N=$REPLY
note_revision "commit r$N"

STAGE="verifying trunk at r$N"
same_tree "$N" || fail "trunk at r$N does not match tags/$VERSION@$R"

output version "$VERSION"
output revision "$N"
summary "### $ACTION_NAME: $SLUG $VERSION" "" "trunk is now a copy of tags/$VERSION@$R (r$N)."
