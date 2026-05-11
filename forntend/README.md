# ZMC frontend (Vite + React + TypeScript)

Crowdfunding UI for **No Man Company (ZMC)**. See the [repository root README](../README.md) for product overview, architecture, and full setup (database, backend, env vars).

## Quick start

```bash
cp .env.example .env   # set VITE_API_URL, VITE_ESCROW_WALLET, VITE_SOLANA_RPC
pnpm install
pnpm dev
```

App routes live under `/app` after login; landing is at `/`.
