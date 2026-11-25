#!/bin/sh
# Container start-up: apply database migrations, create the first Ministry administrator if seed details are
# given and none exists yet (it does nothing otherwise), then start the API.
set -e
npx prisma migrate deploy
if [ -n "${SEED_ADMIN_EMAIL}${SEED_ADMIN_PHONE}" ]; then
  node dist-seed/prisma/seed.js
fi
exec node dist/main.js
