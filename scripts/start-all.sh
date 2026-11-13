#!/usr/bin/env bash
# Start every MediCluster service locally (9 services), each in the background with its own log.
#   ./scripts/start-all.sh          start everything
#   ./scripts/start-all.sh stop     stop everything started by this script
#   ./scripts/start-all.sh status   show which ports answer
# Logs: .run/<service>.log   PIDs: .run/<service>.pid
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.run"; mkdir -p "$RUN"

# name | directory | command | health URL
SERVICES=(
  "ml-engine|medicluster/ml-engine|./venv/bin/python app.py|http://localhost:8080/health"
  "intelligence|medicluster/intelligence-engine|.venv/bin/python app.py|http://localhost:8090/health"
  "chest-imaging|medicluster/ml-engine|../intelligence-engine/.venv/bin/python imaging_server.py|http://localhost:8091/health"
  "brain-mri|medicluster/brain-mri-service|.venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8001|http://localhost:8001/health"
  "backend|medicluster/backend|npm start|http://localhost:5000/api/health"
  "dispatch-api|ambulance-dispatch/backend/api|npm start|http://localhost:3001/health"
  "frontend|medicluster/frontend|npm run dev|http://localhost:3000/"
  "dispatch-dashboard|ambulance-dispatch/frontend/dispatcher-dashboard|npm run dev -- --port 5174|http://localhost:5174/"
  "agent-core|agent-core|npm run build >/dev/null && set -a && . ./.env && set +a && node dist/main.js|http://localhost:8100/health"
)

status() {
  for s in "${SERVICES[@]}"; do
    IFS='|' read -r name _ _ url <<<"$s"
    code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$url" || true)
    printf '%-20s %-34s %s\n' "$name" "$url" "$([ "$code" = 200 ] && echo UP || echo "down ($code)")"
  done
}

stop() {
  for f in "$RUN"/*.pid; do
    [ -e "$f" ] || continue
    pid=$(cat "$f")
    # setsid made each service its own process group: kill the whole group, not just the wrapper.
    kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null
    echo "stopped $(basename "$f" .pid)"; rm -f "$f"
  done
}

case "${1:-start}" in
  stop) stop; exit 0 ;;
  status) status; exit 0 ;;
esac

for s in "${SERVICES[@]}"; do
  IFS='|' read -r name dir cmd _ <<<"$s"
  if [ -e "$RUN/$name.pid" ] && kill -0 "$(cat "$RUN/$name.pid")" 2>/dev/null; then
    echo "$name already running"; continue
  fi
  ( cd "$ROOT/$dir" && setsid bash -c "$cmd" >"$RUN/$name.log" 2>&1 & echo $! >"$RUN/$name.pid" )
  echo "started $name (log: .run/$name.log)"
done

echo "waiting for services..."
sleep 20
status
echo
echo "Open:  http://localhost:3000            MediCluster (clinicians)"
echo "       http://localhost:3000/cliniq     CliniQ chat"
echo "       http://localhost:8100/console    Agent control room (admin key)"
echo "       http://localhost:5174            Dispatch center"
