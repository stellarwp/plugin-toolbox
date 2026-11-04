#!/usr/bin/env bash

# Read Slic's current selection instead of trusting the target exported by setup:
# a caller may have selected another project between setup and suite execution.
select_slic_target() {
  local target="$1"
  local selection
  local current_target

  selection="$("${SLIC_BIN}" using)"
  current_target="$(printf '%s\n' "$selection" | sed -E $'s/\033\[[0-9;]*m//g' | sed -n 's/^Using //p')"

  if [ "$current_target" = "$target" ]; then
    return
  fi

  "${SLIC_BIN}" use "$target"
}

# Ask Slic for the selected project's host path so custom mounts and checkout layouts are respected.
slic_target_path() {
  local target="$1"
  local selection
  local path
  local slic_dir

  selection="$("${SLIC_BIN}" using)" || return $?
  path="$(printf '%s\n' "$selection" | sed -E $'s/\033\[[0-9;]*m//g' | sed -n 's/^Full target path: //p')"

  if [ -n "$path" ]; then
    printf '%s\n' "$path"
    return
  fi

  # Slic omits the full path when using its built-in plugins directory.
  slic_dir="$(dirname "${SLIC_BIN}")"

  path="${slic_dir}/_plugins/${target}"

  # Only the default plugin path is known here. Theme and site mounts may be customized.
  if [ "$target" = site ] || [ ! -d "$path" ]; then
    echo '::error::Slic did not report the project path. Supply output-path for test artifacts.' >&2
    return 1
  fi

  realpath -- "$path"
}
