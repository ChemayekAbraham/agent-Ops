# Master Phased Implementation Plan: Stabilizing the Architecture

You are entirely correct. I just audited the three specific features you mentioned, and it is a perfect example of what happens when AI builds frontend features without a strict backend architecture. 

Here is exactly why those buttons are broken or unresponsive, and the phased plan to fix the entire platform.

---

## The Broken Hooks (The Diagnosis)

### 1. The "Deposit Cash" Button for Agents
**The Problem:** The AI completely hallucinated this feature to make the UI look complete. In `AgentDepositCashDialog.tsx`, when an agent clicks submit, the frontend resets their daily float limit to `0` and shows a big green "Success!" screen. **It literally never sends the money to the database.** It never calls the ledger. It just fakes success on the screen.
**The Fix:** We must connect this button to the actual `agent-deposit` Edge Function so the transaction hits the `create_ledger_transaction` RPC and becomes real money.

### 2. The "Submit" Button for Registering Tenants
**The Problem:** In `RegisterTenantDialog.tsx`, the frontend executes **5 separate database requests one after another** (1. Create User -> 2. Insert Landlord -> 3. Insert LC1 -> 4. Insert Rent Request -> 5. Update Profile). 
If the agent's internet connection drops at step 3, steps 1 and 2 are permanently stuck in the database. When the agent clicks "Submit" again, it throws a fatal error because the landlord already exists, permanently bricking the registration for that tenant.
**The Fix:** The frontend must make **one** single request. We will move all 5 steps into a single backend RPC that uses a database transaction (`BEGIN...COMMIT`). If step 3 fails, the database automatically deletes steps 1 and 2, keeping the database perfectly clean so the agent can try again.

### 3. The "Capture GPS" Button
**The Problem:** The frontend strictly requests `enableHighAccuracy: true` with a 10-second timeout. On many affordable Android devices or when agents are indoors, the GPS hardware cannot get a high-accuracy lock. It just hangs or times out, leaving the agent unable to proceed.
**The Fix:** We need to rewrite the `captureLocation` hook. It should try high accuracy for 5 seconds. If that fails, it must automatically seamlessly fall back to low accuracy (cellular tower triangulation) so the agent is never blocked.

---

## The Phased Master Plan

Instead of playing whack-a-mole with broken buttons, we need to enforce the **Client -> Edge Function -> RPC -> Ledger** architecture across the board. 

Here is the step-by-step master plan to fix the application:

### Phase 1: Clean the Ledger & Enforce the Fortress (Backend)
*(This is what we discussed previously, executing this first stops the bleeding).*
1. Run the Mass Reconciliation script to neutralize negative balances.
2. Apply the "Ledger Fortress" triggers so no frontend code can ever bypass the double-entry rules again.

### Phase 2: Fix the Critical Agent Frontend Hooks
1. **Fix Tenant Registration:** Write a transactional RPC for Tenant Registration and strip the 5 sequential DB calls out of `RegisterTenantDialog.tsx`.
2. **Fix Agent Deposits:** Connect `AgentDepositCashDialog.tsx` to the backend ledger so it actually records financial data instead of hallucinating success.
3. **Fix GPS Capture:** Implement the high-to-low accuracy fallback in all location hooks so the UI stops hanging.

### Phase 3: Systematic Frontend Audit
1. Audit all remaining forms built by the AI (e.g., Rent Requests, Payouts) to ensure they wait for backend confirmation instead of doing optimistic "fake" updates.
2. Remove any direct `supabase.from('...').insert()` calls from the frontend for critical financial or user data, routing them to Edge Functions instead.

## User Review Required

> [!IMPORTANT]
> The AI faking the "Deposit Cash" success screen is a critical vulnerability.
> 
> **Do you approve this 3-Phase Master Plan?** 
> If you give the green light, we will immediately begin executing Phase 1 (generating the `.sql` to clean the ledger and build the fortress), and then directly move into Phase 2 to fix the agent buttons!
