-- Backfill for 20261110120000: requests stuck in Service Centre review that belong at
-- Agent Ops (tenant self-applications, and requests rerouted there with no Service Centre
-- manager) and that the Service Centre has not yet reviewed, go back to `pending`.
--
-- Applied 2026-11-10 to production for the two rows that pass the SC-2 checklist
-- (Nakasagga Juliet 4e661d25…, Orishaba Marvis 84e178cd…). The SC-2 guard
-- (trg_e32_sc2_status_guard) stays ON, so a row missing SC-2 items is refused here —
-- Obua Oscar (72b2b26f…, missing family size + LC1) was then moved separately on the
-- user's instruction ("move him anyway"), with the SC-2 guard switched off for that one
-- update and back on in the same transaction; the guard log records the missing items.
-- Re-running is safe: only rows that still qualify and pass SC-2 move.

with moved as (
  update public.rent_requests r
     set status = 'pending',
         service_center_manager_id = null,
         updated_at = now()
   where r.status = 'service_center_review'
     and r.service_center_reviewed_at is null
     and (coalesce(r.tenant_self_applied, false) or r.service_center_manager_id is null)
     and cardinality(public._sc2_missing(r.id)) = 0
  returning r.id, r.tenant_self_applied
)
insert into public.pipeline_guard_log(rent_request_id, from_status, asked_status, final_status, outcome, rule, actor_id, actor_staff_ref)
select m.id, 'service_center_review', 'pending', 'pending', 'rerouted',
       case when coalesce(m.tenant_self_applied, false)
            then 'E58-fix backfill: self-applied tenant moved to Agent Ops'
            else 'E58-fix backfill: no Service Centre manager, moved to Agent Ops' end,
       null, null
from moved m;
