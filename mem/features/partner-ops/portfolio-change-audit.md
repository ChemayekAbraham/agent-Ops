---
name: Portfolio change audit + email alerts
description: portfolio_change_log table, DB triggers on investor_portfolios/profiles.frozen_at, portfolio-change-notify edge fn emailing jlukodda@gmail.com + pexpert46@gmail.com on every portfolio action
type: feature
---
Every partner-portfolio action is logged and emailed immediately (no cron).

- Table `portfolio_change_log` (action, portfolio_id, portfolio_code, partner_id, partner_name, changed_fields, before_values, after_values, changed_by, changed_at, notified_at). Read access: super_admin/manager/ceo/coo/cfo/partner_ops/financial_ops.
- Trigger `trg_log_portfolio_change` (AFTER INSERT/UPDATE/DELETE on `investor_portfolios`) → `log_portfolio_change()` classifies the action from the diff: created, deleted, principal_edited, contribution_date_edited (created_at), terms_edited (roi_percentage/duration_months), topped_up (amount up), compounded (amount up + total_roi_earned reset), renewed (created_at + maturity_date), suspended (status→suspended/paused). Callers may override with `SET LOCAL app.portfolio_action = '<action>'`.
- Trigger `trg_log_partner_suspension` (AFTER UPDATE OF frozen_at ON `profiles`) → `partner_suspended` / `partner_reinstated`, only for partner accounts.
- Both call `dispatch_portfolio_change_notice()` → `net.http_post` to edge fn `portfolio-change-notify`, which drains unnotified rows, enqueues one before→after table email to **jlukodda@gmail.com** and **pexpert46@gmail.com**, then stamps `notified_at`. Same shape as `rent-amount-change-notify`. Do NOT add a cron job for it.
