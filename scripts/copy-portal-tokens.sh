#!/bin/sh
# Copies the admin's design tokens, and the two font files they name for the portal,
# into client-hub-app/ (merged-admin C2). One file, two products: the portal never
# keeps its own copy in git, so the two can't drift. The Pages workflow runs this
# before it publishes; run it yourself before opening the portal locally.
#   sh scripts/copy-portal-tokens.sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p client-hub-app/css client-hub-app/fonts
cp admin/web/css/tokens.css client-hub-app/css/tokens.css
cp admin/web/fonts/FunnelSans-Variable.woff2 admin/web/fonts/CSFeliceMono-Regular.woff2 client-hub-app/fonts/
