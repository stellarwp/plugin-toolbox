#!/usr/bin/env bash
# Prepare a release without moving the stable pointer: copy the stable tag into
# an otherwise empty working copy as tags/<version>, make it match the ZIP
# exactly and commit it. trunk and existing tags stay as they are.
#
# This is one commit: tags/<version> appears complete, or not at all. The
# commit records a copy of the stable tag, so only changed files are uploaded.
ACTION_NAME="wporg-svn tag"
# shellcheck source=SCRIPTDIR/../lib/svn.sh
. "${BASH_SOURCE[0]%/*}/../lib/svn.sh"

# Keep in step with MAX_ARCHIVE_BYTES in lib/archive.py.
MAX_ZIP_BYTES=268435456

require_tools svn python3 curl
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
	# curl before 8.4 ignores --max-filesize when the server sends no length, so a
	# file size limit (1 KiB blocks, this subshell only) stops it too: SIGXFSZ, 153.
	code=$(ulimit -f $((MAX_ZIP_BYTES / 1024 + 1)) &&
		curl -q --silent --show-error --fail --location --proto '=https' --proto-redir '=https' \
			--max-redirs 5 --connect-timeout 30 --max-time 600 --retry 3 --retry-delay 5 --retry-max-time 900 \
			--max-filesize "$MAX_ZIP_BYTES" --write-out '%{http_code}' --output "$WORK/artifact.zip" \
			"$WPORG_ZIP_URL" 2>"$WORK/err") || status=$?
	if [ "$status" -eq 63 ] || [ "$status" -eq 153 ]; then
		fail "downloading zip-url failed: the ZIP is larger than $((MAX_ZIP_BYTES / 1048576)) MiB"
	fi
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
last_changed "$BASE/tags/$S" "$R"
SOURCE_CHANGED=$REPLY

# Stop with MESSAGE when anything in the new tag sets a content-transforming property.
check_tag_props() {
	svn_read proplist -R --xml -- "$TAG"
	python3 "$LIB_DIR/svnxml.py" check-props <"$WORK/out" || fail "$1"
}

STAGE="copying tags/$S into a working copy"
WC="$WORK/wc"
TAG="$WC/$VERSION"
svn_read checkout --quiet --depth empty -r "$R" -- "$BASE/tags@$R" "$WC"
svn_read copy --quiet --ignore-externals -r "$R" -- "$BASE/tags/$S@$R" "$TAG"
check_tag_props "tags/$S has SVN properties that change file contents; an exact release cannot keep them"

STAGE="synchronising tags/$VERSION with the artifact"
python3 "$LIB_DIR/tree.py" sync "$ROOT" "$TAG"
CHANGES=$(python3 "$LIB_DIR/tree.py" reconcile "$TAG" "$WORK/svn-config")
check_tag_props "the working copy of tags/$VERSION has SVN properties that change file contents"

STAGE="validating tags/$VERSION before the commit"
[ "$(release_py plugin-version "$TAG")" = "$VERSION" ] || fail "the working copy's plugin Version is not $VERSION"
[ "$(release_py stable-tag "$TAG/readme.txt")" = "$VERSION" ] || fail "the working copy's Stable Tag is not $VERSION"
python3 "$LIB_DIR/tree.py" compare "$ROOT" "$TAG" || fail "the working copy does not match the artifact"
[ "$CHANGES" -gt 0 ] || fail "the artifact is identical to tags/$S; there is nothing to release"

STAGE="rechecking before the commit"
snapshot
note_revision "recheck r$REPLY"
RECHECK=$REPLY
stable_at "$RECHECK"
[ "$REPLY" = "$S" ] || fail "the trunk/readme.txt Stable Tag changed after r$R; another release is in progress"
last_changed "$BASE/tags/$S" "$RECHECK"
[ "$REPLY" = "$SOURCE_CHANGED" ] || fail "tags/$S changed after r$R"
destination_absent "$RECHECK"

STAGE="committing tags/$VERSION"
RECOVERY="The commit's outcome is unknown: if tags/$VERSION exists, do not approve or release it until it is verified against the ZIP (wporg-svn README, Recovery)."
if ! commit_write "$TAG" "Release $VERSION: create tags/$VERSION from the artifact"; then
	svn_error
	ERROR=$REPLY
	STAGE="inspecting tags/$VERSION after a failed commit"
	snapshot
	HEAD=$REPLY
	svn_kind "$BASE/tags" "$VERSION" "$HEAD"
	STAGE="committing tags/$VERSION"
	if [ "$REPLY" = absent ]; then
		RECOVERY=
		fail "the commit failed ($ERROR) and tags/$VERSION does not exist at r$HEAD, so nothing was written. Rerun once the cause is fixed."
	fi
	RECOVERY="tags/$VERSION exists at r$HEAD, but this run cannot confirm that it created it. Do not approve or release it: inspect it first (wporg-svn README, Recovery)."
	fail "the commit reported an error ($ERROR) and tags/$VERSION now exists"
fi
N=$REPLY
note_revision "commit r$N"
RECOVERY="tags/$VERSION was created at r$N but not verified against the artifact. Do not approve or release it until it is (wporg-svn README, Recovery)."

STAGE="verifying tags/$VERSION at r$N"
svn_read export --quiet --ignore-externals -r "$N" -- "$BASE/tags/$VERSION@$N" "$WORK/verify"
python3 "$LIB_DIR/tree.py" compare "$ROOT" "$WORK/verify" || fail "tags/$VERSION at r$N does not match the artifact"

RECOVERY=
output version "$VERSION"
output revision "$N"
output previous-stable "$S"
summary "### $ACTION_NAME: $SLUG $VERSION" "" \
	"- tags/$VERSION created at r$N as a copy of tags/$S@$R that matches the artifact, and verified." \
	"- The stable pointer is unchanged. QA tags/$VERSION@$N, then run set-stable and update-trunk."
