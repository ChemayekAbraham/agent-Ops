-- =========================================================
-- 1. Tables
-- =========================================================
CREATE TABLE IF NOT EXISTS public.proxy_partner_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proxy_agent_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE DEFAULT upper(substr(encode(extensions.gen_random_bytes(6),'hex'),1,10)),
  invitee_name text,
  invitee_phone text,
  channel text NOT NULL DEFAULT 'link',
  target_path text NOT NULL DEFAULT '/funder-onboarding',
  share_count integer NOT NULL DEFAULT 1,
  last_shared_at timestamptz NOT NULL DEFAULT now(),
  clicked_at timestamptz,
  signed_up_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  signed_up_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ppi_agent ON public.proxy_partner_invites(proxy_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ppi_phone ON public.proxy_partner_invites(proxy_agent_id, invitee_phone);
CREATE INDEX IF NOT EXISTS idx_ppi_signup ON public.proxy_partner_invites(signed_up_user_id);

GRANT SELECT, INSERT, UPDATE ON public.proxy_partner_invites TO authenticated;
GRANT ALL ON public.proxy_partner_invites TO service_role;
ALTER TABLE public.proxy_partner_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ppi_select_own_or_ops" ON public.proxy_partner_invites
  FOR SELECT TO authenticated
  USING (
    proxy_agent_id = auth.uid()
    OR has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'ceo')
    OR has_role(auth.uid(),'coo') OR has_role(auth.uid(),'cfo')
    OR has_role(auth.uid(),'operations') OR has_role(auth.uid(),'manager')
    OR has_role(auth.uid(),'partner_ops') OR has_role(auth.uid(),'agent_ops')
  );

CREATE POLICY "ppi_insert_own" ON public.proxy_partner_invites
  FOR INSERT TO authenticated
  WITH CHECK (proxy_agent_id = auth.uid());

CREATE POLICY "ppi_update_own_or_ops" ON public.proxy_partner_invites
  FOR UPDATE TO authenticated
  USING (
    proxy_agent_id = auth.uid()
    OR has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'coo')
    OR has_role(auth.uid(),'operations') OR has_role(auth.uid(),'partner_ops')
  );

CREATE TABLE IF NOT EXISTS public.proxy_agent_targets (
  agent_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  monthly_partner_target integer NOT NULL DEFAULT 10 CHECK (monthly_partner_target > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.proxy_agent_targets TO authenticated;
GRANT ALL ON public.proxy_agent_targets TO service_role;
ALTER TABLE public.proxy_agent_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pat_select_own_or_ops" ON public.proxy_agent_targets
  FOR SELECT TO authenticated
  USING (
    agent_id = auth.uid()
    OR has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'ceo')
    OR has_role(auth.uid(),'coo') OR has_role(auth.uid(),'cfo')
    OR has_role(auth.uid(),'operations') OR has_role(auth.uid(),'manager')
    OR has_role(auth.uid(),'partner_ops') OR has_role(auth.uid(),'agent_ops')
  );

CREATE POLICY "pat_write_own_or_ops" ON public.proxy_agent_targets
  FOR INSERT TO authenticated
  WITH CHECK (
    agent_id = auth.uid()
    OR has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'coo')
    OR has_role(auth.uid(),'operations') OR has_role(auth.uid(),'partner_ops')
  );

CREATE POLICY "pat_update_own_or_ops" ON public.proxy_agent_targets
  FOR UPDATE TO authenticated
  USING (
    agent_id = auth.uid()
    OR has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'coo')
    OR has_role(auth.uid(),'operations') OR has_role(auth.uid(),'partner_ops')
  );

CREATE OR REPLACE FUNCTION public.touch_proxy_cc_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_ppi_touch ON public.proxy_partner_invites;
CREATE TRIGGER trg_ppi_touch BEFORE UPDATE ON public.proxy_partner_invites
  FOR EACH ROW EXECUTE FUNCTION public.touch_proxy_cc_updated_at();

DROP TRIGGER IF EXISTS trg_pat_touch ON public.proxy_agent_targets;
CREATE TRIGGER trg_pat_touch BEFORE UPDATE ON public.proxy_agent_targets
  FOR EACH ROW EXECUTE FUNCTION public.touch_proxy_cc_updated_at();

-- =========================================================
-- 2. Promissory note <-> partner linkage (data integrity)
-- =========================================================
-- On note insert: attach an existing partner account with the same phone.
CREATE OR REPLACE FUNCTION public.link_promissory_note_partner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid;
BEGIN
  IF NEW.partner_user_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT p.id INTO v_uid
  FROM profiles p
  WHERE normalize_phone_last9(p.phone) IS NOT NULL
    AND normalize_phone_last9(p.phone) IN (
      normalize_phone_last9(NEW.whatsapp_number),
      normalize_phone_last9(COALESCE(NEW.phone_number,''))
    )
  ORDER BY p.created_at
  LIMIT 1;
  IF v_uid IS NOT NULL THEN NEW.partner_user_id := v_uid; END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_link_promissory_note_partner ON public.promissory_notes;
CREATE TRIGGER trg_link_promissory_note_partner
  BEFORE INSERT ON public.promissory_notes
  FOR EACH ROW EXECUTE FUNCTION public.link_promissory_note_partner();

-- On partner signup / phone change: attach their unlinked notes and claim invites.
CREATE OR REPLACE FUNCTION public.link_proxy_records_on_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_last9 text := normalize_phone_last9(NEW.phone);
BEGIN
  IF v_last9 IS NULL THEN RETURN NEW; END IF;

  UPDATE promissory_notes n
     SET partner_user_id = NEW.id, updated_at = now()
   WHERE n.partner_user_id IS NULL
     AND v_last9 IN (
       normalize_phone_last9(n.whatsapp_number),
       normalize_phone_last9(COALESCE(n.phone_number,''))
     );

  IF NEW.referrer_id IS NOT NULL THEN
    UPDATE proxy_partner_invites i
       SET signed_up_user_id = NEW.id,
           signed_up_at = COALESCE(i.signed_up_at, now())
     WHERE i.signed_up_user_id IS NULL
       AND i.proxy_agent_id = NEW.referrer_id
       AND normalize_phone_last9(COALESCE(i.invitee_phone,'')) = v_last9;
  END IF;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_link_proxy_records_on_profile ON public.profiles;
CREATE TRIGGER trg_link_proxy_records_on_profile
  AFTER INSERT OR UPDATE OF phone, referrer_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.link_proxy_records_on_profile();

-- =========================================================
-- 3. Access gate + shared partner row source (DRY, single query)
-- =========================================================
CREATE OR REPLACE FUNCTION public.proxy_cc_resolve_agent(p_agent_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_target uuid := COALESCE(p_agent_id, auth.uid());
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_target <> v_uid AND NOT (
    has_role(v_uid,'super_admin') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
    OR has_role(v_uid,'cfo') OR has_role(v_uid,'operations') OR has_role(v_uid,'manager')
    OR has_role(v_uid,'partner_ops') OR has_role(v_uid,'agent_ops')
  ) THEN
    RAISE EXCEPTION 'Not authorised to view another proxy agent';
  END IF;
  RETURN v_target;
END; $$;

CREATE OR REPLACE FUNCTION public.proxy_agent_partner_rows(p_agent_id uuid)
RETURNS TABLE (
  partner_user_id uuid,
  partner_name text,
  partner_phone text,
  sources text[],
  linked_at timestamptz,
  portfolios integer,
  total_funded numeric,
  last_funded_at timestamptz,
  came_in boolean,
  is_returning boolean,
  notes_count integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH links AS (
    SELECT si.activated_user_id AS pid, 'invite'::text AS src, si.created_at AS at
      FROM supporter_invites si
     WHERE si.created_by = p_agent_id AND si.activated_user_id IS NOT NULL
    UNION ALL
    SELECT pa.beneficiary_id, 'proxy', pa.created_at
      FROM proxy_agent_assignments pa
     WHERE pa.agent_id = p_agent_id AND pa.beneficiary_role = 'supporter'
       AND pa.is_active AND pa.approval_status = 'approved'
    UNION ALL
    SELECT pr.id, 'referral', pr.created_at
      FROM profiles pr
     WHERE pr.referrer_id = p_agent_id
       AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = pr.id AND ur.role = 'supporter')
    UNION ALL
    SELECT ip.investor_id, 'portfolio', ip.created_at
      FROM investor_portfolios ip
     WHERE ip.agent_id = p_agent_id AND ip.investor_id IS NOT NULL
    UNION ALL
    SELECT pn.partner_user_id, 'note', pn.created_at
      FROM promissory_notes pn
     WHERE pn.agent_id = p_agent_id AND pn.partner_user_id IS NOT NULL
    UNION ALL
    SELECT i.signed_up_user_id, 'invite_link', i.created_at
      FROM proxy_partner_invites i
     WHERE i.proxy_agent_id = p_agent_id AND i.signed_up_user_id IS NOT NULL
  ), agg AS (
    SELECT pid, array_agg(DISTINCT src) AS sources, MIN(at) AS linked_at
      FROM links WHERE pid IS NOT NULL GROUP BY pid
  ), folio AS (
    SELECT ip.investor_id AS pid, COUNT(*)::int AS portfolios,
           COALESCE(SUM(ip.investment_amount),0) AS total_funded,
           MAX(ip.created_at) AS last_funded_at
      FROM investor_portfolios ip
     WHERE ip.investor_id IN (SELECT pid FROM agg)
     GROUP BY ip.investor_id
  ), notes AS (
    SELECT pn.partner_user_id AS pid, COUNT(*)::int AS notes_count
      FROM promissory_notes pn
     WHERE pn.agent_id = p_agent_id AND pn.partner_user_id IS NOT NULL
     GROUP BY pn.partner_user_id
  )
  SELECT a.pid,
         COALESCE(p.full_name,'Unknown partner'),
         NULLIF(p.phone,''),
         a.sources,
         a.linked_at,
         COALESCE(f.portfolios,0),
         COALESCE(f.total_funded,0),
         f.last_funded_at,
         COALESCE(f.portfolios,0) >= 1,
         COALESCE(f.portfolios,0) >= 2,
         COALESCE(n.notes_count,0)
    FROM agg a
    LEFT JOIN profiles p ON p.id = a.pid
    LEFT JOIN folio f ON f.pid = a.pid
    LEFT JOIN notes n ON n.pid = a.pid;
$$;

-- =========================================================
-- 4. Command center headline figures
-- =========================================================
CREATE OR REPLACE FUNCTION public.get_proxy_agent_command_center(p_agent_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_agent uuid := proxy_cc_resolve_agent(p_agent_id);
  v_now timestamptz := now();
  v_day_start timestamptz := date_trunc('day', v_now AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala';
  v_week_start timestamptz := date_trunc('week', v_now AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala';
  v_month_start timestamptz := date_trunc('month', v_now AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala';
  v_partners jsonb;
  v_notes jsonb;
  v_comm jsonb;
  v_rate numeric;
  v_pending_notes int := 0;
  v_target int;
  v_withdrawable numeric := 0;
  v_team int := 0;
  v_invites jsonb;
BEGIN
  SELECT jsonb_build_object(
           'onboarded', COUNT(*),
           'came_in', COUNT(*) FILTER (WHERE came_in),
           'returning', COUNT(*) FILTER (WHERE is_returning),
           'total_funded', COALESCE(SUM(total_funded),0),
           'today', COUNT(*) FILTER (WHERE linked_at >= v_day_start),
           'this_week', COUNT(*) FILTER (WHERE linked_at >= v_week_start),
           'this_month', COUNT(*) FILTER (WHERE linked_at >= v_month_start)
         ) INTO v_partners
    FROM proxy_agent_partner_rows(v_agent);

  SELECT jsonb_build_object(
           'total', COUNT(*),
           'pending', COUNT(*) FILTER (WHERE status = 'pending'),
           'activated', COUNT(*) FILTER (WHERE status = 'activated'),
           'rejected', COUNT(*) FILTER (WHERE status NOT IN ('pending','activated')),
           'linked_partners', COUNT(*) FILTER (WHERE partner_user_id IS NOT NULL),
           'total_amount', COALESCE(SUM(amount),0),
           'total_collected', COALESCE(SUM(total_collected),0)
         ),
         COUNT(*) FILTER (WHERE NOT approval_bonus_paid AND status = 'pending')
    INTO v_notes, v_pending_notes
    FROM promissory_notes WHERE agent_id = v_agent;

  SELECT jsonb_build_object(
           'two_percent', COALESCE(SUM(amount) FILTER (WHERE category IN ('proxy_investment_commission','agent_investment_commission')),0),
           'one_percent', COALESCE(SUM(amount) FILTER (WHERE category = 'partner_commission'),0),
           'note_rewards', COALESCE(SUM(amount) FILTER (WHERE category = 'agent_commission' AND source_table = 'promissory_notes'),0),
           'total', COALESCE(SUM(amount),0),
           'this_month', COALESCE(SUM(amount) FILTER (WHERE transaction_date >= v_month_start),0)
         ) INTO v_comm
    FROM general_ledger
   WHERE user_id = v_agent
     AND direction = 'cash_in'
     AND ledger_scope = 'wallet'
     AND classification <> 'admin_correction'
     AND (
       category IN ('proxy_investment_commission','agent_investment_commission','partner_commission')
       OR (category = 'agent_commission' AND source_table = 'promissory_notes')
     );

  v_rate := COALESCE(partner_note_rate('agent', v_now), 0);
  SELECT COALESCE(monthly_partner_target, 10) INTO v_target FROM proxy_agent_targets WHERE agent_id = v_agent;
  v_target := COALESCE(v_target, 10);

  BEGIN
    v_withdrawable := COALESCE(get_user_available_balance(v_agent), 0);
  EXCEPTION WHEN others THEN v_withdrawable := 0;
  END;

  SELECT COUNT(*)::int INTO v_team
    FROM partner_lead_assignments
   WHERE lead_user_id = v_agent AND detached_at IS NULL;

  SELECT jsonb_build_object(
           'shared', COUNT(*),
           'clicked', COUNT(*) FILTER (WHERE clicked_at IS NOT NULL),
           'converted', COUNT(*) FILTER (WHERE signed_up_user_id IS NOT NULL)
         ) INTO v_invites
    FROM proxy_partner_invites WHERE proxy_agent_id = v_agent;

  RETURN jsonb_build_object(
    'agent_id', v_agent,
    'generated_at', v_now,
    'partners', v_partners,
    'notes', v_notes,
    'commission', v_comm,
    'pending_commission', jsonb_build_object(
      'pending_notes', v_pending_notes,
      'rate_per_note', v_rate,
      'amount', v_pending_notes * v_rate
    ),
    'earnings', jsonb_build_object(
      'total', (v_comm->>'total')::numeric,
      'withdrawable', v_withdrawable
    ),
    'rates', jsonb_build_object(
      'investment_commission_pct', 2,
      'partner_deposit_commission_pct', 1,
      'note_reward', v_rate
    ),
    'targets', jsonb_build_object(
      'monthly_partner_target', v_target,
      'month_progress_pct', CASE WHEN v_target > 0
        THEN LEAST(100, ROUND(((v_partners->>'this_month')::numeric / v_target) * 100, 1)) ELSE 0 END
    ),
    'team_size', v_team,
    'invites', v_invites
  );
END; $$;

-- =========================================================
-- 5. Paginated lists
-- =========================================================
CREATE OR REPLACE FUNCTION public.list_proxy_agent_partners(
  p_agent_id uuid DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_filter text DEFAULT 'all',
  p_sort text DEFAULT 'linked_at',
  p_dir text DEFAULT 'desc',
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_agent uuid := proxy_cc_resolve_agent(p_agent_id);
  v_lim int := LEAST(GREATEST(COALESCE(p_limit,20),1),100);
  v_off int := GREATEST(COALESCE(p_offset,0),0);
  v_q text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_sort text := lower(COALESCE(p_sort,'linked_at'));
  v_asc boolean := lower(COALESCE(p_dir,'desc')) = 'asc';
  v_total int;
  v_rows jsonb;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _pcc_partners ON COMMIT DROP AS SELECT * FROM proxy_agent_partner_rows(NULL) WITH NO DATA;
  DELETE FROM _pcc_partners;
  INSERT INTO _pcc_partners SELECT * FROM proxy_agent_partner_rows(v_agent);

  WITH filtered AS (
    SELECT * FROM _pcc_partners r
    WHERE (v_q IS NULL OR r.partner_name ILIKE '%'||v_q||'%' OR COALESCE(r.partner_phone,'') ILIKE '%'||v_q||'%')
      AND (
        COALESCE(p_filter,'all') = 'all'
        OR (p_filter = 'came_in' AND r.came_in)
        OR (p_filter = 'returning' AND r.is_returning)
        OR (p_filter = 'not_yet' AND NOT r.came_in)
      )
  ), counted AS (SELECT COUNT(*)::int AS total FROM filtered),
  page AS (
    SELECT * FROM filtered
    ORDER BY
      CASE WHEN v_sort = 'name' AND v_asc THEN partner_name END ASC NULLS LAST,
      CASE WHEN v_sort = 'name' AND NOT v_asc THEN partner_name END DESC NULLS LAST,
      CASE WHEN v_sort = 'funded' AND v_asc THEN total_funded END ASC NULLS LAST,
      CASE WHEN v_sort = 'funded' AND NOT v_asc THEN total_funded END DESC NULLS LAST,
      CASE WHEN v_sort = 'portfolios' AND v_asc THEN portfolios END ASC NULLS LAST,
      CASE WHEN v_sort = 'portfolios' AND NOT v_asc THEN portfolios END DESC NULLS LAST,
      CASE WHEN v_sort NOT IN ('name','funded','portfolios') AND v_asc THEN linked_at END ASC NULLS LAST,
      CASE WHEN v_sort NOT IN ('name','funded','portfolios') AND NOT v_asc THEN linked_at END DESC NULLS LAST
    LIMIT v_lim OFFSET v_off
  )
  SELECT (SELECT total FROM counted),
         COALESCE(jsonb_agg(jsonb_build_object(
           'partner_user_id', partner_user_id,
           'partner_name', partner_name,
           'partner_phone', COALESCE(partner_phone,'—'),
           'sources', sources,
           'linked_at', linked_at,
           'portfolios', portfolios,
           'total_funded', total_funded,
           'last_funded_at', last_funded_at,
           'came_in', came_in,
           'is_returning', is_returning,
           'notes_count', notes_count
         )), '[]'::jsonb)
    INTO v_total, v_rows FROM page;

  RETURN jsonb_build_object('total', COALESCE(v_total,0), 'limit', v_lim, 'offset', v_off, 'rows', v_rows);
END; $$;

CREATE OR REPLACE FUNCTION public.list_proxy_agent_promissory_notes(
  p_agent_id uuid DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_status text DEFAULT 'all',
  p_sort text DEFAULT 'created_at',
  p_dir text DEFAULT 'desc',
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_agent uuid := proxy_cc_resolve_agent(p_agent_id);
  v_lim int := LEAST(GREATEST(COALESCE(p_limit,20),1),100);
  v_off int := GREATEST(COALESCE(p_offset,0),0);
  v_q text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_sort text := lower(COALESCE(p_sort,'created_at'));
  v_asc boolean := lower(COALESCE(p_dir,'desc')) = 'asc';
  v_total int; v_rows jsonb;
BEGIN
  WITH filtered AS (
    SELECT n.*, pp.full_name AS linked_partner_name, pp.phone AS linked_partner_phone,
           (SELECT COUNT(*) FROM investor_portfolios ip WHERE ip.investor_id = n.partner_user_id)::int AS partner_portfolios
      FROM promissory_notes n
      LEFT JOIN profiles pp ON pp.id = n.partner_user_id
     WHERE n.agent_id = v_agent
       AND (COALESCE(p_status,'all') = 'all' OR n.status = p_status)
       AND (v_q IS NULL OR n.partner_name ILIKE '%'||v_q||'%'
            OR n.whatsapp_number ILIKE '%'||v_q||'%'
            OR COALESCE(n.phone_number,'') ILIKE '%'||v_q||'%'
            OR COALESCE(pp.full_name,'') ILIKE '%'||v_q||'%')
  ), counted AS (SELECT COUNT(*)::int AS total FROM filtered),
  page AS (
    SELECT * FROM filtered
    ORDER BY
      CASE WHEN v_sort='amount' AND v_asc THEN amount END ASC NULLS LAST,
      CASE WHEN v_sort='amount' AND NOT v_asc THEN amount END DESC NULLS LAST,
      CASE WHEN v_sort='partner' AND v_asc THEN partner_name END ASC NULLS LAST,
      CASE WHEN v_sort='partner' AND NOT v_asc THEN partner_name END DESC NULLS LAST,
      CASE WHEN v_sort='status' AND v_asc THEN status END ASC NULLS LAST,
      CASE WHEN v_sort='status' AND NOT v_asc THEN status END DESC NULLS LAST,
      CASE WHEN v_sort NOT IN ('amount','partner','status') AND v_asc THEN created_at END ASC NULLS LAST,
      CASE WHEN v_sort NOT IN ('amount','partner','status') AND NOT v_asc THEN created_at END DESC NULLS LAST
    LIMIT v_lim OFFSET v_off
  )
  SELECT (SELECT total FROM counted),
         COALESCE(jsonb_agg(jsonb_build_object(
           'id', id,
           'partner_name', partner_name,
           'whatsapp_number', whatsapp_number,
           'phone_number', phone_number,
           'amount', amount,
           'contribution_type', contribution_type,
           'status', status,
           'total_collected', total_collected,
           'partner_user_id', partner_user_id,
           'linked_partner_name', linked_partner_name,
           'linked_partner_phone', linked_partner_phone,
           'partner_portfolios', partner_portfolios,
           'partner_came_in', partner_portfolios > 0,
           'approval_bonus_paid', approval_bonus_paid,
           'approved_at', approved_at,
           'created_at', created_at
         )), '[]'::jsonb)
    INTO v_total, v_rows FROM page;

  RETURN jsonb_build_object('total', COALESCE(v_total,0), 'limit', v_lim, 'offset', v_off, 'rows', v_rows);
END; $$;

-- =========================================================
-- 6. Team (sub-proxy network)
-- =========================================================
CREATE OR REPLACE FUNCTION public.get_proxy_agent_team(p_agent_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_agent uuid := proxy_cc_resolve_agent(p_agent_id); v_rows jsonb;
BEGIN
  WITH team AS (
    SELECT pla.agent_id, pla.attached_at, pla.reason
      FROM partner_lead_assignments pla
     WHERE pla.lead_user_id = v_agent AND pla.detached_at IS NULL
  ), notes AS (
    SELECT n.agent_id, COUNT(*)::int AS notes_total,
           COUNT(*) FILTER (WHERE n.status='pending')::int AS notes_pending,
           COUNT(*) FILTER (WHERE n.status='activated')::int AS notes_activated,
           COALESCE(SUM(n.amount),0) AS notes_amount
      FROM promissory_notes n
     WHERE n.agent_id IN (SELECT agent_id FROM team)
     GROUP BY n.agent_id
  ), folio AS (
    SELECT ip.agent_id, COUNT(*)::int AS partners_funded, COALESCE(SUM(ip.investment_amount),0) AS funded_amount
      FROM investor_portfolios ip
     WHERE ip.agent_id IN (SELECT agent_id FROM team)
     GROUP BY ip.agent_id
  ), earn AS (
    SELECT gl.user_id AS agent_id, COALESCE(SUM(gl.amount),0) AS earnings
      FROM general_ledger gl
     WHERE gl.user_id IN (SELECT agent_id FROM team)
       AND gl.direction='cash_in' AND gl.ledger_scope='wallet'
       AND gl.classification <> 'admin_correction'
       AND (gl.category IN ('proxy_investment_commission','agent_investment_commission','partner_commission')
            OR (gl.category='agent_commission' AND gl.source_table='promissory_notes'))
     GROUP BY gl.user_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_id', t.agent_id,
           'full_name', COALESCE(p.full_name,'Unknown'),
           'phone', COALESCE(NULLIF(p.phone,''),'—'),
           'attached_at', t.attached_at,
           'reason', t.reason,
           'notes_total', COALESCE(n.notes_total,0),
           'notes_pending', COALESCE(n.notes_pending,0),
           'notes_activated', COALESCE(n.notes_activated,0),
           'notes_amount', COALESCE(n.notes_amount,0),
           'partners_funded', COALESCE(f.partners_funded,0),
           'funded_amount', COALESCE(f.funded_amount,0),
           'earnings', COALESCE(e.earnings,0)
         ) ORDER BY t.attached_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM team t
    LEFT JOIN profiles p ON p.id = t.agent_id
    LEFT JOIN notes n ON n.agent_id = t.agent_id
    LEFT JOIN folio f ON f.agent_id = t.agent_id
    LEFT JOIN earn e ON e.agent_id = t.agent_id;

  RETURN jsonb_build_object('agent_id', v_agent, 'members', v_rows);
END; $$;

-- =========================================================
-- 7. Log an invite share
-- =========================================================
CREATE OR REPLACE FUNCTION public.log_proxy_partner_invite(
  p_channel text DEFAULT 'link',
  p_invitee_name text DEFAULT NULL,
  p_invitee_phone text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row proxy_partner_invites;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF p_invitee_phone IS NOT NULL AND normalize_phone_last9(p_invitee_phone) IS NOT NULL THEN
    UPDATE proxy_partner_invites
       SET share_count = share_count + 1, last_shared_at = now(),
           channel = COALESCE(p_channel, channel),
           invitee_name = COALESCE(NULLIF(btrim(COALESCE(p_invitee_name,'')),''), invitee_name)
     WHERE proxy_agent_id = v_uid
       AND normalize_phone_last9(COALESCE(invitee_phone,'')) = normalize_phone_last9(p_invitee_phone)
     RETURNING * INTO v_row;
  END IF;

  IF v_row.id IS NULL THEN
    INSERT INTO proxy_partner_invites (proxy_agent_id, invitee_name, invitee_phone, channel)
    VALUES (v_uid, NULLIF(btrim(COALESCE(p_invitee_name,'')),''), NULLIF(btrim(COALESCE(p_invitee_phone,'')),''), COALESCE(p_channel,'link'))
    RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'code', v_row.code,
    'share_count', v_row.share_count,
    'path', '/funder-onboarding?ref=' || v_uid::text || '&pi=' || v_row.code
  );
END; $$;

CREATE OR REPLACE FUNCTION public.set_proxy_agent_target(p_target int, p_agent_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_agent uuid := proxy_cc_resolve_agent(p_agent_id);
BEGIN
  IF p_target IS NULL OR p_target < 1 OR p_target > 1000 THEN
    RAISE EXCEPTION 'Target must be between 1 and 1000';
  END IF;
  INSERT INTO proxy_agent_targets (agent_id, monthly_partner_target)
  VALUES (v_agent, p_target)
  ON CONFLICT (agent_id) DO UPDATE SET monthly_partner_target = EXCLUDED.monthly_partner_target, updated_at = now();
  RETURN jsonb_build_object('agent_id', v_agent, 'monthly_partner_target', p_target);
END; $$;

-- =========================================================
-- 8. Grants
-- =========================================================
REVOKE ALL ON FUNCTION public.proxy_agent_partner_rows(uuid) FROM public;
REVOKE ALL ON FUNCTION public.proxy_cc_resolve_agent(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_proxy_agent_command_center(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_proxy_agent_partners(uuid,text,text,text,text,int,int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_proxy_agent_promissory_notes(uuid,text,text,text,text,int,int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_proxy_agent_team(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.log_proxy_partner_invite(text,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_proxy_agent_target(int,uuid) TO authenticated, service_role;