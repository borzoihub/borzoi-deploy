# Borzoi OTA updater sidecar.
#
# A minimal toolbox image: the Docker CLI + Compose plugin (to drive the
# stack via the mounted host socket), aws-cli (to authenticate to ECR), and
# bash (for the updater loop). Built locally on the Pi from this bundle — it
# is never pushed to a registry, so the normal `docker compose pull` of the
# runtime services skips it.
#
# The entrypoint + command are set in docker-compose.yml so the loop script
# can be edited (mounted from the project) without rebuilding this image.
FROM docker:27-cli

RUN apk add --no-cache bash aws-cli docker-cli-compose
