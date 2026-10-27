# Local Docker stack

From the repository root, start the isolated development stack:

```sh
docker compose -f infrastructure/local/docker-compose.dev.yml up -d --build
```

The API is available on this computer at `http://127.0.0.1:8088`; check `/readyz` and `/v1/store-settings`.
The first start applies migrations and creates local-only application roles. PostgreSQL and media are persisted in Docker volumes belonging to the `jimmywax-dev` project. This stack does not use or reset the older `jimmywax-backend` volume.

To stop the containers without deleting their data:

```sh
docker compose -f infrastructure/local/docker-compose.dev.yml down
```

This is a development setup: it binds published ports to localhost, uses local test passwords, disk storage, an ephemeral signing key, and logged email instead of SMTP. Login sessions are invalidated when the commerce container restarts. Checkout and external payment and shipping providers remain disabled. It is not a public or production deployment.
