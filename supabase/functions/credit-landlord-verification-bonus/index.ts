// RETIRED — 25 September 2026. This function no longer pays anything.
//
// It credited the agent UGX 5,000 every time a rent request passed a pipeline
// desk that showed the landlord checklist. Three problems:
//
//   1. it was keyed on `rent_request_id`, not `landlord_id`, so the same
//      landlord paid a bonus once per rent request naming them;
//   2. its `create_ledger_transaction` call carried NO idempotency_key, so a
//      retry or a second desk approving paid again;
//   3. it never checked whether the landlord was new or already verified.
//
// Measured over its life (2026-04-10 → 2026-09-22): 1,177 ledger legs across
// 1,131 rent requests but only 723 distinct landlords — UGX 5,885,000 paid
// where 3,615,000 was due, and 154 landlords paid through this path AND the
// correct one.
//
// The landlord bonus is now paid once per NEW landlord by
// `pay_landlord_registration_verified_bonus`, a trigger on the
// `landlords.verified` false → true transition, guarded by
// `registration_verification_bonus_paid` and the idempotency key
// `landlord_reg_verify_v2:<landlord_id>`.
//
// The body is kept as a refusing stub rather than deleted: removing the source
// does not undeploy the function, and a stale caller should get a clear answer
// instead of an opaque failure. Both call sites in
// src/components/executive/RentPipelineQueue.tsx were removed in the same change.
//
// Spec: docs/rent-plan-new-flow-full-report.md §2, §7.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  console.warn('[credit-landlord-verification-bonus] retired endpoint called; nothing was paid')

  return new Response(
    JSON.stringify({
      success: false,
      retired: true,
      bonus_paid: 0,
      reason: 'landlord_bonus_moved_to_registration_trigger',
      message:
        'This endpoint is retired. The landlord bonus is paid once per new landlord when the landlord is verified, by pay_landlord_registration_verified_bonus. Nothing was credited by this call.',
    }),
    { status: 410, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  )
})
