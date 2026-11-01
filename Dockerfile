# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: Build React Dashboard
# ==============================================================================
FROM node:22-alpine AS dashboard-build
WORKDIR /app/dashboard

COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci

COPY dashboard/ ./
RUN npm run build

# ==============================================================================
# Stage 2: Build Go Control Plane (CGO enabled for SQLite3)
# ==============================================================================
FROM golang:bookworm AS controlplane-build
WORKDIR /src

COPY controlplane/go.mod controlplane/go.sum ./
RUN go mod download

COPY controlplane/ ./
RUN CGO_ENABLED=1 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/felcloud-controlplane .

# ==============================================================================
# Stage 3: Base Debian Runtime for Control Plane
# ==============================================================================
FROM debian:bookworm-slim AS runtime-base

LABEL org.opencontainers.image.title="FelCloud Control Plane" \
      org.opencontainers.image.description="Multi-tenant resilient IP gateway and routing control plane" \
      org.opencontainers.image.vendor="FelCloud" \
      org.opencontainers.image.licenses="MIT"

# hadolint ignore=DL3008
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --gid 10001 felcloud && \
    useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin felcloud && \
    mkdir -p /app /data /tmp && \
    chown -R 10001:10001 /app /data /tmp

WORKDIR /app

COPY --from=controlplane-build --chown=10001:10001 /out/felcloud-controlplane /app/felcloud-controlplane
COPY --from=dashboard-build --chown=10001:10001 /app/dashboard/dist /app/dashboard

VOLUME ["/data"]
EXPOSE 8081

ENV DASHBOARD_DIR=/app/dashboard \
    LISTEN_ADDR=0.0.0.0 \
    IPAM_DB_PATH=/data/ipam.db

USER 10001:10001

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD ["curl", "-f", "http://127.0.0.1:8081/health"]

ENTRYPOINT ["/app/felcloud-controlplane"]
CMD ["serve", "--port", "8081"]

# ==============================================================================
# Stage 4: runtime-live (OpenStack & Gateway Automation via Ansible)
# ==============================================================================
FROM runtime-base AS runtime-live

USER 0:0

# hadolint ignore=DL3008
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ansible-core \
      openssh-client \
      python3 \
      python3-pip && \
    mkdir -p /usr/share/ansible/collections && \
    ansible-galaxy collection install ansible.posix:==1.6.2 -p /usr/share/ansible/collections && \
    rm -rf /var/lib/apt/lists/*

COPY --chown=10001:10001 ansible/ /app/ansible/

ENV PROVISIONER=openstack \
    MOCK_GATEWAYS=false \
    ANSIBLE_INVENTORY=/app/ansible/inventory/hosts.yml \
    HAPROXY_TRANSACTION_PLAYBOOK=/app/ansible/haproxy-transaction.yml

USER 10001:10001

# ==============================================================================
# Stage 5: bench (Reproducible Benchmark Harness)
# ==============================================================================
FROM python:3.12-slim AS bench

LABEL org.opencontainers.image.title="FelCloud Benchmark Suite" \
      org.opencontainers.image.description="Reproducible benchmark harness for FelCloud failover, recycling, and provisioning" \
      org.opencontainers.image.vendor="FelCloud" \
      org.opencontainers.image.licenses="MIT"

# hadolint ignore=DL3008
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --gid 10001 felcloud && \
    useradd --uid 10001 --gid 10001 --no-create-home --shell /bin/bash felcloud && \
    mkdir -p /app/bench/results && \
    chown -R 10001:10001 /app

WORKDIR /app

COPY bench/requirements.txt /app/bench/requirements.txt
RUN pip install --no-cache-dir -r /app/bench/requirements.txt

COPY --chown=10001:10001 bench/ /app/bench/

USER 10001:10001

ENV MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/matplotlib \
    PYTHONUNBUFFERED=1

ENTRYPOINT ["bash", "bench/run_all.sh"]
CMD ["--dry-run"]

# ==============================================================================
# Stage 6: runtime-mock (Default Target)
# ==============================================================================
FROM runtime-base AS runtime-mock

ENV PROVISIONER=mock \
    MOCK_GATEWAYS=true
