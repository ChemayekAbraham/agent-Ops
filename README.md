# Welile — Africa's Rent Facilitation Platform

[![Stack](https://img.shields.io/badge/React-18-blue?style=flat-square&logo=react)](https://react.dev)
[![Backend](https://img.shields.io/badge/Supabase-Database%20%26%20Auth-green?style=flat-square&logo=supabase)](https://supabase.com)
[![Edge Functions](https://img.shields.io/badge/Edge%20Functions-300%2B-informational?style=flat-square&logo=deno)](./supabase/functions)
[![PWA](https://img.shields.io/badge/PWA-offline--first-purple?style=flat-square)](./public)

Welile is a Ugandan rent-facilitation and fintech platform. Tenants who can't pay rent as a lump sum get a **Rent Plan**: Welile pays the landlord up front and the tenant repays daily over 7–120 days. Field **agents** originate, verify, and collect. **Supporters** (retail funders/partners) supply capital and earn **Returns**. Every shilling is double-entry accounted through a central ledger.

* **Production URL:** [https://welileapp.com](https://welileapp.com)
* **Public API:** [https://api.welileapp.com](https://api.welileapp.com) — see [`docs/WELILE_API.md`](./docs/WELILE_API.md)
* **Source repository:** [github.com/weliletenants-sys/welilereceipts-com-98bba33b](https://github.com/weliletenants-sys/welilereceipts-com-98bba33b) (this repo — managed via [Lovable](https://lovable.dev))

> Regulatory terminology is mandatory in user-facing copy: *Rent Plan* (not loan), *Supporter* (not lender), *Returns* (not ROI).

For the full canonical architecture reference (data model, ledger internals, subsystem inventory, operational rules), see [`SYSTEM_CONTEXT.md`](./SYSTEM_CONTEXT.md) — it is the source of truth ahead of this file.

> ### 🚨 New engineer, or production is on fire?
> Start at [**`docs/HANDOVER/`**](./docs/HANDOVER/) — the engineer survival manual.
> `SYSTEM_CONTEXT.md` explains *how the system works*; the handover folder explains *how not to
> destroy it*: kill switches, danger zones, incident runbooks, disaster recovery, and the traps
> that have already cost real money. It is verified against the live production database and
> records exactly where `SYSTEM_CONTEXT.md` has fallen behind.

### Contents

- [Key Capabilities](#-key-capabilities)
- [Architecture & Technology Stack](#-architecture--technology-stack)
- [Documentation](#-documentation)
- [Project Structure](#-project-structure)
- [Developer Setup](#-developer-setup)
- [Build-Time Guards](#-build-time-guards)
- [Deployment](#-deployment)
- [License](#license)

---

## 🚀 Key Capabilities

### 🏢 For Tenants
* **Rent Financing:** Access instant rent advances and pay back in flexible, structured installments.
* **Trust Profiles:** Build a verifiable tenant score to qualify for larger rent plans and better rates.
* **Mobile Wallet:** Seamless deposits, withdrawals, and payments powered by MTN & Airtel Mobile Money.

### 🧑‍💼 For Agents
* **Field Origination:** Register tenants and landlords, verify LC1/ID documents, and list houses from a mobile-first workflow.
* **Collections:** Record daily repayments, track today's collections against target, and see portfolio health at a glance.
* **Wallet & Commission:** Earn commission on collections and placements, tracked in a dedicated wallet and withdrawable to mobile money.

### 🏠 For Landlords
* **Guaranteed Rent:** Minimize default risk with guaranteed payout programs.
* **Property Listings:** List and verify residential units for local search.
* **Automated Ledgers:** Live tenant payment reconciliation, print-ready payout receipts, and automated tax accounting.

### 💰 For Funders (Supporters)
* **Capital Growth:** Fund verified tenant rent plans and earn Returns.
* **Portfolio Analytics:** Real-time visibility into active pools, compounding yields, maturity profiles, and risk distribution.

---

## 🛠️ Architecture & Technology Stack

The platform is engineered as a secure, responsive PWA optimized for performance on mobile browsers and low-bandwidth connections.

| Layer | Technology | Details |
| :--- | :--- | :--- |
| **Frontend** | React 18, Vite, TypeScript | Lazy-loaded routes with retry/concurrency limiting, offline-first React Query, installable PWA. |
| **Styling & UI** | Tailwind CSS, shadcn/ui | Radix UI primitives, dark/light themes, responsive mobile design. |
| **Database & Auth** | Supabase (PostgreSQL) | Row Level Security policies, SECURITY DEFINER RPCs, database triggers. The frontend never writes ledger/wallet state directly — enforced at build time by `scripts/guard-frontend-ledger-writes.mjs`. |
| **Serverless** | Supabase Edge Functions (Deno) | 300+ functions covering money movement, transactional email (Mailgun), SMS (Yoola → Africa's Talking → LANA), WhatsApp (Twilio), PDF generation, and MoMo reconciliation. |
| **AI Tooling** | MCP servers (`supabase/functions/mcp*`) | Model Context Protocol tools exposing wallet/profile data to signed-in users and public onboarding info to prospective users — both read-only and RLS-scoped. |
| **Third-Party APIs** | Google Maps, MTN/Airtel Mobile Money | Location-based search, mobile money payment rails. |

---

## 📚 Documentation

[`SYSTEM_CONTEXT.md`](./SYSTEM_CONTEXT.md) is the canonical architecture reference and should be read first. `docs/` holds deeper, subsystem-specific write-ups reverse-engineered from the live schema and code, kept for engineers, operations, finance, and future AI assistants:

| Doc | Covers |
| :--- | :--- |
| [**`docs/HANDOVER/`**](./docs/HANDOVER/) | **Engineer survival manual** — kill switches, danger zones, incident runbooks, disaster recovery, live-state verification, and hard-won tribal knowledge. Read `07-tribal-knowledge.md` early. |
| [`docs/WELILE_API.md`](./docs/WELILE_API.md) | The versioned public REST API (`api.welileapp.com`) consumed by the Welile Flutter app. |
| [`docs/AGENT_SYSTEM_ARCHITECTURE.md`](./docs/AGENT_SYSTEM_ARCHITECTURE.md) | Field agent model — wallets, commissions, advances, portfolio limits. |
| [`docs/FINANCIAL_SYSTEM_ARCHITECTURE.md`](./docs/FINANCIAL_SYSTEM_ARCHITECTURE.md) / [`FINANCIAL_OPERATIONS_ARCHITECTURE.md`](./docs/FINANCIAL_OPERATIONS_ARCHITECTURE.md) | The double-entry ledger, wallet invariants, and Financial Ops workflows. |
| [`docs/SUPPORTER_SYSTEM_ARCHITECTURE.md`](./docs/SUPPORTER_SYSTEM_ARCHITECTURE.md) | Supporter capital, Returns, and portfolio lifecycle. |
| [`docs/TENANT_OPERATIONS_ARCHITECTURE.md`](./docs/TENANT_OPERATIONS_ARCHITECTURE.md) | Rent Plan origination, repayment, and trust scoring. |
| [`docs/internal/`](./docs/internal/) & [`docs/investigations/`](./docs/investigations/) | Point-in-time incident reports and design investigations — historical context, not living reference. |

`mem/` (plus `.lovable/`) is Lovable's project memory: durable business rules and architecture notes indexed at [`mem/index.md`](./mem/index.md), consulted by both the Lovable agent and Claude Code when working in this repo.

---

## 📦 Project Structure

```text
├── .github/                 # CI/CD workflows
├── docs/                    # Architecture & API documentation (see Documentation above)
├── mem/, .lovable/          # Lovable project memory (business rules, architecture notes)
├── public/                  # Manifests, icons, PWA configuration, sitemaps
├── scripts/                 # Build-time guards, sitemap/dist generation, verification
├── src/
│   ├── components/          # Reusable UI component library (shadcn) + feature components
│   ├── hooks/                # Custom React hooks (auth, wallet, ops)
│   ├── integrations/         # Supabase client + generated schema types
│   ├── lib/                  # Calculation engines, PDF generators, helpers
│   └── pages/                 # Routed pages (per-persona dashboards, marketplace, landing)
├── supabase/
│   ├── functions/            # 300+ Edge Functions (API endpoints, cron jobs, emailers)
│   └── migrations/           # PostgreSQL schema migrations (see caveat below)
├── e2e/                      # Playwright end-to-end tests
├── SYSTEM_CONTEXT.md         # Canonical architecture reference (start here)
├── tailwind.config.ts        # Design tokens, color system, layout themes
└── vite.config.ts            # Bundler build config and code-split definitions
```

> **Caveat:** `supabase/migrations/` does not necessarily reflect the live production schema exactly — always verify columns/functions/RPCs against the actual database before relying on a migration file.

---

## 💻 Developer Setup

### Prerequisites
* **Node.js** (v18 or higher)
* **npm** or **bun** package manager
* A `.env` file with the variables listed under [Deployment](#-deployment) below — copy `.env.example` as a starting point. **Never commit or print `.env`.**

### Installation & Startup
```bash
# 1. Clone this repository
git clone https://github.com/weliletenants-sys/welilereceipts-com-98bba33b.git
cd welilereceipts-com-98bba33b

# 2. Install dependencies
npm install

# 3. Spin up local development server
npm run dev
```
The application will launch on [http://localhost:8080](http://localhost:8080).

### Build & Test

```bash
npm run lint        # ESLint
npm run build       # runs build-time guards, generates the sitemap, builds, and verifies dist/
npm run guard:all    # run all build-time guards on demand, outside of a full build
npm run test:e2e     # Playwright end-to-end tests (e2e/)
npm run test:e2e:install  # one-time: install the Playwright Chromium browser
```

---

## 🛡 Build-Time Guards

`npm run guard:all` runs the following checks in order (see `scripts/run-guards.mjs`); any failure blocks the build:

| Guard | Enforces |
| :--- | :--- |
| `check-runtime-env.mjs` | Required build-time environment variables are present. |
| `guard-schema-types.mjs` | The generated Supabase schema types match the reviewed fingerprint (catches un-reviewed schema drift). |
| `guard-frontend-ledger-writes.mjs` | No file under `src/` mutates `wallets` / `general_ledger` directly — all money movement must go through a backend RPC. |
| `guard-deposit-purpose.mjs` | Every `deposit_purpose` write is routed through `safeDepositPurpose(...)`, never a raw/possibly-empty expression. |
| `guard-legacy-domain.mjs` | No shipping file references a legacy domain (`welilereceipts.com`, `welilereciept.com`) — only `welileapp.com`. |
| `guard-location-freetext.mjs` | Ugandan administrative locations are captured via the shared dataset-backed pickers, not raw text inputs. |
| `guard-canonical-tags.mjs` | Every public route ships a correct `<link rel="canonical">` for `welileapp.com`. |
| `guard-mcp-deploy.mjs` | The generated MCP deploy imports in `supabase/functions/mcp*` are in sync. |

`guard-persona-routes.mjs` (`npm run guard:persona-routes`) is a related standalone check — every persona dashboard route must live under `/dashboard/{role}` — but is not currently part of `guard:all`.

---

## 🌐 Deployment

The production app is a static SPA served through the Lovable proxy (`no-cache` on `index.html`); Edge Functions and database migrations deploy independently of the frontend build. Required environment variables:

* `VITE_SUPABASE_URL`
* `VITE_SUPABASE_PUBLISHABLE_KEY`
* `VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY`

The canonical public domain is `welileapp.com`. `scripts/guard-legacy-domain.mjs` fails the build if any shipping file references a legacy domain (see `scripts/site-domains.mjs`).

---

## License

Proprietary — © Welile Technologies Limited. All rights reserved. This source is not licensed for reuse, redistribution, or derivative works outside of Welile's own deployments.
