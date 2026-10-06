-- Separate "a provider accepted it" from "the handset got it".
--
-- `get_sms_traffic_daily` counts status IN ('sent','success','delivered',
-- 'accepted') as `delivered`, and the CTO dashboard prints that number with the
-- word "delivered" under every traffic tile. Every one of those statuses except
-- the literal 'delivered' means only that a provider took the message:
-- Africa's Talking statusCode 100 is "Processed", and Yoola's own note on a
-- "sent" report reads "accepted by the carrier, no handset receipt returned".
--
-- That label is what sent us chasing a delivery problem on evidence that could
-- not support it. Until today the distinction was moot - `sms_delivery_log` had
-- never held a single `delivered` row in its history, because the Africa's
-- Talking Delivery Report callback was being refused 401 (fixed in the same
-- batch as this, by listing sms-delivery-report in config.toml with
-- verify_jwt = false). With the callback URL now set in the AT dashboard the
-- first confirmations have started landing, so the dashboard should stop
-- conflating the two.
--
-- `delivered` keeps its current meaning and position so the existing viewer is
-- not broken by this migration; `confirmed` is appended as a new column and
-- counts only DLR-confirmed handset receipt.
--
-- Scope caveat worth knowing when reading the number: only Africa's Talking
-- posts delivery reports to us. Yoola delivery is polled separately by
-- sms-yoola-delivery-sweep and its terminal state for most sends is "sent", not
-- "delivered". Since the failover fix means Yoola now keeps the large majority
-- of traffic, `confirmed` will cover a minority of messages for now - a floor on
-- what we know arrived, not a measure of what did.
--
-- DROP + CREATE rather than CREATE OR REPLACE: the return type gains a column,
-- which replace cannot do. Read-only reporting RPC with two callers, both in
-- SmsDeliveryLogViewer.

drop function if exists public.get_sms_traffic_daily(integer);

create function public.get_sms_traffic_daily(p_days integer)
returns table(
  day date,
  total bigint,
  delivered bigint,
  failed bigint,
  yoola bigint,
  africastalking bigint,
  other bigint,
  confirmed bigint
)
language sql
stable
security definer
set search_path = public
as $$
  SELECT
    date_trunc('day', created_at)::date AS day,
    count(*) AS total,
    count(*) FILTER (WHERE lower(status) IN ('sent','success','delivered','accepted')) AS delivered,
    count(*) FILTER (WHERE lower(status) NOT IN ('sent','success','delivered','accepted')) AS failed,
    count(*) FILTER (WHERE lower(provider) = 'yoola') AS yoola,
    count(*) FILTER (WHERE lower(provider) LIKE '%africa%') AS africastalking,
    count(*) FILTER (WHERE lower(provider) <> 'yoola' AND lower(provider) NOT LIKE '%africa%') AS other,
    -- Handset receipt confirmed by a provider delivery report. Nothing else.
    count(*) FILTER (WHERE lower(status) = 'delivered') AS confirmed
  FROM public.sms_delivery_log
  WHERE created_at >= (date_trunc('day', now()) - make_interval(days => greatest(p_days, 1) - 1))
  GROUP BY 1
  ORDER BY 1;
$$;

comment on function public.get_sms_traffic_daily(integer) is
  'Daily SMS traffic for the CTO dashboard. `delivered` means a provider accepted the message (sent/success/accepted/delivered); `confirmed` means a delivery report confirmed handset receipt. They are not the same thing and the second is much smaller.';

revoke all on function public.get_sms_traffic_daily(integer) from public;
grant execute on function public.get_sms_traffic_daily(integer) to authenticated;
