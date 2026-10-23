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

if [[ "$request" == malformed-and-unknown ]]; then
  printf '%s\n' 'not-json' '{"type":"future.event","data":{"ignored":true}}' '{"type":"content","data":{"text":"survived"}}' '{"type":"completion"}'
  exit 0
fi

model="$(argument --model "$@")"
resumed="$(argument --resume-id "$@")"
session="${resumed:-fixture-session}"
printf '{"type":"session.started","data":{"sessionId":"%s"}}\n' "$session"
printf '%s\n' '{"type":"content","data":{"text":"hello "}}'
sleep 0.01
details="{\"stdin\":\"$request\""
[[ -n "$model" ]] && details+=",\"model\":\"$model\""
[[ -n "$resumed" ]] && details+=",\"resumed\":\"$resumed\""
details+='}'
escaped="${details//\"/\\\"}"
printf '{"type":"content","data":{"text":"%s"}}\n' "$escaped"
printf '%s\n' '{"type":"usage","data":{"inputTokens":7,"outputTokens":3,"totalTokens":10}}' '{"type":"completion"}'
