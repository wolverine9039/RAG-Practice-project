# Caddy with the per-IP rate limiting module (github.com/mholt/caddy-ratelimit); built on the VM by docker compose.
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/mholt/caddy-ratelimit

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
