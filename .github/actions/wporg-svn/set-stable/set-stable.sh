#!/usr/bin/env bash
# Move the release pointer: put tags/<version>/readme.txt over trunk/readme.txt
# in one server-side commit, with no checkout. There is no upgrade-only rule:
# choosing an older tag rolls the release back.
ACTION_NAME="wporg-svn set-stable"
# shellcheck source=SCRIPTDIR/../lib/svn.sh
. "${BASH_SOURCE[0]%/*}/../lib/svn.sh"

require_tools svn svnmucc python3 cmp
validate_slug
validate_version
validate_expected_revision
validate_credentials
prepare

STAGE="reading tags/$VERSION and trunk"
snapshot
R=$REPLY
note_revision "snapshot r$R"
svn_kind "$BASE/tags" "$VERSION" "$R"
[ "$REPLY" = dir ] || fail "tags/$VERSION does not exist at r$R"
check_expected_revision "$R"
svn_kind "$BASE/tags/$VERSION" readme.txt "$R"
[ "$REPLY" = file ] || fail "tags/$VERSION/readme.txt is not a file at r$R"
svn_kind "$BASE/trunk" readme.txt "$R"
[ "$REPLY" = file ] || fail "trunk/readme.txt is not a file at r$R"
check_props "$BASE/tags/$VERSION/readme.txt" "$R" "tags/$VERSION/readme.txt"
check_props "$BASE/trunk/readme.txt" "$R" "trunk/readme.txt"
svn_cat "$BASE/tags/$VERSION/readme.txt" "$R" "$WORK/release-readme.txt"
svn_cat "$BASE/trunk/readme.txt" "$R" "$WORK/trunk-readme.txt"
STABLE=$(python3 "$LIB_DIR/release.py" stable-tag "$WORK/release-readme.txt")
[ "$STABLE" = "$VERSION" ] || fail "the Stable Tag in tags/$VERSION/readme.txt is not $VERSION"

if cmp -s "$WORK/release-readme.txt" "$WORK/trunk-readme.txt"; then
	output version "$VERSION"
	output revision "$R"
	summary "### $ACTION_NAME: verified no-op" "" \
		"trunk/readme.txt already matches tags/$VERSION/readme.txt at r$R. Nothing was committed."
	exit 0
fi

STAGE="committing trunk/readme.txt"
if ! mucc_write -r "$R" -m "Release $VERSION: set the Stable Tag" \
	put "$WORK/release-readme.txt" "$BASE/trunk/readme.txt"; then
	svn_error
	ERROR=$REPLY
	STAGE="inspecting trunk/readme.txt after a failed write"
	snapshot
	HEAD=$REPLY
	svn_cat "$BASE/trunk/readme.txt" "$HEAD" "$WORK/after-readme.txt"
	STAGE="committing trunk/readme.txt"
	if cmp -s "$WORK/release-readme.txt" "$WORK/after-readme.txt"; then
		fail "the write reported an error ($ERROR), but trunk/readme.txt now matches tags/$VERSION/readme.txt. Rerunning is safe: it verifies and reports a no-op."
	fi
	fail "the write failed ($ERROR) and trunk/readme.txt does not match tags/$VERSION/readme.txt at r$HEAD; check who else is committing (svn log) before rerunning."
fi
N=$REPLY
note_revision "commit r$N"

STAGE="verifying trunk/readme.txt at r$N"
svn_cat "$BASE/trunk/readme.txt" "$N" "$WORK/committed-readme.txt"
cmp -s "$WORK/release-readme.txt" "$WORK/committed-readme.txt" ||
	fail "trunk/readme.txt at r$N does not match tags/$VERSION/readme.txt"

output version "$VERSION"
output revision "$N"
summary "### $ACTION_NAME: $SLUG $VERSION" "" \
	"trunk/readme.txt now matches tags/$VERSION/readme.txt (r$N). WordPress.org processing happens separately."
