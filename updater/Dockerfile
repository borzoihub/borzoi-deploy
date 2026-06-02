# Borzoi OTA updater sidecar.
#
# Debian-based (glibc) on purpose. The Alpine `aws-cli` package has a fragile
# Python/expat ABI that can crash on import ("pyexpat … symbol not found"),
# which breaks ECR login. aws-cli v2 is a self-contained bundle with no
# system-Python dependency, so it's stable across base-image drift.
#
# We add only the Docker CLI + Compose plugin (NOT the daemon — the host
# socket is mounted) so the loop can drive the stack. Built locally on the Pi
# from this bundle; never pushed to a registry. Entrypoint/command are set in
# docker-compose.yml so scripts/updater.sh can be edited without a rebuild.
FROM debian:bookworm-slim

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl unzip gnupg bash; \
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
    # aws-cli v2 (self-contained; arch from uname -m → aarch64 / x86_64).
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" \
        -o /tmp/awscliv2.zip; \
    unzip -q /tmp/awscliv2.zip -d /tmp; \
    /tmp/aws/install; \
    rm -rf /tmp/aws /tmp/awscliv2.zip /var/lib/apt/lists/*; \
    # Fail the build early if any tool is broken.
    aws --version; docker --version; docker compose version
