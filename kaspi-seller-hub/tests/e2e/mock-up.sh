#!/bin/bash
# (Re)start the mock Kaspi API (mockapi.js, port 8099) and wait until it answers.
# A plain `pkill …; node mockapi.js &; sleep 1` raced twice on CI: the old process could still hold
# the port (the new one then exits with EADDRINUSE) or the new one was not listening yet after 1 s.
# Exit 1 (with the mock log) if it does not come up in 15 s.
cd "$(dirname "$0")"
pkill -f "node mockapi.js" 2>/dev/null
for _ in $(seq 50); do pgrep -f "node mockapi.js" >/dev/null || break; sleep 0.1; done
node mockapi.js > mock.log 2>&1 &
deadline=$((SECONDS + 15))
while [ "$SECONDS" -lt "$deadline" ]; do
  curl -sf --max-time 1 -o /dev/null http://localhost:8099/__log && exit 0
  sleep 0.1
done
echo "mock API did not start:"; cat mock.log
exit 1
