-- 1) Release one self-support funding line's plan back to the fundable pool.
CREATE OR REPLACE FUNCTION public.psm_release_self_funding_line(p_line_id uuid, p_reason text DEFAULT 'Self-support funding cancelled — plan released back to ready to fund')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_line   public.partner_self_funding_lines%ROWTYPE;
  v_rr     public.rent_requests%ROWTYPE;
  v_alloc  public.agent_landlord_float_allocations%ROWTYPE;
  v_group  uuid;
  v_reversed numeric := 0;
BEGIN
  SELECT * INTO v_line FROM public.partner_self_funding_lines WHERE id = p_line_id FOR UPDATE;
  IF v_line.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Funding line not found.');
  END IF;
  IF v_line.rent_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Funding line has no rent plan.');
  END IF;

  SELECT * INTO v_rr FROM public.rent_requests WHERE id = v_line.rent_request_id FOR UPDATE;
  IF v_rr.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent plan not found.');
  END IF;

  -- Never release a plan whose landlord money has already left the agent's float.
  IF EXISTS (
    SELECT 1 FROM public.agent_landlord_float_allocations
     WHERE rent_request_id = v_rr.id
       AND source = 'partner_self_funding'
       AND COALESCE(paid_out_amount, 0) > 0
  ) THEN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (v_line.partner_id, 'psm_release_skipped_paid_out', 'rent_requests', v_rr.id::text,
            'Self-support release skipped: landlord already partly paid from float',
            jsonb_build_object('line_id', v_line.id, 'partner_id', v_line.partner_id));
    RETURN jsonb_build_object('success', false, 'error', 'Landlord already paid from float — release blocked.');
  END IF;

  -- Return unspent float to the company and reverse the disbursement legs.
  FOR v_alloc IN
    SELECT * FROM public.agent_landlord_float_allocations
     WHERE rent_request_id = v_rr.id
       AND source = 'partner_self_funding'
       AND status IN ('open','partially_paid','return_pending')
     FOR UPDATE
  LOOP
    IF COALESCE(v_alloc.remaining_amount, 0) > 0 THEN
      SELECT public.create_ledger_transaction(entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_alloc.agent_id, 'amount', v_alloc.remaining_amount, 'direction', 'cash_in',
          'category', 'rent_disbursement', 'ledger_scope', 'platform', 'classification', 'production',
          'currency', 'UGX', 'source_table', 'rent_requests', 'source_id', v_rr.id,
          'linked_party', v_alloc.landlord_id,
          'description', format('Self-support cancellation — float returned for %s (float_usage=self_portfolio_funding reversal)', COALESCE(v_alloc.landlord_name,'landlord')),
          'transaction_date', now()
        ),
        jsonb_build_object(
          'user_id', v_alloc.agent_id, 'amount', v_alloc.remaining_amount, 'direction', 'cash_out',
          'category', 'rent_receivable_created', 'ledger_scope', 'bridge', 'classification', 'production',
          'currency', 'UGX', 'source_table', 'rent_requests', 'source_id', v_rr.id,
          'linked_party', v_alloc.landlord_id,
          'description', format('Reversal — self-support funding cancelled (%s)', COALESCE(v_alloc.landlord_name,'landlord')),
          'transaction_date', now()
        )
      )) INTO v_group;

      UPDATE public.agent_landlord_float
         SET balance = GREATEST(0, COALESCE(balance,0) - v_alloc.remaining_amount),
             total_funded = GREATEST(0, COALESCE(total_funded,0) - v_alloc.remaining_amount),
             updated_at = now()
       WHERE agent_id = v_alloc.agent_id;

      v_reversed := v_reversed + v_alloc.remaining_amount;
    END IF;

    UPDATE public.agent_landlord_float_allocations
       SET status = 'cancelled',
           notes = COALESCE(notes,'') || ' | Self-support funding cancelled — released back to ready to fund',
           updated_at = now()
     WHERE id = v_alloc.id;
  END LOOP;

  -- Put the plan back in the fundable pool.
  UPDATE public.rent_requests
     SET status = CASE
                    WHEN status IN ('funded','disbursed')
                      THEN CASE WHEN coo_reviewed_at IS NOT NULL THEN 'coo_approved' ELSE 'approved' END
                    ELSE status
                  END,
         funded_at = NULL,
         disbursed_at = NULL,
         self_funding_partner_id = NULL,
         self_funding_line_id = NULL,
         fund_recipient_type = NULL,
         fund_recipient_id = NULL,
         fund_recipient_name = NULL,
         fund_routed_at = NULL,
         funder_visible = true,
         updated_at = now()
   WHERE id = v_rr.id;

  -- Free any hold so another partner (or the same one) can claim it again.
  UPDATE public.partner_self_plan_claims
     SET status = 'released', closed_at = now(), updated_at = now()
   WHERE rent_request_id = v_rr.id
     AND status IN ('held','confirmed');

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_line.partner_id, 'psm_release_self_funding_line', 'rent_requests', v_rr.id::text,
          COALESCE(NULLIF(btrim(p_reason),''), 'Self-support funding cancelled — plan released back to ready to fund'),
          jsonb_build_object('line_id', v_line.id, 'commitment_id', v_line.commitment_id,
                             'partner_id', v_line.partner_id, 'float_returned', v_reversed));

  RETURN jsonb_build_object('success', true, 'rent_request_id', v_rr.id, 'float_returned', v_reversed);
END;
$$;

REVOKE ALL ON FUNCTION public.psm_release_self_funding_line(uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.psm_release_self_funding_line(uuid, text) TO service_role;

-- 2) Cancelling a line now always releases its plan (no more orphans).
CREATE OR REPLACE FUNCTION public.psm_release_plan_on_line_cancel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'cancelled' AND COALESCE(OLD.status,'') <> 'cancelled' AND NEW.rent_request_id IS NOT NULL THEN
    PERFORM public.psm_release_self_funding_line(NEW.id, 'Self-support funding line cancelled — plan auto-released');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_psm_release_plan_on_line_cancel ON public.partner_self_funding_lines;
CREATE TRIGGER trg_psm_release_plan_on_line_cancel
AFTER UPDATE OF status ON public.partner_self_funding_lines
FOR EACH ROW EXECUTE FUNCTION public.psm_release_plan_on_line_cancel();

-- 3) Sweep existing orphans (cancelled line/commitment but plan still stamped).
CREATE OR REPLACE FUNCTION public.psm_release_orphaned_self_funding(p_partner_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec record;
  v_res jsonb;
  v_out jsonb := '[]'::jsonb;
BEGIN
  FOR v_rec IN
    SELECT l.id AS line_id, l.rent_request_id
      FROM public.partner_self_funding_lines l
      JOIN public.partner_self_commitments c ON c.id = l.commitment_id
      JOIN public.rent_requests rr ON rr.id = l.rent_request_id
     WHERE (p_partner_id IS NULL OR l.partner_id = p_partner_id)
       AND (l.status = 'cancelled' OR c.status = 'cancelled')
       AND rr.self_funding_partner_id = l.partner_id
       AND NOT EXISTS (
         SELECT 1 FROM public.partner_self_funding_lines l2
           JOIN public.partner_self_commitments c2 ON c2.id = l2.commitment_id
          WHERE l2.rent_request_id = l.rent_request_id
            AND l2.status <> 'cancelled' AND c2.status <> 'cancelled'
       )
  LOOP
    v_res := public.psm_release_self_funding_line(v_rec.line_id, 'Orphan repair — cancelled self-support portfolio still stamped on plan');
    v_out := v_out || jsonb_build_array(v_res || jsonb_build_object('line_id', v_rec.line_id));
  END LOOP;

  RETURN jsonb_build_object('success', true, 'released', v_out);
END;
$$;

REVOKE ALL ON FUNCTION public.psm_release_orphaned_self_funding(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.psm_release_orphaned_self_funding(uuid) TO service_role;

-- 4) Read-side guard: a cancelled self-support plan is not "self funded" any more.
CREATE OR REPLACE FUNCTION public.funder_supported_tenants()
 RETURNS TABLE(rent_request_id uuid, tenant_id uuid, tenant_name text, tenant_avatar_url text, tenant_phone text, tenant_address text, city text, house_category text, rent_amount numeric, duration_days integer, status text, funded_at timestamp with time zone, created_at timestamp with time zone, funding_mode text, house_image_urls text[], landlord_name text, landlord_phone text, daily_repayment numeric, total_repayment numeric, amount_repaid numeric, village text, district text, listing_address text, agent_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT rr.id,
         rr.tenant_id,
         COALESCE(p.full_name, 'Tenant'),
         COALESCE(p.avatar_url, rr.tenant_photo_url),
         p.phone,
         NULLIF(btrim(concat_ws(', ',
           NULLIF(p.village,''), NULLIF(p.parish,''), NULLIF(p.sub_county,''),
           NULLIF(p.district,''), NULLIF(COALESCE(p.city, rr.request_city),'')
         )), ''),
         COALESCE(rr.request_city, p.city),
         rr.house_category,
         rr.rent_amount,
         rr.duration_days,
         rr.status,
         rr.funded_at,
         rr.created_at,
         CASE WHEN rr.self_funding_partner_id = auth.uid() THEN 'self_managed' ELSE 'managed' END,
         COALESCE(NULLIF(rr.house_image_urls, '{}'), hl.image_urls),
         COALESCE(NULLIF(lp.full_name,''), NULLIF(ll.name,''), NULLIF(hll.name,''), NULLIF(hlp.full_name,'')),
         COALESCE(NULLIF(lp.phone,''), NULLIF(ll.phone,''), NULLIF(hll.phone,''), NULLIF(hlp.phone,'')),
         rr.daily_repayment,
         rr.total_repayment,
         rr.amount_repaid,
         COALESCE(NULLIF(hl.village,''), NULLIF(p.village,'')),
         COALESCE(NULLIF(hl.district,''), NULLIF(p.district,'')),
         NULLIF(hl.address,''),
         ap.full_name
  FROM public.rent_requests rr
  LEFT JOIN public.profiles p ON p.id = rr.tenant_id
  LEFT JOIN public.house_listings hl ON hl.id = rr.house_listing_id
  LEFT JOIN public.profiles lp ON lp.id = rr.landlord_id
  LEFT JOIN public.landlords ll ON ll.id = rr.landlord_id
  LEFT JOIN public.landlords hll ON hll.id = hl.landlord_id
  LEFT JOIN public.profiles hlp ON hlp.id = hl.landlord_id
  LEFT JOIN public.profiles ap ON ap.id = rr.agent_id
  WHERE auth.uid() IS NOT NULL
    AND (rr.supporter_id = auth.uid() OR rr.self_funding_partner_id = auth.uid())
    -- Hide plans whose self-support funding was cancelled (orphaned stamp).
    AND NOT (
      rr.self_funding_partner_id = auth.uid()
      AND EXISTS (
        SELECT 1 FROM public.partner_self_funding_lines l
          JOIN public.partner_self_commitments c ON c.id = l.commitment_id
         WHERE l.rent_request_id = rr.id AND l.partner_id = auth.uid()
           AND (l.status = 'cancelled' OR c.status = 'cancelled')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.partner_self_funding_lines l2
          JOIN public.partner_self_commitments c2 ON c2.id = l2.commitment_id
         WHERE l2.rent_request_id = rr.id AND l2.partner_id = auth.uid()
           AND l2.status <> 'cancelled' AND c2.status <> 'cancelled'
      )
    )
  ORDER BY COALESCE(rr.funded_at, rr.created_at) DESC;
$function$;
