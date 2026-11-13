# Sync confirmation: dd84f831fe

No code changes.

- Workspace HEAD is `dd84f831fe`, working tree clean.
- Both migrations are present and will not be re-run or edited:
  - `20261121160000_regrant_direct_pay_can_view_to_authenticated.sql`
  - `20261121170000_regrant_partner_return_policy_caller_ok.sql`
- Standing rule going forward: never re-add the REVOKE on `_direct_pay_can_view(uuid)` from authenticated. The storage policy `direct_pay_staff_read_offplatform_receipt` needs that grant. If the function ever has to be closed, change the policy approach first.
