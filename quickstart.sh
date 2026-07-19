#!/usr/bin/env bash
# quickstart.sh — one-shot wizard to run any koboi-use-cases app end-to-end.
#
# Early-adopter flow:
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/quickstart.sh | bash
# (or: bash quickstart.sh  from inside a checkout)
#
# What it does: preflight (Docker) -> clone/detect the repo -> pick a project ->
# write .env from the project's .env.example (prompting for secrets) -> build & start
# -> wait for health -> print the URLs + a smoke test -> optional monitor loop.
#
# Cross-OS: native on macOS/Linux. On Windows run via WSL2 or Git Bash, or use the
# companion quickstart.ps1 launcher (irm <url> | iex) which finds WSL/Git-Bash for you.
#
# Override the clone URL/source by setting KOBOI_UC_REPO / KOBOI_UC_HOME. Subcommands:
# quickstart.sh [--project NAME] [--yes] [--no-color] | --list | --status |
#               --logs [NAME] | --down [NAME] [--purge] | --update | --help

set -uo pipefail

# ───────────────────────────────── config ─────────────────────────────────
# Where to clone from when not already inside a checkout. Edit after publishing,
# or override with: KOBOI_UC_REPO=https://github.com/you/koboi-use-cases.git
REPO_URL="${KOBOI_UC_REPO:-https://github.com/mekari/koboi-use-cases.git}"
# Where to clone to if not running from inside the repo.
REPO_HOME="${KOBOI_UC_HOME:-$HOME/koboi-use-cases}"
# Per-user log dir (so we never pollute the repo).
LOG_DIR="$HOME/.koboi-quickstart/logs"
mkdir -p "$LOG_DIR"

# name|title|one-liner|backend_port   (frontend port = backend_port - 5000)
PROJECTS=(
"ecommerce-support|E-commerce support|Storefront chat: orders, returns, refunds|8001"
"hr-screening|HR screening|Overnight resume-scoring jobs|8002"
"finance-reconciliation|Finance reconciliation|Match invoices to POs; MCP to ERP|8003"
"healthcare-intake|Healthcare intake|Pre-visit symptom triage (RAG)|8004"
"legal-contract-review|Legal contract review|Clause-playbook redlining (Skills)|8005"
"real-estate|Real estate|Buyer chat + nightly listing drafts|8006"
"insurance-claims|Insurance claims triage|FNOL triage + self-healing|8007"
"market-intel|Market intelligence|Cited competitive briefs (deep research)|8008"
"employee-concierge|Employee concierge (A2A)|3-container cross-department A2A|8009"
"customer-success|Customer success|Account health + churn risk|8010"
)

# ───────────────────────────────── colors ─────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  ESC=$'\033'
  C_RED="${ESC}[31m"; C_GREEN="${ESC}[32m"; C_YELLOW="${ESC}[33m"
  C_CYAN="${ESC}[36m"; C_BOLD="${ESC}[1m"; C_DIM="${ESC}[2m"; R="${ESC}[0m"
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""; C_BOLD=""; C_DIM=""; R=""
fi

# ───────────────────────────────── helpers ────────────────────────────────
die()  { printf "\n${C_RED}✗ %s${R}\n" "$*" >&2; exit 1; }
warn() { printf "${C_YELLOW}! %s${R}\n" "$*" >&2; }
ok()   { printf "${C_GREEN}✓ %s${R}\n" "$*"; }

STEP_N=0; STEP_T=0
step() {
  STEP_N=$((STEP_N+1))
  printf "\n${C_BOLD}${C_CYAN}▶ [%s/%s] %s${R}\n" "$STEP_N" "$STEP_T" "$*"
}
set_total_steps() { STEP_T="$1"; STEP_N=0; }

# Animated spinner while a background PID runs.
spinner() {
  local pid="$1" msg="$2" spin='|/-\' i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${C_CYAN}[%s]${R} ${C_DIM}%s${R}   " "${spin:$((i%4)):1}" "$msg"
    i=$((i+1)); sleep 0.15
  done
  printf "\r\033[K"
}

# Interactive only when stdout is a terminal AND /dev/tty is a usable char device.
# This is what keeps `curl … | bash` interactive (stdin is the script pipe, but
# /dev/tty is still the user's terminal) while silently using defaults headlessly.
has_tty() { [ -t 1 ] && [ -c /dev/tty ]; }

# prompt "question" "default"  -> echoes answer (default on Enter / non-tty).
prompt() {
  local q="$1" def="${2:-}" var=""
  if has_tty; then
    printf "%s%s%s " "${C_CYAN}?${R} ${C_BOLD}$q${R}" "${def:+ ${C_DIM}[$def]${R}}" >&2
    if ! { IFS= read -r var </dev/tty; } 2>/dev/null; then var=""; fi
  fi
  [ -n "$var" ] || var="$def"
  echo "$var"
}
# prompt_secret "question"  -> echoes answer (hidden typing).
prompt_secret() {
  local q="$1" var=""
  if has_tty; then
    printf "%s " "${C_CYAN}?${R} ${C_BOLD}$q${R}" >&2
    if ! { IFS= read -rs var </dev/tty; } 2>/dev/null; then var=""; fi
    printf "\n" >&2
  fi
  echo "$var"
}

# Box-print a summary block.
box() {
  local l="$1"
  local w=${#l}
  local border
  border="$(printf '─%.0s' $(seq 1 $((w+2))))"
  printf "${C_CYAN}┌%s┐${R}\n" "$border"
  printf "${C_CYAN}│${R} %s ${C_CYAN}│${R}\n" "$l"
  printf "${C_CYAN}└%s┘${R}\n" "$border"
}

# ─────────────────────────── project lookups ──────────────────────────────
proj_field() { local row="$1" idx="$2"; echo "$row" | cut -d'|' -f"$idx"; }
find_row() { # echo the PROJECTS row whose name == $1
  local want="$1" row name
  for row in "${PROJECTS[@]}"; do
    name="$(proj_field "$row" 1)"; [ "$name" = "$want" ] && { echo "$row"; return 0; }
  done
  return 1
}
frontend_port() { echo $(( $1 - 5000 )); }

is_repo_root() { [ -f "$1/hr-screening/docker-compose.yml" ]; }

# ──────────────────────────── preflight: Docker ───────────────────────────
preflight() {
  step "Checking Docker"
  if ! command -v docker >/dev/null 2>&1; then
    cat >&2 <<EOF
${C_RED}✗ Docker is not installed or not on PATH.${R}

Install Docker, then re-run:
  ${C_BOLD}macOS / Windows:${R}  Docker Desktop  → https://docs.docker.com/desktop/
  ${C_BOLD}Linux:${R}            Docker Engine + compose plugin → https://docs.docker.com/engine/install/

(Windows users: Docker Desktop installs WSL2; run this script from a WSL2 or Git Bash shell.)
EOF
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    die "Docker is installed but the 'docker compose' v2 plugin is missing. Install the compose plugin (https://docs.docker.com/compose/install/) and retry."
  fi
  if ! docker info >/dev/null 2>&1; then
    die "Docker daemon is not running. Start Docker Desktop (macOS/Windows) or 'sudo systemctl start docker' (Linux), then retry."
  fi
  ok "Docker ready ($(docker compose version --short 2>/dev/null || echo v2))."
}

# ─────────────────────────── bootstrap: repo ──────────────────────────────
bootstrap_repo() {
  step "Locating the koboi-use-cases repo"
  if is_repo_root "$PWD"; then
    REPO_ROOT="$PWD"; ok "Running from a checkout: $REPO_ROOT"
    return 0
  fi
  if is_repo_root "$REPO_HOME"; then
    REPO_ROOT="$REPO_HOME"
    if has_tty && [ "$(prompt "Update existing checkout at $REPO_ROOT with git pull?" "Y/n")" != "n" ]; then
      git -C "$REPO_ROOT" pull --ff-only >/dev/null 2>&1 && ok "Updated." || warn "pull failed — continuing with existing files."
    fi
    return 0
  fi
  if [ "${1:-}" = "--yes" ] || [ "$(prompt "Clone koboi-use-cases to $REPO_HOME?" "Y/n")" != "n" ]; then :; else die "No repo available."; fi
  git clone --depth 1 "$REPO_URL" "$REPO_ROOT" >/dev/null 2>&1 \
    || die "git clone failed ($REPO_URL). Set KOBOI_UC_REPO to your fork's URL, or run from inside an existing checkout."
  ok "Cloned to $REPO_ROOT"
}

# ───────────────────────────── write .env ─────────────────────────────────
# Data-driven from <project>/.env.example. Keeps existing non-empty values as
# defaults; prompts for empties (with smart defaults); reuses an existing .env.
write_env() {
  local project="$1"
  local envfile="$REPO_ROOT/$project/.env"
  local ex="$REPO_ROOT/$project/.env.example"
  step "Configuring $project/.env"
  [ -f "$ex" ] || die "No .env.example for $project (expected $ex)."
  if [ -f "$envfile" ]; then
    local reuse="Y"
    if has_tty; then reuse="$(prompt "$project/.env already exists. Reuse it as-is?" "Y/n")"; fi
    [ "$reuse" = "n" ] || { ok "Reusing existing $project/.env."; return 0; }
  fi

  local out="" key val def OPENAI_KEY_V="" OPENAI_BASE_V="" line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) out="$out$line"$'\n'; continue;; esac
    key="${line%%=*}"; val="${line#*=}"
    if [ -n "$val" ]; then                       # .env.example already provides a default
      out="$out$key=$val"$'\n'
      case "$key" in OPENAI_API_KEY) OPENAI_KEY_V="$val";; OPENAI_BASE_URL) OPENAI_BASE_V="$val";; esac
      continue
    fi
    # empty value → decide a default, possibly prompting
    case "$key" in
      OPENAI_API_KEY)
        [ -n "${OPENAI_API_KEY:-}" ] && def="${OPENAI_API_KEY}" || def=""
        val="$(prompt_secret "OPENAI_API_KEY (required for live LLM)")"
        [ -n "$val" ] || val="$def"
        [ -n "$val" ] || warn "empty OPENAI_API_KEY — app will boot but live chat will fail."
        OPENAI_KEY_V="$val" ;;
      OPENAI_MODEL)    val="$(prompt "OPENAI_MODEL" "${OPENAI_MODEL:-gpt-4o-mini}")" ;;
      OPENAI_BASE_URL) val="$(prompt "OPENAI_BASE_URL (blank = public OpenAI)" "${OPENAI_BASE_URL:-}")"
                       OPENAI_BASE_V="$val" ;;
      EMBEDDING_API_KEY) val="$(prompt "EMBEDDING_API_KEY" "${OPENAI_KEY_V}")" ;;
      EMBEDDING_BASE_URL) val="$(prompt "EMBEDDING_BASE_URL (blank = same as chat / OpenAI)" "${OPENAI_BASE_V:-}")" ;;
      *)               val="$(prompt "$key (blank = the app's built-in default)" "")" ;;
    esac
    out="$out$key=$val"$'\n'
  done < "$ex"
  printf '%s' "$out" > "$envfile" || die "cannot write $envfile"
  chmod 600 "$envfile" 2>/dev/null || true
  ok "Wrote $project/.env"
}

# ──────────────────────────── build + start ───────────────────────────────
compose() { docker compose --progress plain -f "$REPO_ROOT/$PROJECT_DIR/docker-compose.yml" "$@"; }

up_project() {
  local project="$1"
  local log="$LOG_DIR/$project.log"
  step "Building + starting $project (first run pulls koboi-agent; ~1–3 min)"
  printf "  ${C_DIM}logs: %s${R}\n" "$log"
  ( compose up -d --build >"$log" 2>&1 ) &
  local pid=$!
  spinner "$pid" "docker compose up --build (this can take a while on first run)…"
  wait "$pid"; local rc=$?
  [ "$rc" -eq 0 ] || { tail -n 25 "$log" >&2; die "docker compose up failed (exit $rc). See $log."; }
  ok "Containers started."
}

wait_health() {
  local backend="$1" i code
  step "Waiting for koboi to be healthy on :$backend"
  for i in $(seq 1 90); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://localhost:$backend/healthz" 2>/dev/null || echo 000)"
    if [ "$code" = "200" ]; then printf "\r\033[K"; ok "Healthy (:$backend/healthz → 200)."; return 0; fi
    printf "\r  ${C_DIM}waiting… (%2ds, last http=%s)${R}" "$((i*2))" "$code"; sleep 2
  done
  printf "\r\033[K"
  warn "koboi did not report /healthz=200 within ~180s. It may still be starting — open the URL or check logs."
}

print_summary() {
  local project="$1" backend="$2"
  local front; front="$(frontend_port "$backend")"
  local key=""
  [ -f "$REPO_ROOT/$project/.env" ] && key="$(grep -E '^CONCIERGE_API_KEY=' "$REPO_ROOT/$project/.env" 2>/dev/null | cut -d= -f2 || true)"
  echo
  box "$project is up"
  cat <<EOF
  ${C_BOLD}Web UI${R}    http://localhost:$front        ${C_DIM}(open this in your browser)${R}
  ${C_BOLD}API${R}       http://localhost:$backend      ${C_DIM}(/healthz, /v1/chat/stream, /v1/jobs)${R}
$([ -n "$key" ] && echo "  ${C_BOLD}API key${R}   $key  ${C_DIM}(this project requires a Bearer token)${R}")
  ${C_BOLD}Logs${R}      quickstart.sh --logs $project
  ${C_BOLD}Stop${R}      quickstart.sh --down $project
EOF
}

# ─────────────────────────── monitor loop ─────────────────────────────────
monitor_menu() {
  local project="$1" backend="$2" front; front="$(frontend_port "$backend")"
  [ has_tty ] || return 0
  while true; do
    echo
    printf "${C_BOLD}What next?${R} ${C_DIM}[t]ail logs  [c]url smoke  [o]pen browser  [n]ew project  [s]top  [q]uit${R} "
    local c=""; IFS= read -r c </dev/tty 2>/dev/null || c="q"
    case "$c" in
      t) compose logs -f --tail=30 || true ;;
      c) printf "\n${C_DIM}smoke:${R}\n  curl -s http://localhost:$backend/healthz\n"
         curl -s -m 5 "http://localhost:$backend/healthz" || echo "(no response)"
         [ -n "$(find_row "$project")" ] && echo "\n  (open http://localhost:$front to chat)" ;;
      o|b) ( command -v open >/dev/null && open "http://localhost:$front" ) \
           || ( command -v xdg-open >/dev/null && xdg-open "http://localhost:$front" ) \
           || warn "no 'open'/'xdg-open' — visit http://localhost:$front manually." ;;
      n) main_wizard ;;  # restart selection
      s|d) compose down; ok "stopped $project"; break ;;
      q|x|"") break ;;
      *) warn "t/c/o/n/s/q" ;;
    esac
  done
}

# ──────────────────────────── interactive run ─────────────────────────────
pick_project() {
  local idx=0 row name title sub back running mark
  echo
  printf "${C_BOLD}Choose a use case to run:${R}  ${C_DIM}(ports shown = web/api)${R}\n"
  for row in "${PROJECTS[@]}"; do
    idx=$((idx+1))
    name="$(proj_field "$row" 1)"; title="$(proj_field "$row" 2)"
    sub="$(proj_field "$row" 3)"; back="$(proj_field "$row" 4)"
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${name}-"; then mark="${C_GREEN}●running${R}"; else mark="${C_DIM}○${R}"; fi
    printf "  ${C_BOLD}%-2d${R} %-24s %s  ${C_DIM}:%s/%s%s${R}\n" "$idx" "$name" "$mark" "$back" "$(frontend_port "$back")" ""
    printf "     ${C_DIM}%s — %s${R}\n" "$title" "$sub"
  done
  local choice rown
  rown="$(prompt "Number [1-${#PROJECTS[@]}]" "")"
  [ -n "$rown" ] && [ "$rown" -ge 1 ] 2>/dev/null && [ "$rown" -le "${#PROJECTS[@]}" ] 2>/dev/null \
    || die "invalid choice '$rown'"
  PROJECT_DIR="$(proj_field "${PROJECTS[$((rown-1))]}" 1)"
  echo "$PROJECT_DIR"
}

run_project() {
  local project="$1" backend row
  row="$(find_row "$project")" || die "unknown project '$project' (try --list)."
  backend="$(proj_field "$row" 4)"; PROJECT_DIR="$project"
  write_env "$project"
  up_project "$project"
  wait_health "$backend"
  print_summary "$project" "$backend"
  monitor_menu "$project" "$backend"
}

main_wizard() {
  set_total_steps 5
  preflight
  bootstrap_repo
  local p; p="$(pick_project)"
  run_project "$p"
}

# ─────────────────────────── subcommands ──────────────────────────────────
cmd_list() {
  printf "${C_BOLD}%-24s %-28s %-9s %-9s${R}\n" "PROJECT" "TITLE" "WEB" "API"
  local row name title back
  for row in "${PROJECTS[@]}"; do
    name="$(proj_field "$row" 1)"; title="$(proj_field "$row" 2)"; back="$(proj_field "$row" 4)"
    printf "%-24s %-28s %-9s %-9s\n" "$name" "$title" ":$(frontend_port "$back")" ":$back"
  done
}

cmd_status() {
  printf "${C_BOLD}Running koboi-use-cases containers:${R}\n"
  local row name back code any=0
  for row in "${PROJECTS[@]}"; do
    name="$(proj_field "$row" 1)"; back="$(proj_field "$row" 4)"
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${name}-"; then
      code="$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://localhost:$back/healthz" 2>/dev/null || echo 000)"
      printf "  ${C_GREEN}●${R} %-22s :%s/healthz → %s\n" "$name" "$back" "$code"; any=1
    fi
  done
  [ "$any" = "0" ] && printf "  ${C_DIM}(none running)${R}\n"
}

resolve_repo_root() {
  if is_repo_root "$PWD"; then REPO_ROOT="$PWD"
  elif is_repo_root "$REPO_HOME"; then REPO_ROOT="$REPO_HOME"
  else die "not inside a checkout and no clone at $REPO_HOME — run 'quickstart.sh' (wizard) first."; fi
}

cmd_logs()  { resolve_repo_root; PROJECT_DIR="${1:-}"; [ -n "$PROJECT_DIR" ] || die "usage: --logs <project>"; compose logs -f --tail=50; }
cmd_down()  {
  resolve_repo_root
  PROJECT_DIR="${1:-}"; [ -n "$PROJECT_DIR" ] || die "usage: --down <project>"
  local extra=""; [ "${2:-}" = "--purge" ] && extra="-v"
  docker compose --progress plain -f "$REPO_ROOT/$PROJECT_DIR/docker-compose.yml" down $extra \
    && ok "stopped $PROJECT_DIR$([ -n "$extra" ] && echo ' (+volumes)')"
}
cmd_update(){ resolve_repo_root; git -C "$REPO_ROOT" pull --ff-only && ok "updated $REPO_ROOT" || die "pull failed"; }

usage() {
  sed -n '2,/^$/p' "$0" 2>/dev/null | sed 's/^# //; s/^#//'
  cat <<EOF

${C_BOLD}Usage:${R}
  quickstart.sh                       interactive wizard (default)
  quickstart.sh --project <name>      run one project (still prompts for .env)
  quickstart.sh --project <name> --yes  non-interactive: use defaults / shell env
  quickstart.sh --list                list all projects + ports
  quickstart.sh --status              show running projects + health
  quickstart.sh --logs <name>         tail a project's logs
  quickstart.sh --down <name> [--purge]  stop (and optionally drop volumes)
  quickstart.sh --update              git pull the repo

${C_BOLD}Env overrides:${R}  KOBOI_UC_REPO  KOBOI_UC_HOME  NO_COLOR=1
${C_BOLD}Pre-seed secrets:${R} OPENAI_API_KEY=sk-... quickstart.sh --project hr-screening --yes
EOF
}

# ───────────────────────────── dispatch ───────────────────────────────────
PROJECT_FLAG=""; YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT_FLAG="${2:-}"; shift 2;;
    --yes|-y) YES=1; shift;;
    --no-color) export NO_COLOR=1; shift;;
    --list)   cmd_list; exit 0;;
    --status) cmd_status; exit 0;;
    --logs)   cmd_logs "${2:-}"; exit 0;;
    --down)   cmd_down "${2:-}" "${3:-}"; exit 0;;
    --update) cmd_update; exit 0;;
    --help|-h) usage; exit 0;;
    *) die "unknown arg '$1' (try --help)";;
  esac
done

banner() {
  printf "\n${C_BOLD}${C_CYAN}╔══════════════════════════════════════════════════════╗${R}\n"
  printf "${C_BOLD}${C_CYAN}║   koboi-use-cases quickstart — pick • configure • run ║${R}\n"
  printf "${C_BOLD}${C_CYAN}╚══════════════════════════════════════════════════════╝${R}\n\n"
}

banner
if [ -n "$PROJECT_FLAG" ]; then
  set_total_steps 5; preflight; bootstrap_repo "--$([ $YES = 1 ] && echo yes || echo ask)"
  if [ $YES = 1 ]; then
    row="$(find_row "$PROJECT_FLAG")" || die "unknown project '$PROJECT_FLAG'"
    PROJECT_DIR="$PROJECT_FLAG"
    # non-interactive env: reuse .env if present, else generate from .env.example w/ shell env + defaults
    if [ ! -f "$REPO_ROOT/$PROJECT_FLAG/.env" ]; then
      EF="$REPO_ROOT/$PROJECT_FLAG/.env"; cp "$REPO_ROOT/$PROJECT_FLAG/.env.example" "$EF"
      [ -n "${OPENAI_API_KEY:-}" ] && sed -i.tmp "s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=${OPENAI_API_KEY}|" "$EF" && rm -f "$EF.tmp"
    fi
    backend="$(proj_field "$row" 4)"
    up_project "$PROJECT_FLAG"; wait_health "$backend"; print_summary "$PROJECT_FLAG" "$backend"
  else
    run_project "$PROJECT_FLAG"
  fi
else
  main_wizard
fi
echo; ok "Done."
