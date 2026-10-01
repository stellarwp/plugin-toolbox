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
