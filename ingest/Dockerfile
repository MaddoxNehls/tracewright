# syntax=docker/dockerfile:1

FROM golang:1.27-alpine AS build
WORKDIR /src

# Download modules in their own layer so code edits don't refetch them.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/tracewright-ingest ./cmd/tracewright-ingest

# Static binary on distroless: no shell or package manager to attack, runs as non-root.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/tracewright-ingest /usr/local/bin/tracewright-ingest
EXPOSE 4318
ENTRYPOINT ["/usr/local/bin/tracewright-ingest"]
