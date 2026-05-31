#!/usr/bin/env bash
# =============================================================================
# Aegis CI pipeline
#
# Usage:
#   ./scripts/pipeline.sh [--task "your task"] [--tenant <id>] [--env <file>]
#                         [--skip-lint] [--skip-tests] [--skip-task]
#                         [--poll-interval <s>] [--timeout <s>]
#
# Environment (can also be set in .env or passed via --env):
#   AEGIS_API_KEY       API key for the target deployment
#   AEGIS_BASE_URL      Base URL of the Aegis server  (default: http://localhost:3000)
#   AEGIS_TENANT        Tenant to submit the task under (default: default)
#   AEGIS_TASK          Task description to submit      (overridden by --task)
#
# Exit codes:
#   0  all stages passed
#   1  lint, tests, or task submission failed
#   2  workflow timed out or ended in a non-success state
#   3  configuration error (missing required variables / tools)
# =============================================================================

set -euo pipefail

# ─── colour helpers ───────────────────────────────────────────────────────────

BOLD=$'\033[1m'
RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
CYAN=$'\033[36m'
RESET=$'\033[0m'

info()    { echo "${CYAN}${BOLD}[pipeline]${RESET} $*"; }
success() { echo "${GREEN}${BOLD}[pipeline] ✔${RESET} $*"; }
warn()    { echo "${YELLOW}${BOLD}[pipeline] ⚠${RESET}  $*" >&2; }
fail()    { echo "${RED}${BOLD}[pipeline] ✘${RESET} $*" >&2; }
die()     { fail "$*"; exit "${EXIT_CODE:-1}"; }

# ─── defaults ─────────────────────────────────────────────────────────────────

BASE_URL="${AEGIS_BASE_URL:-http://localhost:3000}"
TENANT="${AEGIS_TENANT:-default}"
TASK="${AEGIS_TASK:-}"
ENV_FILE=".env"
SKIP_LINT=false
SKIP_TESTS=false
SKIP_TASK=false
POLL_INTERVAL=5      # seconds between workflow status polls
TIMEOUT=300          # seconds before we give up polling

# ─── argument parsing ─────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task)           TASK="$2";          shift 2 ;;
    --tenant)         TENANT="$2";        shift 2 ;;
    --env)            ENV_FILE="$2";      shift 2 ;;
    --skip-lint)      SKIP_LINT=true;     shift   ;;
    --skip-tests)     SKIP_TESTS=true;    shift   ;;
    --skip-task)      SKIP_TASK=true;     shift   ;;
    --poll-interval)  POLL_INTERVAL="$2"; shift 2 ;;
    --timeout)        TIMEOUT="$2";       shift 2 ;;
    -h|--help)
      sed -n '3,17p' "$0" | sed 's/^# \{0,2\}//'
      exit 0
      ;;
    *) die "Unknown argument: $1. Run with --help for usage." ;;
  esac
done

# ─── load .env if present ─────────────────────────────────────────────────────

if [[ -f "$ENV_FILE" ]]; then
  info "Loading environment from $ENV_FILE"
  # Export only lines that look like KEY=value; skip comments and blanks.
  set -o allexport
  # shellcheck disable=SC1090
  source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" | grep -v '^#')
  set +o allexport
  # Re-resolve vars that may have been set by the env file
  BASE_URL="${AEGIS_BASE_URL:-$BASE_URL}"
  TENANT="${AEGIS_TENANT:-$TENANT}"
  TASK="${AEGIS_TASK:-$TASK}"
fi

# ─── dependency checks ────────────────────────────────────────────────────────

EXIT_CODE=3
for cmd in node npm curl jq; do
  if ! command -v "$cmd" &>/dev/null; then
    die "Required tool not found on PATH: $cmd"
  fi
done
EXIT_CODE=1

# ─── project root detection ───────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

info "Project root: $PROJECT_ROOT"

# ─── stage tracking ───────────────────────────────────────────────────────────

STAGES_PASSED=0
STAGES_FAILED=0

stage_pass() { success "$1"; (( STAGES_PASSED++ )) || true; }
stage_fail() { fail    "$1"; (( STAGES_FAILED++ )) || true; }

# =============================================================================
# Stage 1 — lint
# =============================================================================

if [[ "$SKIP_LINT" == "false" ]]; then
  info "Stage 1/3 — Lint"
  if npm run lint --silent 2>&1; then
    stage_pass "Lint passed"
  else
    stage_fail "Lint failed — fix the above errors before proceeding"
    # Run remaining stages so the operator sees all failures at once,
    # but set a flag so we exit non-zero at the end.
    LINT_FAILED=true
  fi
else
  warn "Stage 1/3 — Lint skipped (--skip-lint)"
fi
LINT_FAILED="${LINT_FAILED:-false}"

# =============================================================================
# Stage 2 — unit + integration tests
# =============================================================================

if [[ "$SKIP_TESTS" == "false" ]]; then
  info "Stage 2/3 — Tests"
  if npm test --silent 2>&1; then
    stage_pass "All tests passed"
  else
    stage_fail "Test suite failed"
    TESTS_FAILED=true
  fi
else
  warn "Stage 2/3 — Tests skipped (--skip-tests)"
fi
TESTS_FAILED="${TESTS_FAILED:-false}"

# ─── abort before submitting a task if local checks failed ───────────────────

if [[ "$LINT_FAILED" == "true" || "$TESTS_FAILED" == "true" ]]; then
  echo ""
  fail "Local checks failed — task submission skipped to avoid polluting the queue."
  exit 1
fi

# =============================================================================
# Stage 3 — submit task and poll for completion
# =============================================================================

if [[ "$SKIP_TASK" == "true" ]]; then
  warn "Stage 3/3 — Task submission skipped (--skip-task)"
  echo ""
  echo "${BOLD}Pipeline summary:${RESET} ${GREEN}${STAGES_PASSED} passed${RESET}"
  exit 0
fi

if [[ -z "$TASK" ]]; then
  die "No task specified. Pass --task \"<description>\" or set AEGIS_TASK in the environment."
fi

if [[ -z "${AEGIS_API_KEY:-}" ]]; then
  die "AEGIS_API_KEY is not set. Set it in the environment or in $ENV_FILE."
fi

info "Stage 3/3 — Submit task to Aegis"
info "  Server : $BASE_URL"
info "  Tenant : $TENANT"
info "  Task   : $TASK"

# ─── health check ─────────────────────────────────────────────────────────────

info "Checking server health..."
HEALTH_RESPONSE=$(curl -sf --max-time 10 "$BASE_URL/health" 2>&1) || {
  die "Server at $BASE_URL is not reachable. Is 'node server.js' running?"
}

HEALTH_STATUS=$(echo "$HEALTH_RESPONSE" | jq -r '.status // "unknown"')
if [[ "$HEALTH_STATUS" != "ok" ]]; then
  die "Server health check returned status: $HEALTH_STATUS"
fi

EMBEDDINGS=$(echo "$HEALTH_RESPONSE" | jq -r '.vectorMemory.embeddings // false')
if [[ "$EMBEDDINGS" != "true" ]]; then
  warn "Vector memory embeddings are disabled — agent context quality may be reduced."
  warn "Warnings: $(echo "$HEALTH_RESPONSE" | jq -r '.vectorMemory.warnings // [] | join(", ")')"
fi
success "Server is healthy"

# ─── submit task ──────────────────────────────────────────────────────────────

SUBMIT_RESPONSE=$(curl -sf --max-time 30 \
  -X POST "$BASE_URL/task" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $AEGIS_API_KEY" \
  -d "$(jq -n --arg task "$TASK" --arg tenant "$TENANT" \
        '{ task: $task, tenantId: $tenant }')" \
  2>&1) || {
  fail "Task submission request failed:"
  echo "$SUBMIT_RESPONSE" >&2
  exit 1
}

SUBMIT_STATUS=$(echo "$SUBMIT_RESPONSE" | jq -r '.status // "unknown"')
if [[ "$SUBMIT_STATUS" != "submitted" ]]; then
  fail "Unexpected submission response:"
  echo "$SUBMIT_RESPONSE" | jq . >&2
  exit 1
fi

WORKFLOW_ID=$(echo "$SUBMIT_RESPONSE" | jq -r '.workflowId')
success "Task submitted — workflow ID: ${BOLD}$WORKFLOW_ID${RESET}"

# ─── poll for workflow completion ─────────────────────────────────────────────

info "Polling for completion (timeout: ${TIMEOUT}s, interval: ${POLL_INTERVAL}s)..."

ELAPSED=0
LAST_STATUS=""
EXIT_CODE=2

while [[ $ELAPSED -lt $TIMEOUT ]]; do
  sleep "$POLL_INTERVAL"
  ELAPSED=$(( ELAPSED + POLL_INTERVAL ))

  WF_RESPONSE=$(curl -sf --max-time 10 \
    "$BASE_URL/workflow/$WORKFLOW_ID" \
    -H "x-api-key: $AEGIS_API_KEY" \
    2>&1) || {
    warn "Workflow poll failed (will retry) — elapsed ${ELAPSED}s"
    continue
  }

  CURRENT_STATUS=$(echo "$WF_RESPONSE" | jq -r '.status // "unknown"')

  # Print a progress tick whenever the status changes
  if [[ "$CURRENT_STATUS" != "$LAST_STATUS" ]]; then
    info "  Status: ${BOLD}$CURRENT_STATUS${RESET} (${ELAPSED}s elapsed)"
    LAST_STATUS="$CURRENT_STATUS"
  fi

  case "$CURRENT_STATUS" in
    completed)
      stage_pass "Workflow completed successfully"
      EXIT_CODE=0
      break
      ;;
    failed|cancelled)
      # Print step-level detail to help diagnose the failure
      fail "Workflow ended with status: $CURRENT_STATUS"
      echo ""
      echo "${BOLD}Step summary:${RESET}"
      echo "$WF_RESPONSE" | jq -r '
        .steps // [] |
        .[] |
        "  [\(.status // "?")] \(.id) — \(.description // "-")"
      ' >&2
      # Check for items in the review queue for this workflow
      REVIEW=$(curl -sf --max-time 10 \
        "$BASE_URL/review-queue?status=pending" \
        -H "x-api-key: $AEGIS_API_KEY" 2>/dev/null | \
        jq --arg wfid "$WORKFLOW_ID" \
           '[.items // [] | .[] | select(.workflowId == $wfid)]') || REVIEW="[]"
      REVIEW_COUNT=$(echo "$REVIEW" | jq 'length')
      if [[ "$REVIEW_COUNT" -gt 0 ]]; then
        warn "$REVIEW_COUNT step(s) are awaiting human review:"
        echo "$REVIEW" | jq -r \
          '.[] | "  step=\(.stepId) agent=\(.agent // "?") error=\(.error // "-")"' >&2
        warn "Resolve via: POST $BASE_URL/review/<workflowId>/<stepId>/resolve"
      fi
      EXIT_CODE=2
      break
      ;;
    needs-review)
      warn "Workflow is awaiting human review — pipeline will wait up to ${TIMEOUT}s."
      warn "Resolve items at: $BASE_URL/dashboard"
      ;;
    paused)
      warn "Workflow is paused — resume via: POST $BASE_URL/resume/$WORKFLOW_ID"
      ;;
    running|pending)
      : # normal in-progress states; dot progress printed only on status change
      ;;
    *)
      warn "Unrecognised workflow status: $CURRENT_STATUS"
      ;;
  esac
done

if [[ $ELAPSED -ge $TIMEOUT && "$EXIT_CODE" -ne 0 ]]; then
  fail "Timed out after ${TIMEOUT}s waiting for workflow $WORKFLOW_ID (last status: $LAST_STATUS)"
  EXIT_CODE=2
fi

# =============================================================================
# Summary
# =============================================================================

echo ""
echo "${BOLD}━━━ Pipeline summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo "  Workflow : $WORKFLOW_ID"
echo "  Tenant   : $TENANT"
echo "  Duration : ${ELAPSED}s"
if [[ $EXIT_CODE -eq 0 ]]; then
  echo "  Result   : ${GREEN}${BOLD}SUCCESS${RESET}"
else
  echo "  Result   : ${RED}${BOLD}FAILED (exit $EXIT_CODE)${RESET}"
fi
echo "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

exit $EXIT_CODE
