#!/bin/bash
# TV Livre MH — para a RESERVA desta VM (servidor + túnel público ngrok).
# Usado pelo monitor de failover quando o PC volta.
set -u
cd "$(dirname "$0")"
# 1) Túnel ngrok
if [ -f .monitor/tunel.pid ]; then
  TPID="$(cat .monitor/tunel.pid)"
  kill "$TPID" 2>/dev/null
  for _ in $(seq 1 5); do kill -0 "$TPID" 2>/dev/null || break; sleep 1; done
  kill -9 "$TPID" 2>/dev/null
  rm -f .monitor/tunel.pid .monitor/tunel.url
  echo "tunel publico parado"
fi
pkill -f "bin/ngrok http 3002" 2>/dev/null
# 2) Servidor da reserva
if [ -f .monitor/reserva.pid ]; then
  PID="$(cat .monitor/reserva.pid)"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    for _ in $(seq 1 10); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
    kill -9 "$PID" 2>/dev/null
    echo "reserva parada (pid $PID)"
  else
    echo "pid $PID ja nao existia"
  fi
  rm -f .monitor/reserva.pid
else
  echo "reserva nao estava rodando"
fi
