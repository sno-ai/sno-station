FROM node:24.15.0-bookworm-slim AS node
FROM ubuntu:22.04

COPY --from=node /usr/local/ /usr/local/
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash build-essential ca-certificates coreutils file findutils git hostname jq \
    procps python3 sed strace tmux util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts acpx@0.13.2 \
    && useradd --create-home --uid 1000 --shell /bin/bash runner

USER runner
WORKDIR /workspace
ENTRYPOINT ["bash", "tests/apps/reach/ci/run.sh"]
