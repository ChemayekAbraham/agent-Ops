---
name: Single email route per user
description: A MoMo/email transaction can be routed once per target user; routing to a different user is still allowed; only reversals re-open the same user.
type: constraint
---
**Rule (DB trigger `trg_enforce_single_forward_email_route` on `email_routing_history`):**

A single `gmail_transaction_id` may have AT MOST ONE active (non-reversed) forward route **per `target_user_id`**.

- ✅ Routing the same email to a **different user** → allowed.
- ❌ Routing the same email to the **same user** twice → blocked with `DUPLICATE_EMAIL_ROUTE` (`unique_violation`).
- ✅ Rows whose `reason ILIKE 'Reversed%'` are exempt and re-open routing to that user.

**Why:** Auto-credit (e.g. CFO auto-route) already lands the money in user A's wallet. A second manual route to user A would create phantom value. But the same physical TID may legitimately need to be routed to user B (e.g. wrong auto-match), so we only scope the lock per target user. UI buttons remain enabled and read "Route to another user" when already routed; the trigger is the hard backstop.
