# BidMaster

<p align="center">
  <a href="./README.md">简体中文</a> | <strong>English</strong>
</p>

BidMaster is an AI bid-writing tool for the tendering and bidding domain. It ships as a pure web application that runs entirely in the browser and deploys as a single Docker instance, with login and product access handled by MainQuest OAuth.

> Repository: <https://github.com/zangqing828-ux/Bidding-Copilot>

## Release Scope

- **Technical proposal generation**: upload tender documents (PDF / DOCX / TXT / Markdown) → requirement analysis → outline → fact materials → body content → images → high-fidelity DOCX export and download.
- **Expansion of existing proposals**: structured expansion based on existing proposal text.
- **Template management**: create, edit and preview export templates.
- **Settings**: text model, image model and document parsing configuration, encrypted and stored on the server.

Long-running tasks execute on the server with continuous persistence; progress is recoverable after page refresh or container restart. Mermaid, HTML charts, AI image generation, and template-based high-fidelity DOCX export all run server-side.

## Deployment

- Single-instance Docker deployment; one deployment maps to one tenant business space.
- All authorized users share the same tenant business data while keeping independent sessions and identity records.
- Production enforces MainQuest OAuth (`OAUTH_MODE=mainquest`) and HTTPS.

### Quick Start with Docker

```bash
# Build the image (repository root)
docker build -t bidmaster-web:local .

# Prepare environment variables
cp .env.example .env   # fill in OAuth, SESSION_SECRET, CONFIG_ENCRYPTION_KEY, etc.

# Start
docker compose up -d

# Health checks
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/readiness
```

The data directory is injected via `BIDMASTER_DATA_DIR` (default `/data`). Business state lives in the tenant SQLite database and tenant file directories; configure a persistent volume and backups for `/data`.

See [docs/web-deployment.md](./docs/web-deployment.md) for full deployment details.

## Local Development

```bash
cd client
npm ci
npm run dev:web      # development mode
npm run build:web    # web build
npm run test:web     # web-focused tests
```

See [client/开发说明.md](./client/开发说明.md) and [AGENTS.md](./AGENTS.md) for development conventions.

## Project Documentation

- [Project goals and locked decisions](./project.md)
- [Web single-tenant release baseline](./.planning/web-single-tenant-release/baseline.md)
- [Contributing guide](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)

## License

Released under an open-source license. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
