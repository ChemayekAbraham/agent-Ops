-- PENDING, NOT APPLIED. Separate CFO approval required. Production data change (one asset row + one history row).
-- Issues the asset tag WEL-ICT-HQ-001 to the one asset registered before the asset-tag migration:
--   WEL-AST-000001 (IT equipment, location "Entebbe Head Office") -> site Entebbe Head Office (HQ), tag WEL-ICT-HQ-001.
-- Prerequisite: supabase/migrations/20261027150000_asset_register_asset_tags.sql applied.
-- The approving CFO's user id is recorded as the actor of the history entry; set it in the same transaction first:
--   BEGIN;
--   SET LOCAL asset_register.backfill_actor = '<cfo user uuid>';
--   \i this file
--   COMMIT;
-- Refuses, changing nothing, unless the asset is exactly as reviewed on 2026-10-27 and still untagged. The identity
-- trigger only accepts the tag computed from the asset's own category, site and code, so no other value can be set.
-- Not ledger, wallet or payment related.

SET lock_timeout = '5s';
DO $backfill$
DECLARE
  v_actor uuid := NULLIF(current_setting('asset_register.backfill_actor', true), '')::uuid;
  a public.assets%ROWTYPE;
  b public.assets%ROWTYPE;
BEGIN
  IF to_regprocedure('public._asset_register_make_tag(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: the asset tag migration is not applied; nothing was changed';
  END IF;
  IF v_actor IS NULL OR NOT public._has_enabled_role(v_actor, ARRAY['cfo']) THEN
    RAISE EXCEPTION 'precondition failed: asset_register.backfill_actor must be an enabled CFO account; nothing was changed';
  END IF;
  SELECT * INTO b FROM public.assets WHERE asset_code = 'WEL-AST-000001' FOR UPDATE;
  IF NOT FOUND OR b.category <> 'it_equipment' OR b.location IS DISTINCT FROM 'Entebbe Head Office'
     OR b.asset_tag IS NOT NULL OR b.site_key IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: WEL-AST-000001 is missing, already tagged, or no longer matches the reviewed record; nothing was changed';
  END IF;
  IF public._asset_register_make_tag(b.category, 'entebbe_hq', b.asset_code) <> 'WEL-ICT-HQ-001' THEN
    RAISE EXCEPTION 'precondition failed: the computed tag is not WEL-ICT-HQ-001; nothing was changed';
  END IF;

  UPDATE public.assets
     SET site_key = 'entebbe_hq', asset_tag = 'WEL-ICT-HQ-001', updated_by = v_actor, updated_at = clock_timestamp()
   WHERE id = b.id
  RETURNING * INTO a;

  INSERT INTO public.asset_events (asset_id, event_type, changed_fields, old_values, new_values, reason, actor_id)
  VALUES (a.id, 'updated', ARRAY['site_key', 'asset_tag'],
          jsonb_build_object('site_key', NULL, 'asset_tag', NULL),
          jsonb_build_object('site_key', a.site_key, 'asset_tag', a.asset_tag),
          'Asset tag issued for an asset registered before tags existed (CFO-approved backfill)', v_actor);

  IF (SELECT count(*) FROM public.assets WHERE asset_tag = 'WEL-ICT-HQ-001') <> 1 THEN
    RAISE EXCEPTION 'post-check failed: WEL-ICT-HQ-001 is not on exactly one asset';
  END IF;
END
$backfill$;
RESET lock_timeout;
