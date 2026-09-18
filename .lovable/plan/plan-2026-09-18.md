# Plan

## Goal
Stop unpaid-landlord tenants like Kagezi Kato Ali from adding to an agent's daily target, while keeping already-valid collected figures unchanged.

## Changes
- Make the agent capacity card trust the backend daily-target result when it succeeds, including a valid zero target.
- Prevent fallback target math from counting funded tenants whose landlord float is still open and unpaid.
- Apply the same safe fallback rule in the Agent Ops fleet capacity view so the agent card and ops view do not disagree.
- Leave payment, collection, repayment, wallet, and accounting records untouched.

## Validation
- Check Kagezi's agent target no longer includes UGX 8,314 when the landlord is unpaid.
- Confirm the app has no build errors after the change.

## Required security cleanup
- Inspect the three flagged read policies.
- Tighten them only if a safe role-based rule is clear.
- Mark each finding fixed only after the backend policy change is applied.
