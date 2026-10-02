#!/bin/sh
# Build the rterm-server image locally, ship it to the server over SSH and
# (re)deploy the swarm stack. The server needs no internet access or Go toolchain.
#
#   deploy/deploy.sh elvispos@7.7.7.201 [ssh options...]     e.g. -p 4168
#
# On the first run it creates ~/rterm/rterm.env on the server with random secrets.
# ENV_SET (newline-separated KEY=VALUE lines) adds or replaces settings in it, e.g.
#
#   central: ENV_SET="RTERM_STORE_TOKEN=$(openssl rand -hex 24)
#            RTERM_ALLOW_CIDRS=7.7.7.0/24,127.0.0.0/8"
#   store:   ENV_SET="RTERM_UPSTREAM=ws://7.7.7.172:7681
#            RTERM_UPSTREAM_TOKEN=<central's RTERM_STORE_TOKEN>
#            RTERM_STORE_ID=amacrai-store"
set -eu

TARGET="${1:?usage: deploy.sh user@host [ssh options]}"
shift
SSH="${SSH:-ssh}"
ENV_SET="${ENV_SET:-}"
VERSION="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> building rterm-server:$VERSION"
docker build --build-arg VERSION="$VERSION" -t "rterm-server:$VERSION" "$ROOT"

echo "==> shipping image to $TARGET"
docker save "rterm-server:$VERSION" | gzip | $SSH "$@" "$TARGET" 'gunzip | docker load'

echo "==> deploying stack"
$SSH "$@" "$TARGET" "mkdir -p ~/rterm && cat > ~/rterm/docker-stack.yml" < "$ROOT/deploy/docker-stack.yml"
$SSH "$@" "$TARGET" sh -s <<EOF
set -eu
ENV_SET_LINES='$ENV_SET'
cd ~/rterm
if [ ! -f rterm.env ]; then
	umask 077
	cat > rterm.env <<ENV
RTERM_AGENT_TOKEN=\$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
RTERM_ADMIN_USER=admin
RTERM_ADMIN_PASSWORD=\$(head -c 9 /dev/urandom | base64 | tr '+/' 'xy')
RTERM_SESSION_SECRET=\$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
ENV
	echo "created ~/rterm/rterm.env with new secrets"
fi
printf '%s\n' "\$ENV_SET_LINES" | while IFS= read -r line; do
	line="\$(echo "\$line" | sed 's/^[[:space:]]*//')"
	[ -n "\$line" ] || continue
	key="\${line%%=*}"
	sed -i "/^\$key=/d" rterm.env
	echo "\$line" >> rterm.env
	echo "set \$key"
done
RTERM_VERSION=$VERSION docker stack deploy -c docker-stack.yml rterm
EOF
echo "==> done: rterm-server:$VERSION"
