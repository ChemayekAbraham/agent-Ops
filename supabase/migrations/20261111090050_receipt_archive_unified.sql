-- Receipt Archive home (/admin/financial-ops/receipt-archive): one searchable list of every receipt, money in and money out.
--
-- WHAT THIS IS: read-only. It never writes to wallets, general_ledger or any receipt row.
--   IN  = partner_receipts (digital receipts for money partners hand in; see 20261105180000_partner_receipts.sql, which must be applied first).
--   OUT = completed withdrawal_requests that carry a receipt_token (the payout receipts at welileapp.com/r/<token>).
--
-- NUMBERING: paper receipts ran to No. 4299, so the first digital receipt is 4300. The base migration seeded the counter at 4102;
-- this lifts it to 4299 (never lowers it, so re-running is safe and a counter already past 4299 is left alone).
--
-- WHO: IN rows are visible to everyone who can view partner receipts (Financial Ops, CFO, super admin, Partner Ops).
--      OUT rows (payouts, with the recipient's name and phone) are visible only to those who can issue (Financial Ops, CFO, super admin).
--
-- SEARCH: a phone number matches however it is typed (0772123456, 772123456, +256 772 123 456, or just the last digits).
-- Roll back with 20261111090000_receipt_archive_unified.rollback.sql.

UPDATE public.partner_receipt_counter SET last_no = greatest(last_no, 4299) WHERE id = 1;

-- Last 9 digits of a phone number: the same key whether it was typed 07.., 7.., 2567.. or +2567..
CREATE OR REPLACE FUNCTION public.receipt_phone_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(d) >= 9 THEN right(d, 9) ELSE d END
    FROM (SELECT regexp_replace(coalesce(p, ''), '\D', '', 'g') AS d) s
$$;

CREATE OR REPLACE FUNCTION public.search_receipt_archive(
  p_search text DEFAULT NULL, p_direction text DEFAULT NULL, p_from date DEFAULT NULL, p_to date DEFAULT NULL,
  p_method text DEFAULT NULL, p_source text DEFAULT NULL, p_status text DEFAULT NULL,
  p_limit integer DEFAULT 25, p_offset integer DEFAULT 0
) RETURNS TABLE (
  source text, id uuid, receipt_ref text, receipt_no integer, direction text, event_at timestamptz,
  client_name text, client_phone text, purpose text, method text, amount numeric, status text,
  replaced_by_no integer, link_token text, issued_by_name text, total_count bigint
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_out boolean;
  q text := nullif(btrim(coalesce(p_search, '')), '');
  phoneish boolean;
  d text;
  v_amt numeric;
BEGIN
  IF NOT public.can_view_partner_receipts(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  v_out := public.can_issue_partner_receipt(auth.uid());

  phoneish := q IS NOT NULL AND q ~ '^\+?[0-9][0-9 ()-]*$';
  d := regexp_replace(coalesce(q, ''), '\D', '', 'g');
  IF d LIKE '256%' AND length(d) >= 12 THEN d := substr(d, 4);
  ELSIF d LIKE '0%' THEN d := substr(d, 2);
  END IF;
  -- Amount search: "150,000" or "150000". Guard the cast so a long digit string cannot error.
  v_amt := CASE WHEN phoneish AND length(regexp_replace(q, '\D', '', 'g')) BETWEEN 1 AND 15
                THEN regexp_replace(q, '\D', '', 'g')::numeric END;

  RETURN QUERY
  WITH u AS (
    SELECT 'partner_receipt'::text AS source, r.id, r.receipt_no::text AS receipt_ref, r.receipt_no, 'in'::text AS direction,
           (r.received_on::timestamp AT TIME ZONE 'Africa/Kampala') AS event_at,
           r.received_from AS client_name, r.payer_phone AS client_phone, r.purpose,
           r.payment_method AS method, r.amount,
           CASE WHEN r.status = 'issued' THEN 'issued' WHEN r.superseded_by_id IS NOT NULL THEN 'corrected' ELSE 'voided' END AS status,
           (SELECT s.receipt_no FROM public.partner_receipts s WHERE s.id = r.superseded_by_id) AS replaced_by_no,
           NULL::text AS link_token, ip.full_name AS issued_by_name
      FROM public.partner_receipts r
      LEFT JOIN public.profiles ip ON ip.id = r.issued_by
    UNION ALL
    SELECT 'payout'::text, w.id, 'RCPT-' || upper(left(w.receipt_token, 8)), NULL::integer, 'out'::text,
           coalesce(w.processed_at, w.created_at), pr.full_name, pr.phone,
           CASE WHEN lower(coalesce(w.reason, '')) LIKE '%landlord%' THEN 'Landlord payout'
                WHEN lower(coalesce(w.reason, '')) ~ '(portfolio|roi|return)' THEN 'Returns payout'
                WHEN lower(coalesce(w.reason, '')) LIKE '%advance%' THEN 'Credit draw'
                ELSE 'Wallet cash-out' END,
           CASE w.payout_method WHEN 'mtn_momo' THEN 'mobile_money' WHEN 'airtel_money' THEN 'mobile_money'
                WHEN 'bank_transfer' THEN 'bank_transfer' WHEN 'cash' THEN 'cash' ELSE coalesce(w.payout_method, 'mobile_money') END,
           w.amount, 'issued'::text, NULL::integer, w.receipt_token, NULL::text
      FROM public.withdrawal_requests w
      LEFT JOIN public.profiles pr ON pr.id = w.user_id
     WHERE v_out AND w.receipt_token IS NOT NULL AND w.status = 'completed'
  ), f AS (
    SELECT u.* FROM u
     WHERE (p_direction IS NULL OR u.direction = p_direction)
       AND (p_source IS NULL OR u.source = p_source)
       AND (p_method IS NULL OR u.method = p_method)
       AND (p_status IS NULL OR u.status = p_status)
       AND (p_from IS NULL OR (u.event_at AT TIME ZONE 'Africa/Kampala')::date >= p_from)
       AND (p_to IS NULL OR (u.event_at AT TIME ZONE 'Africa/Kampala')::date <= p_to)
       AND (q IS NULL OR (
             CASE WHEN phoneish THEN
                  u.receipt_no::text = q
               OR (v_amt IS NOT NULL AND u.amount = v_amt)
               OR ((length(d) >= 6 OR q ~ '^[+0]') AND d <> '' AND public.receipt_phone_key(u.client_phone) LIKE '%' || d || '%')
             ELSE
                  u.client_name ILIKE '%' || q || '%'
               OR u.receipt_ref ILIKE '%' || q || '%'
               OR coalesce(u.link_token, '') ILIKE '%' || q || '%'
             END))
  )
  SELECT f.source, f.id, f.receipt_ref, f.receipt_no, f.direction, f.event_at, f.client_name, f.client_phone, f.purpose,
         f.method, f.amount, f.status, f.replaced_by_no, f.link_token, f.issued_by_name,
         count(*) OVER () AS total_count
    FROM f
   ORDER BY f.event_at DESC, f.id
   LIMIT least(greatest(p_limit, 1), 200) OFFSET greatest(p_offset, 0);
END $$;

-- Totals for the summary cards, for the chosen date range (default: today, Kampala time).
CREATE OR REPLACE FUNCTION public.receipt_archive_summary(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  f date;
  t date;
  v_out boolean;
  in_n bigint; in_total numeric;
  out_n bigint := 0; out_total numeric := 0;
  v_voided bigint;
  v_cash bigint;
  v_corr bigint;
BEGIN
  IF NOT public.can_view_partner_receipts(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  v_out := public.can_issue_partner_receipt(auth.uid());
  f := coalesce(p_from, today);
  t := coalesce(p_to, f);

  SELECT count(*), coalesce(sum(amount), 0) INTO in_n, in_total
    FROM public.partner_receipts WHERE status = 'issued' AND received_on BETWEEN f AND t;
  SELECT count(*) INTO v_voided FROM public.partner_receipts WHERE status = 'voided' AND received_on BETWEEN f AND t;
  SELECT count(*) INTO v_cash FROM public.partner_receipts
   WHERE status = 'issued' AND payment_method = 'cash' AND cash_confirmed_by IS NULL AND received_on BETWEEN f AND t;
  SELECT count(*) INTO v_corr FROM public.partner_receipt_corrections WHERE status = 'pending';

  IF v_out THEN
    SELECT count(*), coalesce(sum(amount), 0) INTO out_n, out_total
      FROM public.withdrawal_requests
     WHERE receipt_token IS NOT NULL AND status = 'completed'
       AND (coalesce(processed_at, created_at) AT TIME ZONE 'Africa/Kampala')::date BETWEEN f AND t;
  END IF;

  RETURN jsonb_build_object(
    'from', f, 'to', t,
    'issued_count', in_n + out_n,
    'in_count', in_n, 'in_total', in_total,
    'out_count', out_n, 'out_total', out_total,
    'voided_count', v_voided,
    'pending_corrections', v_corr,
    'pending_cash_confirmations', v_cash,
    'pending_count', v_corr + v_cash,
    'can_see_payouts', v_out
  );
END $$;

-- New functions are closed by default: the browser needs an explicit grant, and the functions check the caller themselves.
REVOKE ALL ON FUNCTION public.receipt_phone_key(text), public.search_receipt_archive(text,text,date,date,text,text,text,integer,integer),
  public.receipt_archive_summary(date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receipt_phone_key(text), public.search_receipt_archive(text,text,date,date,text,text,text,integer,integer),
  public.receipt_archive_summary(date,date) TO authenticated, service_role;
