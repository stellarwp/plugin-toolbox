#!/usr/bin/env bash
set -euo pipefail

# Use the same checkout layout as `slic here`, including sibling checkouts outside the workspace.
project_parent="${HERE_DIR:-${GITHUB_WORKSPACE}}"
targets=("${TARGET}")

while IFS= read -r line; do
  read -r target _ <<< "${line}"

  if [ -n "${target}" ] && [[ "${target}" != \#* ]]; then
    targets+=("${target}")
  fi
done <<< "${COMPOSER_INSTALL}"

# Different targets and flags can download different packages, even with identical lockfiles.
install_hash=$(printf '%s\0' "${TARGET}" "${COMPOSER_INSTALL}" | sha256sum)
install_hash="${install_hash%% *}"

dependency_hash=$(
  for target in "${targets[@]}"; do
    # Hash standard plugin, theme and site locations without selecting targets or starting services.
    directories=("${project_parent}/${target}")

    if [ "${target}" = site ]; then
      directories=("${project_parent}")
    elif [ "$(basename "${project_parent}")" = themes ]; then
      directories+=("${project_parent}/../plugins/${target}")
    elif [ -f "${project_parent}/wp-config.php" ]; then
      directories=(
        "${project_parent}/wp-content/plugins/${target}"
        "${project_parent}/wp-content/themes/${target}"
        "${project_parent}/content/plugins/${target}"
        "${project_parent}/content/themes/${target}"
      )
    fi

    for directory in "${directories[@]}"; do
      for manifest in composer.json composer.lock; do
        file="${directory}/${manifest}"
        printf '%s\0' "${target}/${manifest}"

        if [ -f "${file}" ]; then
          # Hash contents without absolute paths so different runners produce the same key.
          sha256sum < "${file}"
        else
          printf 'missing\n'
        fi
      done
    done
  done | sha256sum
)
dependency_hash="${dependency_hash%% *}"

prefix="${RUNNER_OS}-slic-composer-v2"
install_prefix="${prefix}-${install_hash}"
php_prefix="${install_prefix}-php${PHP_VERSION}"
dependency_prefix="${php_prefix}-${dependency_hash}"
# Exact cache hits cannot be updated. Weekly rotation lets unlocked projects save new downloads.
week=$(date -u +%G-W%V)

{
  echo "key=${dependency_prefix}-${week}"
  echo 'restore-keys<<SLIC_CACHE_KEYS'
  echo "${dependency_prefix}-"
  echo "${php_prefix}-"
  echo "${install_prefix}-"
  echo "${prefix}-"
  echo 'SLIC_CACHE_KEYS'
} >> "$GITHUB_OUTPUT"
