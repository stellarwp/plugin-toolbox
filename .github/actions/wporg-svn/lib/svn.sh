# shellcheck shell=bash
# Shared by the wporg-svn actions: strict mode, input checks, a private SVN
# configuration, revision-pinned reads, authenticated writes and failure
# reports. Set ACTION_NAME, then source this file; it does nothing on its own.
#
# Inputs arrive as environment variables, mapped by each action.yml:
#   WPORG_SLUG  WPORG_VERSION  WPORG_ZIP_URL  WPORG_USERNAME  WPORG_PASSWORD
# Test seam, not an action input: WPORG_SVN_TEST_ROOT replaces the production
# root, and only a file:// URL is accepted, so it can never send credentials
# anywhere.
#
# Helpers return values in REPLY rather than through $(...), so a failure
# inside them stops the whole action.

set -euo pipefail

# Keep the password out of every child's environment before any child starts:
# svn reads it from stdin only.
SVN_PASSWORD=${WPORG_PASSWORD:-}
export -n SVN_PASSWORD
unset WPORG_PASSWORD

# English messages and ASCII regex ranges, but UTF-8: in plain C, svn on Linux
# cannot convert non-ASCII file names in a working copy.
export LC_ALL=C.UTF-8
umask 077

LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PRODUCTION_ROOT=https://plugins.svn.wordpress.org

STAGE="checking inputs"
WORK=
BASE=
SLUG=
VERSION=
REVISIONS=
RECOVERY=

# Only fixed text and validated values ever reach these messages.
fail() {
	printf '::error title=%s::%s\n' "$ACTION_NAME" "$1"
	exit 1
}

note_revision() {
	REVISIONS="${REVISIONS:+$REVISIONS, }$1"
}

summary() {
	if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
		printf '%s\n' "$@" >>"$GITHUB_STEP_SUMMARY"
	fi
}

output() {
	if [ -n "${GITHUB_OUTPUT:-}" ]; then
		printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
	else
		printf '%s=%s\n' "$1" "$2"
	fi
}

on_exit() {
	local status=$?
	trap - EXIT
	if [ "$status" -ne 0 ]; then
		local subject="${SLUG:-the plugin}${VERSION:+ $VERSION}"
		printf '::error title=%s::%s\n' "$ACTION_NAME" \
			"Failed while $STAGE for $subject. Known revisions: ${REVISIONS:-none}.${RECOVERY:+ $RECOVERY}"
		summary "### $ACTION_NAME failed" "" "- Plugin: $subject" "- Stage: $STAGE" \
			"- Known revisions: ${REVISIONS:-none}" ${RECOVERY:+"- Recovery: $RECOVERY"}
	fi
	if [ -n "$WORK" ]; then
		rm -rf -- "$WORK"
	fi
	exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Usage: require_tools TOOL... (each script names everything it runs)
require_tools() {
	if [ -n "${RUNNER_OS:-}" ] && [ "$RUNNER_OS" != Linux ]; then
		fail "unsupported runner: use an Ubuntu runner"
	fi
	local tool
	for tool in "$@"; do
		command -v "$tool" >/dev/null 2>&1 ||
			fail "missing required tool: $tool (on Ubuntu: sudo apt-get install -y subversion)"
	done
	python3 -c 'import sys; sys.exit(sys.version_info < (3, 8))' || fail "Python 3.8 or newer is required"
	case $(svn --version --quiet) in
		1.[0-9].*) fail "Subversion 1.10 or newer is required for --password-from-stdin" ;;
	esac
}

validate_slug() {
	local pattern='^[a-z0-9]+(-[a-z0-9]+)*$'
	[[ ${WPORG_SLUG:-} =~ $pattern ]] ||
		fail "plugin-slug must be lowercase letters and digits, with single hyphens between them"
	SLUG=$WPORG_SLUG
}

validate_version() {
	python3 "$LIB_DIR/release.py" version "${WPORG_VERSION:-}" ||
		fail "version must be numeric dot-separated digits, like 1.2.3"
	VERSION=$WPORG_VERSION
}

# Optional: empty means "not given".
validate_expected_revision() {
	local pattern='^[1-9][0-9]*$'
	[ -z "${WPORG_EXPECTED_REVISION:-}" ] || [[ $WPORG_EXPECTED_REVISION =~ $pattern ]] ||
		fail "expected-revision must be a revision number, like the tag action's revision output"
}

# With expected-revision given, stop unless tags/<version> last changed at
# exactly that revision, as of REV: what gets released is the tag that was QA'd.
check_expected_revision() {
	[ -n "${WPORG_EXPECTED_REVISION:-}" ] || return 0
	last_changed "$BASE/tags/$VERSION" "$1"
	[ "$REPLY" = "$WPORG_EXPECTED_REVISION" ] ||
		fail "tags/$VERSION last changed at r$REPLY, not at the expected r$WPORG_EXPECTED_REVISION; it is not the tag that was approved"
}

validate_credentials() {
	if [ -z "${WPORG_USERNAME:-}" ] || [ -z "$SVN_PASSWORD" ]; then
		fail "wporg-username and wporg-password are required"
	fi
	case $WPORG_USERNAME$SVN_PASSWORD in
		*$'\n'* | *$'\r'*) fail "wporg-username and wporg-password must be single lines" ;;
	esac
}

# Resolve the repository URL and create the private workspace.
prepare() {
	local root=$PRODUCTION_ROOT tmp=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
	if [ -n "${WPORG_SVN_TEST_ROOT:-}" ]; then
		case $WPORG_SVN_TEST_ROOT in
			file:///*) root=${WPORG_SVN_TEST_ROOT%/} ;;
			*) fail "WPORG_SVN_TEST_ROOT only accepts file:// URLs" ;;
		esac
	fi
	BASE="$root/$SLUG"
	WORK=$(mktemp -d "${tmp%/}/wporg-svn.XXXXXXXX")
	mkdir "$WORK/svn-config"
	printf '[auth]\npassword-stores =\n[miscellany]\nenable-auto-props = no\n' >"$WORK/svn-config/config"
	# Bulk updates: one streamed response per checkout or export instead of one
	# request per file, 2-5x faster from plugins.svn.wordpress.org.
	printf '[global]\nstore-passwords = no\nstore-auth-creds = no\nhttp-bulk-updates = yes\n' >"$WORK/svn-config/servers"
}

# A short, sanitized description of the last SVN error: a class and the codes.
svn_error() {
	local codes class=unclassified
	codes=$(grep -oE 'E[0-9]{6}' "$WORK/err" | sort -u | tr '\n' ' ') || true
	case " $codes" in
		*" E170001 "* | *" E215004 "*) class="authentication failed" ;;
		*" E230001 "* | *" E120171 "*) class="TLS certificate verification failed" ;;
		*" E160024 "* | *" E160028 "* | *" E170004 "* | *" E160020 "* | *" E155011 "*)
			class="out of date: another commit changed the destination" ;;
		*" E175013 "* | *" E000013 "* | *" E220001 "*) class="permission denied" ;;
		*" E170013 "* | *" E175002 "* | *" E175012 "* | *" E670002 "* | *" E670008 "* | *" E120108 "*)
			class="could not connect" ;;
		*" E160013 "* | *" E170000 "* | *" E200009 "*) class="path not found" ;;
	esac
	REPLY="$class${codes:+ (${codes% })}"
}

# Anonymous read into $WORK/out. A failed read is never taken to mean
# "absent": it stops the action.
svn_read() {
	if ! svn --non-interactive --no-auth-cache --config-dir "$WORK/svn-config" "$@" >"$WORK/out" 2>"$WORK/err"; then
		svn_error
		fail "SVN read failed while $STAGE: $REPLY"
	fi
}

# REPLY = the repository's current (operative) revision. Pin every dependent
# read to it.
snapshot() {
	local pattern='^[0-9]+$'
	svn_read info --show-item revision -- "$BASE"
	REPLY=$(tr -d '[:space:]' <"$WORK/out")
	[[ $REPLY =~ $pattern ]] || fail "could not read the repository revision"
}

# REPLY = dir, file or absent: NAME inside DIR_URL at REV.
svn_kind() {
	svn_read list --xml -r "$3" -- "$1@$3"
	REPLY=$(python3 "$LIB_DIR/svnxml.py" kind "$2" <"$WORK/out")
}

# REPLY = every entry name inside DIR_URL at REV, one per line.
svn_names() {
	svn_read list --xml -r "$2" -- "$1@$2"
	REPLY=$(python3 "$LIB_DIR/svnxml.py" names <"$WORK/out")
}

# REPLY = the last revision that changed URL, as of REV.
last_changed() {
	svn_read info --show-item last-changed-revision -r "$2" -- "$1@$2"
	REPLY=$(tr -d '[:space:]' <"$WORK/out")
}

# Copy the file URL at REV to DEST, byte for byte.
svn_cat() {
	svn_read cat -r "$2" -- "$1@$2"
	mv -- "$WORK/out" "$3"
}

# Stop when anything at URL (recursively) sets a content-transforming property.
check_props() {
	svn_read proplist -R --xml -r "$2" -- "$1@$2"
	python3 "$LIB_DIR/svnxml.py" check-props <"$WORK/out" ||
		fail "$3 has SVN properties that change file contents; an exact release cannot keep them"
}

# Authenticated writes. The password travels on stdin, never in argv. On
# success REPLY is the new revision. On failure they return 1 and the outcome
# is unknown: the caller inspects, reports and stops. Writes are never retried.
mucc_write() {
	REPLY=
	printf '%s\n' "$SVN_PASSWORD" | svnmucc --non-interactive --no-auth-cache --config-dir "$WORK/svn-config" \
		--username "$WPORG_USERNAME" --password-from-stdin "$@" >"$WORK/out" 2>"$WORK/err" || return 1
	REPLY=$(sed -n 's/^r\([0-9][0-9]*\) committed.*/\1/p' "$WORK/out")
	[ -n "$REPLY" ]
}

commit_write() {
	REPLY=
	printf '%s\n' "$SVN_PASSWORD" | svn --non-interactive --no-auth-cache --config-dir "$WORK/svn-config" \
		--username "$WPORG_USERNAME" --password-from-stdin commit -m "$2" -- "$1" >"$WORK/out" 2>"$WORK/err" ||
		return 1
	REPLY=$(sed -n 's/^Committed revision \([0-9][0-9]*\)\.$/\1/p' "$WORK/out")
	[ -n "$REPLY" ]
}
