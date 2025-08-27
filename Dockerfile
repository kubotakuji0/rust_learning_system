# ========= Build stage =========
FROM rust:1.84-slim AS builder
WORKDIR /app
COPY server/ /app/server/
RUN cd /app/server && cargo build --release

# ========= Runtime stage =========
FROM rust:1.84-slim
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libsqlite3-dev && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/server/target/release/server /app/server
COPY ui/ /app/ui/
ENV RUST_LOG=info
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["/app/server"]