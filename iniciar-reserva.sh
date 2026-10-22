#!/bin/bash
# TV Livre MH — RESERVA nesta VM com LINK PÚBLICO automático (ngrok).
# Sobe o servidor da TV (porta 3002) + túnel ngrok com endereço público.
# Quem liga/desliga no dia a dia é o monitor de failover (cron tvlivre-failover);
# este script também pode ser rodado manualmente.
# Ao final, o endereço público fica em .monitor/tunel.url
set -u
cd "$(dirname "$0")"
export PORT=3002
export TV_DADOS="$PWD/dados-reserva"
mkdir -p "$TV_DADOS" logs .monitor
NGROK="$HOME/workspace/bin/ngrok"

# 1) Servidor da reserva
if ! curl -s -m 5 http://localhost:3002/health 2>/dev/null | grep -q "^ok$"; then
  BUN="$(command -v bun 2>/dev/null || echo /opt/hatch-image/bin/bun)"
  [ -x "$BUN" ] || { echo "ERRO: bun nao encontrado"; exit 1; }
  setsid "$BUN" run server.ts >> logs/reserva.log 2>&1 < /dev/null &
  echo $! > .monitor/reserva.pid
  OK=false
  for _ in $(seq 1 25); do
    sleep 1
    if curl -s -m 5 http://localhost:3002/health 2>/dev/null | grep -q "^ok$"; then OK=true; break; fi
  done
  if ! $OK; then echo "FALHA ao subir o servidor da reserva"; tail -5 logs/reserva.log 2>/dev/null; exit 1; fi
fi

# 2) Túnel público (ngrok — usa o authtoken de ~/.config/ngrok/ngrok.yml)
[ -x "$NGROK" ] || { echo "ERRO: ngrok nao encontrado em $NGROK"; exit 1; }
if [ -f .monitor/tunel.url ]; then
  URL="$(cat .monitor/tunel.url)"
  if [ -n "$URL" ] && curl -s -m 15 "$URL/health" 2>/dev/null | grep -q "^ok$"; then
    echo "reserva no ar: $URL"
    exit 0
  fi
fi
[ -f .monitor/tunel.pid ] && kill "$(cat .monitor/tunel.pid)" 2>/dev/null
pkill -f "bin/ngrok http 3002" 2>/dev/null
sleep 1
rm -f .monitor/tunel.url .monitor/tunel.pid
setsid "$NGROK" http 3002 --log "$PWD/logs/ngrok.log" --log-format json >> "$PWD/logs/ngrok.log" 2>&1 < /dev/null &
echo $! > .monitor/tunel.pid
# Extrai a URL pública da API local do ngrok (até 90s)
URL=""
for _ in $(seq 1 90); do
  URL="$(curl -s -m 5 http://localhost:4040/api/tunnels 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    https=[t['public_url'] for t in d.get('tunnels',[]) if t.get('proto')=='https' and t.get('public_url')]
    print(https[0] if https else '')
except Exception:
    print('')
" 2>/dev/null)"
  [ -n "$URL" ] && break
  sleep 1
done
if [ -z "$URL" ]; then echo "FALHA: ngrok nao gerou URL publica"; tail -5 logs/ngrok.log 2>/dev/null; exit 1; fi
echo "$URL" > .monitor/tunel.url
# Espera o túnel responder de verdade (até 90s)
for _ in $(seq 1 90); do
  curl -s -m 15 "$URL/health" 2>/dev/null | grep -q "^ok$" && break
  sleep 1
done
if curl -s -m 15 "$URL/health" 2>/dev/null | grep -q "^ok$"; then
  echo "reserva no ar: $URL"
else
  echo "FALHA: tunel criado ($URL) mas nao responde"
  exit 1
fi
