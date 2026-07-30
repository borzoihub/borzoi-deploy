# Borzoi OTA updater sidecar.
#
# Debian-based (glibc) on purpose.
#
# We add only the Docker CLI + Compose plugin (NOT the daemon — the host
# socket is mounted) so the loop can drive the stack. Built locally on the Pi
# from this bundle; never pushed to a registry. Entrypoint/command are set in
# docker-compose.yml so scripts/updater.sh can be edited without a rebuild.
#
# `git` is here so the loop can sync THIS bundle before deploying — images
# arrive from the registry, but docker-compose.yml / nginx templates / any
# mounted config.json only reach the Pi via git. Keep this image as thin as
# possible: OTA deliberately never recreates the updater, so anything added
# here costs a manual visit to every Hub, whereas scripts/updater.sh is
# bind-mounted and free to change.
FROM debian:bookworm-slim

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg bash git util-linux; \
    # Docker CLI + Compose plugin from Docker's official apt repo.
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg \
        -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/debian bookworm stable" \
        > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin; \
    rm -rf /var/lib/apt/lists/*; \
    # Fail the build early if any tool is broken. `setpriv` (util-linux) lets
    # the loop run git as the host checkout's owner instead of root — see
    # git_sync() in scripts/updater.sh.
    docker --version; docker compose version; git --version; setpriv --version
