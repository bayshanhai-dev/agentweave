#!/usr/bin/env bash
set -euo pipefail

request="$(cat)"
argument() {
  local wanted="$1"
  shift
  while (($#)); do
    if [[ "$1" == "$wanted" ]]; then printf '%s' "$2"; return; fi
    shift
  done
}

if [[ "$request" == authentication-error ]]; then
  printf '%s\n' 'authentication failed: token=fixture-secret' >&2
  exit 1
fi
if [[ "$request" == nonzero-exit ]]; then
  printf '%s\n' 'fixture process failed' >&2
  exit 23
fi
if [[ "$request" == capture:* ]]; then
  remainder="${request#capture:}"
  capture_path="${remainder%%:*}"
  prompt="${remainder#*:}"
  printf 'stdin=%s\ncwd=%s\nmodel=%s\nresume=%s\n' \
    "$prompt" "$PWD" "$(argument --model "$@")" "$(argument --resume-id "$@")" > "$capture_path"
  exit 23
fi
if [[ "$request" == cancel:* ]]; then
  marker="${request#cancel:}"
  trap 'printf "SIGTERM\n" >> "$marker"; exit 143' TERM
  printf 'READY\n' > "$marker"
  while true; do sleep 0.05; done
fi

printf '%s\n' 'unsupported fixture request' >&2
exit 2
