-- Empty-house support activation: hand off a pre-committed
-- partner_supported_houses row into the existing PSM landlord-float-bucket
-- machinery the moment the house actually gets a tenant.
--
-- Confirmed live before writing this (none of it visible from the repo
-- alone):
--   - partner_support_houses() lets a partner commit capital to a VERIFIED,
--     EMPTY house_listing (tenant_id IS NULL, status='available'), for
--     term_months up to 12. Principal = house_listings.monthly_rent at
--     commitment time.
--   - approve_pending_portfolio's 'self_managed_house' branch debits the
--     partner's wallet into their OWN operational float wallet
--     (wallet_bucket='float') and explicitly does NOT call
--     psm_disburse_landlord_float -- its own comment: "House support has no
--     tenant, so it never reaches this branch." The capital just sits as
--     the partner's own float from that point on. sync_supported_houses_on_
--     review then flips partner_supported_houses.status to 'active' --
--     that only means "ops approved the commitment," not "a tenant exists."
--   - accrue_partner_self_returns only ever reads partner_self_funding_lines
--     -- partner_supported_houses earns nothing today, confirming there is
--     no landlord float AND no returns accrual for house support until now.
--   - house_listings.tenant_id is set by exactly one function,
--     landlord_ops_bind_tenant_to_house(house_id, rent_request_id, reason)
--     -- a deliberate, role-gated (landlord_ops/manager) ops action, NOT an
--     automatic side effect of normal rent-request approval
--     (approve-rent-request never touches house_listings). This is the
--     right activation signal: a human confirms real occupancy before
--     partner capital gets released, mirroring how every other release
--     point in this system (landlord payout completion, ops-approved
--     withdrawal) is gated on a deliberate action, not an inferred one.
--
-- Design: on the house_listings.tenant_id NULL -> not-NULL transition, if
-- an 'active' partner_supported_houses row exists for that house with no
-- prior activation, resolve the real rent_request (house_listing_id match,
-- falling back to landlord_id+tenant_id match -- the same dual-lookup
-- pattern apply_landlord_payout_to_allocation already uses), move the
-- pre-committed capital out of the partner's own float wallet directly into
-- the agent's landlord-float bridge (one hop, since money already left the
-- partner's WITHDRAWABLE wallet once at commitment time -- this is not a
-- second debit), and create a partner_self_funding_lines row so the
-- ALREADY-BUILT bucket-recycle/principal-release trigger
-- (apply_landlord_payout_to_allocation) picks this up automatically from
-- here on, with zero new recycle logic needed.

alter table public.partner_supported_houses
  add column if not exists activated_line_id uuid references public.partner_self_funding_lines(id);

alter table public.partner_supported_houses
  add column if not exists tenant_activated_at timestamptz;

create or replace function public.activate_house_support_on_tenant_bound()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_house public.partner_supported_houses%rowtype;
  v_rent_request_id uuid;
  v_line_id uuid;
  v_ref text;
begin
  if NEW.tenant_id is null or OLD.tenant_id is not null then
    return NEW;
  end if;

  select * into v_house
    from public.partner_supported_houses
   where house_id = NEW.id
     and status = 'active'
     and activated_line_id is null
   order by created_at desc
   limit 1
   for update;

  if not found then
    return NEW;
  end if;

  select id into v_rent_request_id
    from public.rent_requests
   where house_listing_id = NEW.id
     and tenant_id = NEW.tenant_id
   order by created_at desc
   limit 1;

  if v_rent_request_id is null then
    select id into v_rent_request_id
      from public.rent_requests
     where landlord_id = NEW.landlord_id
       and tenant_id = NEW.tenant_id
     order by created_at desc
     limit 1;
  end if;

  if v_rent_request_id is null then
    -- No matching rent_request yet -- nothing to activate onto. Leaves
    -- activated_line_id null so a later rent_request/relink can still
    -- trigger this (e.g. if house_listing_id gets backfilled afterward
    -- and this trigger fires again on a subsequent tenant_id write).
    return NEW;
  end if;

  if exists (
    select 1 from public.agent_landlord_float_allocations
     where rent_request_id = v_rent_request_id
       and status in ('open','partially_paid')
  ) then
    return NEW;
  end if;

  insert into public.partner_self_funding_lines (
    commitment_id, partner_id, rent_request_id, principal, monthly_rate, term_months,
    status, live_at, cycles_disbursed
  ) values (
    v_house.commitment_id, v_house.partner_id, v_rent_request_id, v_house.principal,
    v_house.monthly_rate, v_house.term_months, 'active', now(), 1
  )
  returning id into v_line_id;

  update public.rent_requests
     set self_funding_partner_id = coalesce(self_funding_partner_id, v_house.partner_id),
         self_funding_line_id = coalesce(self_funding_line_id, v_line_id),
         updated_at = now()
   where id = v_rent_request_id;

  v_ref := 'PSH-' || upper(substr(replace(v_line_id::text, '-', ''), 1, 8));

  perform public.create_landlord_float_allocation(
    coalesce(NEW.agent_id, v_house.listing_agent_id), v_rent_request_id, v_house.principal, 'partner_self_funding'
  );

  -- One hop: the partner's capital already left their WITHDRAWABLE wallet
  -- once, at commitment approval time, into their own operational float.
  -- This is not a second debit -- it's releasing float already earmarked
  -- for this house into the agent's landlord-float bridge, now that a real
  -- tenant exists to disburse it to.
  perform public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_house.partner_id, 'amount', v_house.principal, 'direction', 'cash_out',
        'category', 'rent_disbursement', 'ledger_scope', 'wallet',
        'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
        'source_table', 'partner_self_funding_lines', 'source_id', v_line_id,
        'reference_id', v_ref,
        'description', 'House-support capital released to landlord float now that a tenant exists'
      ),
      jsonb_build_object(
        'user_id', coalesce(NEW.agent_id, v_house.listing_agent_id), 'amount', v_house.principal, 'direction', 'cash_in',
        'category', 'rent_receivable_created', 'ledger_scope', 'bridge',
        'source_table', 'partner_self_funding_lines', 'source_id', v_line_id,
        'reference_id', v_ref,
        'linked_party', v_house.partner_id::text,
        'description', 'Landlord float credited from pre-committed house support'
      )
    ),
    idempotency_key := 'psh-activate-' || v_house.id::text
  );

  update public.partner_supported_houses
     set activated_line_id = v_line_id, tenant_activated_at = now(), updated_at = now()
   where id = v_house.id;

  perform public.psm_audit(null, v_house.partner_id, 'house_support_activated',
    'partner_supported_houses', v_house.id,
    jsonb_build_object('rent_request_id', v_rent_request_id, 'line_id', v_line_id,
                       'principal', v_house.principal, 'term_months', v_house.term_months));

  return NEW;
end;
$fn$;

drop trigger if exists trg_activate_house_support_on_tenant_bound on public.house_listings;
create trigger trg_activate_house_support_on_tenant_bound
after update of tenant_id on public.house_listings
for each row execute function public.activate_house_support_on_tenant_bound();
