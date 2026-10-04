# Phase 3: Systematic Frontend Audit & De-Hallucination

## Context for Lovable AI
Lovable, this is a strict architectural constraint prompt. 

Historically, this frontend has suffered from "Optimistic Hallucinations" — meaning the React components were programmed to instantly show success screens and locally update state variables (like `balance` or `collected_today`) without actually awaiting confirmation from the PostgreSQL database or making the required ledger entries. Furthermore, many components were performing brittle, sequential database queries directly from the client.

This has caused severe data corruption and ledger mismatches.

## The Developer Constitution
You must ruthlessly audit the remaining frontend components (especially Financial components, Rent Requests, and Landlord Payouts) and enforce these three laws:

1. **The Ledger Fortress:** The frontend is **never** allowed to execute `supabase.from('general_ledger').insert()` or `supabase.from('wallets').update()`. All financial movement MUST route through the backend `create_ledger_transaction` RPC or an Edge Function.
2. **The "Dumb" Frontend:** The frontend must **never** perform optimistic financial math. (e.g. Do not do `setBalance(balance - amount)`). It must show a spinning loading wheel, wait for the backend to return success, and then completely re-fetch the truth from the database.
3. **Atomic Transactions:** The frontend must **never** execute sequential database requests for a single action (e.g. inserting into 3 different tables sequentially). If a feature requires multiple inserts, you must generate a Postgres RPC to handle it atomically, and the frontend must only call that single RPC.

## Your Phase 3 Mission
Please scan the entire `src/components/` directory and perform the following systematic audit:

### Step 1: Hunt for Direct Mutations
Use your search tools to find any instances of:
*   `supabase.from(...).insert()`
*   `supabase.from(...).update()`
*   `supabase.from(...).delete()`
inside React components (`.tsx` files). 

**Action:** Move these operations into Edge Functions or Postgres RPCs. The frontend should only call `invokeEdgeFunction` or `supabase.rpc()`.

### Step 2: Hunt for Optimistic Fake States
Look for components that update state variables immediately upon button click before the database has confirmed the transaction. 
*   **Example to kill:** `setFloatLimit(limit - amount); toast.success('Done!');`
*   **Action:** Force the component to `setLoading(true)`, await the RPC, check for `error`, and only if successful, `setLoading(false)` and `toast.success()`.

### Step 3: Enforce Error Handling
If the backend throws an error (e.g., "Insufficient Funds" or "Unique Violation"), ensure the `catch` block successfully intercepts it and displays the raw `error.message` to the user via `toast.error()`, rather than crashing or swallowing the error silently.

Please begin executing this Phase 3 Audit immediately. Report back on which components you stripped direct mutations out of.
