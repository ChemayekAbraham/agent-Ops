# 50 — Manual unlink: Denis Tushabe from parent agent IAN MUHWEZI

**Read this if you're auditing recent `agent_subagents` deletions, or if Denis Tushabe
(`a5fdeba7-13ef-48e9-b93a-a82b8d02807f`, +256746722190) reports he's still showing a parent
agent, or if a "My Parent Agent" screenshot shows different name/phone than what's currently
in `profiles` for a linked parent.**

## What was asked

Josh Wanda sent a screenshot of Denis Tushabe's "My Parent Agent" dialog (`ParentAgentDialog.tsx`,
backed by RPC `get_my_parent_agent`) showing a parent agent labeled "sir ian martin",
+256743668441, linked 3 Sep 2026, and asked to unlink him.

## What was found

Denis's only `agent_subagents` row (`id = 2e182006-8d4f-495d-b061-7e6ff75f5407`) linked him to
parent `3d78f1f8-f690-4fe8-bb2e-202f3ef2ecb0`, `status = verified`, `source = admin_assignment`,
created 2026-09-03 — the date matches the screenshot exactly. But that parent's **current**
`profiles` row is `IAN MUHWEZI`, +256787725122 (`previous_full_name = 'Muhwezi Martin Ian'`).
No profile anywhere in the database has the phone +256743668441. `get_my_parent_agent` joins
`profiles` live (not a snapshot), so the screenshot's name/phone are simply stale — the parent
agent renamed himself and changed his phone at some point after the screenshot was taken. This
was **not** a duplicate-identity misattachment ([[project_duplicate_identity_portfolio_misattach]]-style
bug) — there was exactly one link row, the created_at date confirmed it was the right one, so there
was no ambiguity about which record to remove.

## What was done

Replicated `admin_unlink_subagent`'s logic by hand directly against production (same pattern as
doc 42's Timothy Kalyango fix) — the RPC itself requires `auth.uid()` with an operations role,
which isn't available from a direct DB session:

1. Checked pending `subagent_tenant_transfers` for this pair (0) and active
   `agent_listing_blocks` blocked by this parent (0) — nothing to cancel/clear.
2. Deleted the one `agent_subagents` row.
3. Archived it into `agent_subagent_link_archive` with a reason noting this was a manual ops
   request via Claude Code.
4. Inserted an `audit_logs` row (`action_type = 'subagent_made_independent'`, `user_id = NULL`
   since there was no authenticated actor — `requested_by` in metadata instead).

Denis keeps his 11 active tenants (`rent_requests.status in ('funded','repaying')`) — per the
existing unlink design, sub-agents are made independent, not stripped of their tenants.

## Verified after

- `agent_subagents` for Denis: 0 rows.
- `agent_team_membership_history` for this (parent, member) pair: 0 rows with `valid_to IS NULL`
  — the doc-42 self-healing trigger (`close_agent_team_membership_history_on_unlink`) fired
  correctly and closed the history row automatically. No manual close needed this time.

## What not to do

- Don't treat a stale name/phone in a "My Parent Agent" screenshot as evidence of a wrong link
  by itself — check `agent_subagents.created_at` against the screenshot's "Linked date" first;
  if there's exactly one row and the date matches, it's almost certainly just a rename/phone
  change on the parent's account since the screenshot was taken.
