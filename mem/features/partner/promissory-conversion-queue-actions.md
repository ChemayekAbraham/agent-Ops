---
name: Promissory conversion queue Partner Ops actions
description: Assign / contact / snooze / resolve actions on open promises, logged append-only in promissory_note_ops_actions — never touches the note, wallets or reminders
type: feature
---

UI: `src/components/executive/partner-ops/PromissoryConversionQueue.tsx` with `PromissoryOpsActionDialog.tsx`.

Table `promissory_note_ops_actions` — append-only working log (actions `assign|unassign|contact|snooze|unsnooze|resolve|reopen`), `reason` required at 10+ characters, no UPDATE/DELETE policy. RLS SELECT for `promissory_ops_can_act(auth.uid())` (partner_ops, operations, coo, ceo, cfo, manager, super_admin) or the assignee.

RPCs (SECURITY DEFINER): `promissory_ops_record_action(p_note_id, p_action, p_reason, p_assigned_to, p_channel, p_outcome, p_snooze_until, p_resolution)` — sole write path, authority-checked, snooze must be a future date, resolve needs an outcome; `promissory_ops_queue_state()` — current assignment / snooze / resolution / last contact per note, derived from the log only; `promissory_ops_assignees()` — partner_ops/operations/coo users.

Rules:
- The promise itself is never modified. Status stays `pending` — "Resolve" only hides it from the working queue and it still counts as open money in the totals.
- `promissory_notes.follow_up_status` / `last_followed_up_on` are deliberately NOT written here: the agent Mon/Wed/Fri chase skips agents who followed up within 7 days, so writing them would silently suppress agent reminders.
- Views: To work (excludes snoozed + resolved), Mine, Assigned, Snoozed, Resolved, Everything.
