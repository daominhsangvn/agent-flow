#!/usr/bin/env bash
# Scoped lint/typecheck/test gates for af-delivery runs.
#
#   verify.sh baseline <RUN_DIR>           record pre-existing changes (phase 0)
#   verify.sh quick|full <RUN_DIR> <label> run the gates on the run's own changes
#
# Full logs go to RUN_DIR/logs/; stdout is a short summary so agent contexts stay small.
# Exit: 0 pass, 1 code failure, 2 environment problem. Written for macOS bash 3.2.

set -u

MODE="${1:-}"
RUN_DIR="${2:-}"
LABEL="${3:-check}"
TAIL_LINES=40

if [ -z "$MODE" ] || [ -z "$RUN_DIR" ]; then
  echo "usage: verify.sh baseline|quick|full <RUN_DIR> [label]" >&2
  exit 2
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "ENV not a git repo" >&2; exit 2; }
cd "$ROOT" || exit 2
case "$RUN_DIR" in /*) ;; *) RUN_DIR="$ROOT/$RUN_DIR" ;; esac
mkdir -p "$RUN_DIR/logs"
BASELINE="$RUN_DIR/01_baseline.txt"

# Every modified/untracked path with its content hash, excluding harness run files.
list_dirty() {
  { git diff --name-only HEAD; git ls-files --others --exclude-standard; } \
    | grep -v '^\.harness/' | sort -u | while IFS= read -r f; do
      if [ -f "$f" ]; then
        printf '%s\t%s\n' "$f" "$(git hash-object "$f")"
      else
        printf '%s\t%s\n' "$f" "deleted"
      fi
    done
}

if [ "$MODE" = "baseline" ]; then
  list_dirty > "$BASELINE"
  echo "baseline: $(wc -l < "$BASELINE" | tr -d ' ') pre-existing changed paths -> $BASELINE"
  exit 0
fi

if [ "$MODE" != "quick" ] && [ "$MODE" != "full" ]; then
  echo "unknown mode: $MODE" >&2
  exit 2
fi

# Agent shells are non-login: the default Node may lack pnpm, so switch to the .nvmrc version.
if ! command -v pnpm >/dev/null 2>&1 && [ -f .nvmrc ] && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1
  nvm use >/dev/null 2>&1
fi
command -v pnpm >/dev/null 2>&1 || { echo "ENV pnpm not found (nvm use / corepack enable)"; exit 2; }
[ -d node_modules ] || { echo "ENV node_modules missing: run pnpm install"; exit 2; }

# Files the run changed: dirty now and not identical to the baseline entry.
CHANGED_FILE="$RUN_DIR/logs/$LABEL-changed.txt"
list_dirty | while IFS="$(printf '\t')" read -r path hash; do
  if [ -f "$BASELINE" ] && grep -qxF "$(printf '%s\t%s' "$path" "$hash")" "$BASELINE"; then
    continue
  fi
  [ "$hash" = "deleted" ] || echo "$path"
done > "$CHANGED_FILE"

if [ ! -s "$CHANGED_FILE" ]; then
  echo "SKIP no changed files since baseline"
  exit 0
fi
echo "changed: $(wc -l < "$CHANGED_FILE" | tr -d ' ') files (list: $CHANGED_FILE)"

STATUS=0

# run_gate <name> <log> <cmd...>: runs cmd, prints PASS/FAIL and the failing tail.
run_gate() {
  local name="$1" log="$2"
  shift 2
  if "$@" > "$log" 2>&1; then
    echo "PASS $name"
  else
    echo "FAIL $name (log: ${log#"$ROOT"/})"
    tail -n "$TAIL_LINES" "$log" | sed 's/^/  | /'
    STATUS=1
  fi
}

# --- lint ---------------------------------------------------------------
LINT_FILES="$(grep -E '\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|css)$' "$CHANGED_FILE" | tr '\n' ' ')"
if [ -n "$LINT_FILES" ]; then
  # shellcheck disable=SC2086
  run_gate "lint" "$RUN_DIR/logs/$LABEL-lint.log" \
    npx biome check --no-errors-on-unmatched $LINT_FILES
else
  echo "SKIP lint (no lintable files)"
fi

# --- affected workspaces -------------------------------------------------
WORKSPACES="$(grep -oE '^(apps|packages)/[^/]+' "$CHANGED_FILE" | sort -u)"
if [ -z "$WORKSPACES" ]; then
  echo "SKIP typecheck/test (no workspace files changed)"
  exit "$STATUS"
fi

if grep -q '^packages/database/prisma/schema.prisma$' "$CHANGED_FILE"; then
  run_gate "db:generate" "$RUN_DIR/logs/$LABEL-db-generate.log" \
    pnpm --filter @repo/database db:generate
fi

has_script() {
  node -e 'const p=require(process.argv[1]);process.exit(p.scripts&&p.scripts[process.argv[2]]?0:1)' \
    "$ROOT/$1/package.json" "$2" 2>/dev/null
}
pkg_name() {
  node -p 'require(process.argv[1]).name' "$ROOT/$1/package.json" 2>/dev/null
}

# --- typecheck -----------------------------------------------------------
TC_FILTERS=""
for ws in $WORKSPACES; do
  [ -f "$ws/package.json" ] || continue
  has_script "$ws" typecheck || continue
  name="$(pkg_name "$ws")"
  if [ "$MODE" = "full" ]; then
    TC_FILTERS="$TC_FILTERS --filter=...$name"
  else
    TC_FILTERS="$TC_FILTERS --filter=$name"
  fi
done
if [ -n "$TC_FILTERS" ]; then
  # shellcheck disable=SC2086
  run_gate "typecheck" "$RUN_DIR/logs/$LABEL-typecheck.log" \
    pnpm turbo typecheck --output-logs=errors-only $TC_FILTERS
else
  echo "SKIP typecheck (no workspace with a typecheck script)"
fi

# --- tests ---------------------------------------------------------------
# vitest_related <ws> <config|""> <path regex>: related tests for the workspace's changed files.
vitest_related() {
  local ws="$1" config="$2" pattern="$3" files
  files="$(grep "^$ws/" "$CHANGED_FILE" | grep -E "$pattern" | sed "s#^$ws/##" | tr '\n' ' ')"
  [ -n "$files" ] || return 0
  local tag
  tag="$(basename "$ws")${config:+-$(basename "$config" .ts)}"
  # shellcheck disable=SC2086
  run_gate "test $tag (related)" "$RUN_DIR/logs/$LABEL-test-$tag.log" \
    env NODE_ENV=test pnpm -C "$ws" exec vitest related --run --passWithNoTests \
    ${config:+--config "$config"} $files
}

for ws in $WORKSPACES; do
  [ -f "$ws/package.json" ] || continue
  has_script "$ws" test || continue
  name="$(pkg_name "$ws")"
  if [ "$MODE" = "full" ]; then
    if [ "$ws" = "apps/desktop" ]; then
      run_gate "test desktop (full)" "$RUN_DIR/logs/$LABEL-test-desktop.log" pnpm desktop:test
    else
      run_gate "test $name (full)" "$RUN_DIR/logs/$LABEL-test-$(basename "$ws").log" \
        pnpm turbo test --output-logs=errors-only "--filter=$name"
    fi
    continue
  fi
  if [ "$ws" = "apps/desktop" ]; then
    vitest_related "$ws" vitest.renderer.config.ts '^apps/desktop/src/renderer/.*\.(ts|tsx)$'
    # The desktop Vitest node lane is broken locally; run changed main-process tests with tsx.
    desktop_tests="$(grep -E '^apps/desktop/(src/(server|main|headless)|scripts|test)/.*\.test\.(ts|mts)$' "$CHANGED_FILE" \
      | sed 's#^apps/desktop/##' | tr '\n' ' ')"
    if [ -n "$desktop_tests" ]; then
      # shellcheck disable=SC2086
      run_gate "test desktop-node (changed tests)" "$RUN_DIR/logs/$LABEL-test-desktop-node.log" \
        pnpm -C apps/desktop exec tsx --test $desktop_tests
    fi
  elif ls "$ws"/vitest.config.* >/dev/null 2>&1; then
    vitest_related "$ws" "" '\.(ts|tsx|mts|js|mjs)$'
  else
    echo "SKIP test $name (no vitest config; run its test script in full mode)"
  fi
done

exit "$STATUS"
