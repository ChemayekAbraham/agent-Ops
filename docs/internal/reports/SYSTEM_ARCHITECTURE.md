```md
# Welile Platform — System Architecture (Refactored & Production-Ready)

**Version:** 2.0 (Post-Refactor Architecture)  
**Status:** Production (Stabilized Evolution)  
**Objective:** Scalable, resilient, and maintainable system supporting continuous growth without downtime

---

# 1. Architecture Philosophy

Welile operates on a **controlled evolution architecture**, designed to:

- Scale safely without breaking production
- Isolate critical systems (especially finance)
- Support offline-first UX without compromising data integrity
- Enable modular growth across domains

---

# 2. High-Level Architecture
```

[ Client (PWA - React) ]
↓
[ API Layer (Edge Functions) ]
↓
[ Core Services Layer ]
↓
[ Database Layer (PostgreSQL + Ledger) ]

```

---

# 3. Core System Layers

## 3.1 Client Layer (PWA)

**Technology:**
- React + TypeScript
- React Query (state management)
- IndexedDB + localStorage (offline support)
- Service Worker (PWA)

**Responsibilities:**
- UI rendering
- Local caching (non-financial data only)
- Request orchestration
- Offline queue handling

**Strict Rules:**
- No business logic in UI
- No financial calculations
- No direct database assumptions

---

## 3.2 API Layer (Edge Functions)

**Technology:**
- Supabase Edge Functions (Deno)

**Responsibilities:**
- Authentication validation
- Role verification
- Request validation
- Routing to Core Services

**Structure:**
```

/finance/_
/rent/_
/agent/_
/user/_

```

**Pattern:**
```

Client → Edge Function → Core Service → Database

```

---

## 3.3 Core Services Layer (Business Logic)

**Purpose:**
Centralized domain logic to eliminate duplication and inconsistencies.

### Domains:

#### A. Finance Domain
```

/core/finance/
ledgerService.ts
walletService.ts
transactionService.ts

```

Handles:
- Ledger operations
- Wallet synchronization
- Transactions
- Financial validation

---

#### B. Rent Domain
```

/core/rent/
rentService.ts
approvalPipeline.ts
repaymentService.ts

```

Handles:
- Rent requests
- Approval pipeline
- Disbursement
- Repayments

---

#### C. User Domain
```

/core/user/
roleService.ts
profileService.ts

```

Handles:
- Role management
- Profile operations

---

#### D. Agent Domain
```

/core/agent/
collectionService.ts
incentiveService.ts

```

Handles:
- Agent collections
- Performance tracking

---

**Core Rule:**
> All business logic MUST live in Core Services

---

## 3.4 Database Layer

**Technology:**
- PostgreSQL (Supabase)

### Key Components:

#### A. Financial System (Ledger-Based)

Tables:
- ledger_accounts
- ledger_transactions
- ledger_entries

**Principles:**
- Append-only
- Double-entry accounting
- No direct balance edits

---

#### B. Operational Tables

- profiles
- user_roles
- wallets (derived from ledger)
- rent_requests
- agent_collections
- notifications

---

#### C. Caching & Analytics

- daily_platform_stats (snapshots)
- materialized views

---

# 4. Data Flow Architecture

## 4.1 Standard Request Flow

```

Client Request
↓
Edge Function (auth + validation)
↓
Core Service (business logic)
↓
Database (read/write)
↓
Response → Client

```

---

## 4.2 Financial Flow (Strict Path)

```

Client Action
↓
Edge Function
↓
transactionService
↓
ledgerService (entries created)
↓
wallet sync (trigger)
↓
Response

```

---

# 5. Offline-First Strategy

## 5.1 Data Classification

| Data Type     | Strategy        |
|--------------|----------------|
| Financial     | Network-first  |
| Profile/UI    | Offline-first  |
| Notifications | Realtime       |

---

## 5.2 Offline Flow

```

User Action (offline)
↓
Stored in local queue
↓
Background sync
↓
Server validation
↓
UI update

```

---

## 5.3 Rules

- Financial data is NEVER trusted offline
- Cached data must be marked with timestamp
- UI always revalidates critical data

---

# 6. Realtime Architecture

**Limited to:**
- notifications
- chat
- system signals

**Disabled for:**
- wallets
- financial transactions
- critical state

---

# 7. Role & Access Architecture

## 7.1 Role Groups

| Group      | Roles |
|-----------|------|
| Consumer   | tenant, landlord |
| Financial  | supporter |
| Field      | agent |
| Admin      | staff, executives |

---

## 7.2 Access Rules

- Roles control access only
- Business logic is role-independent
- All role checks are server-side

---

# 8. Edge Function Architecture

## 8.1 Structure

```

/finance/executeTransaction
/finance/approveOperation

/rent/approveRequest
/rent/disburse

/agent/collect

/user/manageRole

```

---

## 8.2 Orchestrator Pattern

Complex flows handled by single entry points:

```

processRentFlow()
processTransaction()

```

---

## 8.3 Validation

Centralized:
- Input validation
- Role validation
- Security checks

---

# 9. Feature Flag System

Used for safe rollout:

```

useNewFinanceEngine = true | false

```

**Rollout Strategy:**
- 5% users
- 20%
- 50%
- 100%

---

# 10. Error Handling & Observability

## 10.1 Monitoring

Track:
- API failures
- UI crashes
- financial inconsistencies

## 10.2 Logging

- All financial operations logged
- Audit trail for all admin actions

---

# 11. Security Architecture

- Row-Level Security (RLS) on all tables
- Service-role access only for critical operations
- No direct client financial writes
- Strict input validation

---

# 12. Scaling Strategy

- Snapshot caching for dashboards
- Server-side pagination
- Batched queries
- Indexed search (GIN, PostGIS)

---

# 13. Anti-Patterns (Forbidden)

- Direct wallet edits
- Business logic in UI
- Offline financial updates
- Duplicate logic across functions
- Unversioned APIs

---

# 14. Expected Outcomes

- Stable production system
- Reduced bugs and inconsistencies
- Scalable architecture
- Faster development cycles
- High user trust

---

# 15. Final Principle

> Build systems that can evolve without breaking.

This architecture ensures:
- stability today
- scalability tomorrow
- flexibility always

---
```
