#!/usr/bin/env bash
# Prepare a release without moving the stable pointer: copy the stable tag to
# tags/<version> on the server, check out only that new tag, make it match the
# ZIP exactly and commit the difference. trunk and existing tags stay as they are.
#
# This takes two commits. Between them tags/<version> is public but still holds
# the previous release. A failure there is reported loudly and the tag is
# never cleaned up or reused automatically.
ACTION_NAME="wporg-svn tag"
# shellcheck source=SCRIPTDIR/../lib/svn.sh
. "${BASH_SOURCE[0]%/*}/../lib/svn.sh"

# Keep in step with MAX_ARCHIVE_BYTES in lib/archive.py.
MAX_ZIP_BYTES=268435456

require_tools svn svnmucc svnrdump python3 curl
validate_slug
validate_credentials
[ -n "${WPORG_ZIP_URL:-}" ] || fail "zip-url is required"
case $WPORG_ZIP_URL in
	https://*) ;;
	*) fail "zip-url must be an https:// URL" ;;
esac
case $WPORG_ZIP_URL in
	*[[:space:][:cntrl:]]*) fail "zip-url must not contain spaces or control characters" ;;
esac
prepare

release_py() {
	python3 "$LIB_DIR/release.py" "$@"
}

# REPLY = the numeric Stable Tag in trunk/readme.txt at REV.
stable_at() {
	svn_kind "$BASE/trunk" readme.txt "$1"
	[ "$REPLY" = file ] || fail "trunk/readme.txt is not a file at r$1"
	svn_cat "$BASE/trunk/readme.txt" "$1" "$WORK/trunk-readme.txt"
	REPLY=$(release_py stable-tag "$WORK/trunk-readme.txt")
	release_py version "$REPLY" ||
		fail "the trunk/readme.txt Stable Tag is not a numeric version; first releases are not supported"
}

# Fail when tags/<version>, or another spelling of the same version, exists at REV.
destination_absent() {
	local found
	svn_names "$BASE/tags" "$1"
	found=$(printf '%s\n' "$REPLY" | release_py equivalents "$VERSION")
	if [ -n "$found" ]; then
		fail "tags/$VERSION already exists at r$1 (or under an equivalent spelling); released tags are never reused"
	fi
}

# Fetch zip-url over HTTPS only. Nothing about the URL is ever printed: signed
# URLs are secrets. No credentials are sent to the artifact host.
download() {
	local code status=0
	code=$(curl -q --silent --show-error --fail --location --proto '=https' --proto-redir '=https' \
		--max-redirs 5 --connect-timeout 30 --max-time 600 --retry 3 --retry-delay 5 --retry-max-time 900 \
		--max-filesize "$MAX_ZIP_BYTES" --write-out '%{http_code}' --output "$WORK/artifact.zip" \
		"$WPORG_ZIP_URL" 2>"$WORK/err") || status=$?
	if [ "$status" -ne 0 ]; then
		if [[ $code =~ ^[1-9][0-9][0-9]$ ]]; then
			fail "downloading zip-url failed (HTTP $code)"
		fi
		fail "downloading zip-url failed (curl exit $status)"
	fi
}

STAGE="reading the current release"
snapshot
R=$REPLY
note_revision "snapshot r$R"
stable_at "$R"
S=$REPLY
svn_kind "$BASE/tags" "$S" "$R"
[ "$REPLY" = dir ] || fail "the stable tag tags/$S does not exist at r$R"

STAGE="downloading the artifact"
download

STAGE="inspecting the artifact"
mkdir "$WORK/artifact"
ROOT=$(python3 "$LIB_DIR/archive.py" extract "$WORK/artifact.zip" "$WORK/artifact")
VERSION=$(release_py plugin-version "$ROOT")
[ "$(release_py compare "$VERSION" "$S")" = gt ] || fail "the plugin version $VERSION is not newer than the stable $S"
[ "$(release_py stable-tag "$ROOT/readme.txt")" = "$VERSION" ] ||
	fail "the Stable Tag in the artifact readme.txt is not $VERSION"

STAGE="checking tags/$VERSION and tags/$S"
destination_absent "$R"
check_tag_props "$BASE/tags/$S" "$R" "tags/$S"
last_changed "$BASE/tags/$S" "$R"
SOURCE_CHANGED=$REPLY

STAGE="rechecking before the copy"
snapshot
note_revision "recheck r$REPLY"
RECHECK=$REPLY
stable_at "$RECHECK"
[ "$REPLY" = "$S" ] || fail "the trunk/readme.txt Stable Tag changed after r$R; another release is in progress"
last_changed "$BASE/tags/$S" "$RECHECK"
[ "$REPLY" = "$SOURCE_CHANGED" ] || fail "tags/$S changed after r$R"
destination_absent "$RECHECK"

STAGE="copying tags/$S to tags/$VERSION"
RECOVERY="The copy's outcome is unknown: if tags/$VERSION exists, treat it as INCOMPLETE. Do not approve or release it (wporg-svn README, Recovery)."
if ! mucc_write -r "$R" -m "Prepare release $VERSION: copy tags/$S" cp "$R" "$BASE/tags/$S" "$BASE/tags/$VERSION"; then
	svn_error
	ERROR=$REPLY
	STAGE="inspecting tags/$VERSION after a failed copy"
	snapshot
	HEAD=$REPLY
	svn_kind "$BASE/tags" "$VERSION" "$HEAD"
	STAGE="copying tags/$S to tags/$VERSION"
	if [ "$REPLY" = absent ]; then
		RECOVERY=
		fail "the copy failed ($ERROR) and tags/$VERSION does not exist at r$HEAD, so nothing was written. Rerun once the cause is fixed."
	fi
	RECOVERY="tags/$VERSION exists at r$HEAD, but this run cannot confirm that it created it. Do not approve or release it: inspect it first (wporg-svn README, Recovery)."
	fail "the copy reported an error ($ERROR) and tags/$VERSION now exists"
fi
C=$REPLY
note_revision "copy r$C"
RECOVERY="tags/$VERSION exists since r$C and is INCOMPLETE: it still holds the $S files. Do not approve or release it. Follow the wporg-svn README, Recovery; a rerun refuses to reuse it."

STAGE="checking out tags/$VERSION"
WC="$WORK/wc"
svn_read checkout --quiet --ignore-externals -r "$C" -- "$BASE/tags/$VERSION@$C" "$WC"

STAGE="synchronising tags/$VERSION with the artifact"
python3 "$LIB_DIR/tree.py" sync "$ROOT" "$WC"
CHANGES=$(python3 "$LIB_DIR/tree.py" reconcile "$WC" "$WORK/svn-config")
svn_read proplist -R --xml -- "$WC"
python3 "$LIB_DIR/svnxml.py" check-props <"$WORK/out" ||
	fail "the working copy of tags/$VERSION has SVN properties that change file contents"

STAGE="validating tags/$VERSION before the commit"
[ "$(release_py plugin-version "$WC")" = "$VERSION" ] || fail "the working copy's plugin Version is not $VERSION"
[ "$(release_py stable-tag "$WC/readme.txt")" = "$VERSION" ] || fail "the working copy's Stable Tag is not $VERSION"
python3 "$LIB_DIR/tree.py" compare "$ROOT" "$WC" || fail "the working copy does not match the artifact"
[ "$CHANGES" -gt 0 ] || fail "the artifact is identical to tags/$S; there is nothing to release"

STAGE="checking tags/$VERSION is unchanged since r$C"
snapshot
last_changed "$BASE/tags/$VERSION" "$REPLY"
[ "$REPLY" = "$C" ] || fail "tags/$VERSION changed after r$C; someone else is writing to it"

STAGE="committing the artifact to tags/$VERSION"
if ! commit_write "$WC" "Release $VERSION: populate tags/$VERSION from the artifact"; then
	svn_error
	ERROR=$REPLY
	STAGE="inspecting tags/$VERSION after a failed commit"
	snapshot
	last_changed "$BASE/tags/$VERSION" "$REPLY"
	STAGE="committing the artifact to tags/$VERSION"
	if [ "$REPLY" = "$C" ]; then
		fail "the commit failed ($ERROR); tags/$VERSION is unchanged since r$C"
	fi
	fail "the commit reported an error ($ERROR) and tags/$VERSION changed at r$REPLY; this run cannot confirm what it holds"
fi
N=$REPLY
note_revision "commit r$N"
RECOVERY="tags/$VERSION was populated at r$N but not verified against the artifact. Do not approve or release it until it is (wporg-svn README, Recovery)."

STAGE="verifying tags/$VERSION at r$N"
svn_read export --quiet --ignore-externals -r "$N" -- "$BASE/tags/$VERSION@$N" "$WORK/verify"
python3 "$LIB_DIR/tree.py" compare "$ROOT" "$WORK/verify" || fail "tags/$VERSION at r$N does not match the artifact"

RECOVERY=
output version "$VERSION"
output revision "$N"
output previous-stable "$S"
output copy-revision "$C"
summary "### $ACTION_NAME: $SLUG $VERSION" "" \
	"- tags/$VERSION copied from tags/$S@$R at r$C, populated from the artifact at r$N and verified." \
	"- The stable pointer is unchanged. QA tags/$VERSION@$N, then run set-stable and update-trunk."
