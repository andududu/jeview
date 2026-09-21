#!/bin/sh
# Launch Jeview and open the viewer.
#   ./launch.sh [--port 4777] [--dir ~/.local/share/jeview] [--jev-endpoint URL]
# Uses the node on your PATH if it is 24 or later, else one installed by nvm or Homebrew.
# JEVIEW_NO_OPEN=1 starts Jeview without opening a browser.
set -eu

new_enough() { [ -n "$1" ] && [ -x "$1" ] && [ "$("$1" -p 'Number(process.versions.node.split(".")[0]) >= 24' 2>/dev/null)" = "true" ]; }

node="$(command -v node 2>/dev/null || true)"
if ! new_enough "$node"; then
  node=""
  for candidate in "$HOME"/.nvm/versions/node/v*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    if new_enough "$candidate"; then node="$candidate"; fi # any will do; the last one found is used
  done
fi
if [ -z "$node" ]; then
  echo "Jeview needs Node 24 or later, and none was found on your PATH, in ~/.nvm or in Homebrew." >&2
  echo "Install it from https://nodejs.org/ or with: nvm install 24" >&2
  exit 1
fi

# the port the viewer will be on, to open it
port=4777 previous=""
for argument in "$@"; do
  if [ "$previous" = "--port" ]; then port="$argument"; fi
  case "$argument" in --port=*) port="${argument#--port=}" ;; esac
  previous="$argument"
done

if [ -z "${JEVIEW_NO_OPEN:-}" ]; then
  case "$(uname)" in Darwin) opener=open ;; *) opener=xdg-open ;; esac
  if command -v "$opener" >/dev/null 2>&1; then (sleep 1; "$opener" "http://127.0.0.1:$port/" >/dev/null 2>&1 || true) & fi
fi
exec "$node" "$(dirname "$0")/jeview.ts" "$@" # from where you are, so a relative --dir means what you expect
