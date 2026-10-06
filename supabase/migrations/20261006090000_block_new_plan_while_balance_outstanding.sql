-- Block a new Rent Plan or renewal while the tenant still owes on a live one,
-- and say what they owe.
--
-- `enforce_no_duplicate_rent_request` already blocked a second request, but
-- only one created within the last 14 days, and only told the caller an id and
-- a status. Two consequences:
--
--   * A tenant whose live plan is older than 14 days could be given a brand
--     new plan while still repaying the first. Measured over the last 60 days,
--     42 requests were created for a tenant who already had a live plan with
--     money outstanding - 38 of them renewals, which is exactly the path
--     agents use.
--   * The agent saw "Duplicate rent request blocked: tenant already has an
--     open request <uuid> (status=repaying, created=...)", which does not tell
--     them what the tenant owes, so they cannot act on it or explain it.
--
-- The live-plan check below has no age limit: a plan that is `funded` or
-- `repaying`, whose tenancy has not ended, with any balance left, blocks a new
-- one however long ago it started. The message names the rent financed, the
-- total repayable and the balance still outstanding. 844 tenants currently
-- hold such a plan.
--
-- The original 14-day rule is kept underneath it, unchanged, for requests
-- still in the pipeline (`pending`, ops-approved) where nothing has been
-- disbursed and no balance exists yet. Those legitimately age out.
--
-- Carve-out: `registration_type = 'outstanding_balance'` is ops registering
-- debt that already exists rather than advancing new rent, so it is exempt. No
-- such row was created against a live plan in the measured window; the exempt
-- is there so a data-correction path cannot be blocked by this rule.
--
-- ERRCODE stays `unique_violation`, matching the existing rule, so any caller
-- already branching on it keeps working. Every creation path - the agent's
-- renewal insert, the tenant's own request, and `renew_rent_request` - inserts
-- into this table, so the trigger covers all of them.

create or replace function public.enforce_no_duplicate_rent_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
DECLARE
  v_existing_id uuid;
  v_existing_status text;
  v_existing_created timestamptz;
  v_active_id uuid;
  v_active_rent numeric;
  v_active_total numeric;
  v_active_outstanding numeric;
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.status IN ('rejected','deleted_by_agent','completed','cancelled') THEN
    RETURN NEW;
  END IF;

  -- Registering pre-existing debt is a correction, not a new advance.
  IF COALESCE(NEW.registration_type,'') = 'outstanding_balance' THEN
    RETURN NEW;
  END IF;

  -- A live plan with money still owed blocks a new plan or renewal outright,
  -- however old it is.
  SELECT id,
         COALESCE(rent_amount,0),
         COALESCE(total_repayment,0),
         GREATEST(COALESCE(total_repayment,0) - COALESCE(amount_repaid,0), 0)
    INTO v_active_id, v_active_rent, v_active_total, v_active_outstanding
  FROM public.rent_requests
  WHERE tenant_id = NEW.tenant_id
    AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND status IN ('funded','repaying')
    AND COALESCE(tenancy_status,'active') <> 'ended'
    AND COALESCE(schedule_status,'') <> 'cancelled'
    AND GREATEST(COALESCE(total_repayment,0) - COALESCE(amount_repaid,0), 0) > 0
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_active_id IS NOT NULL THEN
    RAISE EXCEPTION
      'This tenant already has an active Rent Plan: UGX % rent, UGX % total repayable, UGX % still outstanding. Clear the outstanding balance before posting a new Rent Plan or a renewal.',
      to_char(v_active_rent,        'FM999,999,999'),
      to_char(v_active_total,       'FM999,999,999'),
      to_char(v_active_outstanding, 'FM999,999,999')
    USING ERRCODE = 'unique_violation';
  END IF;

  -- Unchanged: a request still in the pipeline, created recently, also blocks
  -- a second one. Nothing is disbursed at this stage, so there is no balance
  -- to quote and the 14-day window still applies.
  SELECT id, status, created_at
    INTO v_existing_id, v_existing_status, v_existing_created
  FROM public.rent_requests
  WHERE tenant_id = NEW.tenant_id
    AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND status IN ('pending','tenant_ops_approved','agent_ops_approved','funded','repaying')
    AND COALESCE(schedule_status,'') <> 'cancelled'
    AND created_at >= now() - interval '14 days'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Duplicate rent request blocked: tenant already has an open request % (status=%, created=%). Cancel or complete it before creating another.',
      v_existing_id, v_existing_status, v_existing_created
    USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;
