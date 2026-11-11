// Builds the Phase 4 (houses) migration + rollback from template_p4.sql and the
// live definitions pulled from production into p4/*.def.sql (md5-checked).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const S = __dirname;
const P4 = path.join(S, 'p4');
const MIG = 'C:/Users/USER/Documents/projects/lovable/welilereceipts-com-98bba33b/.claude/worktrees/selftopup/supabase/migrations';
const NAME = '20261115100000_co_support_phase4_houses.sql';
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const rd = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

// prosrc md5 of each live function (production, 2026-11-11)
const LIVE = {
  agent_list_empty_house_opportunities: 'a91b0e9955f3a392c521336ebe76bd50',
  reject_pending_portfolio: '7c70b99df0fdd7d8341ab86700a3d3e6',
  approve_pending_portfolio: 'b3ec5db2ae73d47ba16321a9ff8439d8',
  house_has_live_claim: 'c0d2bc3beb21625b59f6ad553faae048',
};
function liveDef(name) {
  const def = rd(path.join(P4, `${name}.def.sql`));
  const body = def.slice(def.indexOf('$function$') + 10, def.lastIndexOf('$function$'));
  if (md5(body) !== LIVE[name]) throw new Error(`${name}: body does not match production`);
  return def.trimEnd() + ';';
}
function patchOnce(text, anchor, replacement, what) {
  if (text.split(anchor).length !== 2) throw new Error(`${what}: anchor not found exactly once`);
  return text.replace(anchor, () => replacement);
}

// Feed: hide houses with an open co-support invitation.
const feedOrig = liveDef('agent_list_empty_house_opportunities');
const feedAnchor = "WHERE pa.house_id = h.id AND pa.status IN ('reserved','fulfilled'))\n";
const feed = patchOnce(feedOrig, feedAnchor, feedAnchor +
  "      -- Co-support: a house with an open 48-hour invitation is on nobody's list.\n" +
  "      AND NOT EXISTS (SELECT 1 FROM public.co_support_invites ci\n" +
  "                       WHERE ci.house_id = h.id AND ci.status = 'open' AND ci.expires_at > now())\n",
  'feed');

// Reject: a co-supported house is rejected as a pair.
const rejOrig = liveDef('reject_pending_portfolio');
let rej = patchOnce(rejOrig, '  v_pending public.funder_pending_portfolios%ROWTYPE;\nBEGIN\n',
  '  v_pending public.funder_pending_portfolios%ROWTYPE;\n  v_other uuid;\nBEGIN\n', 'reject declare');
rej = patchOnce(rej, "    jsonb_build_object('reason', btrim(p_reason), 'prev_status', v_status));\n\n  RETURN p_portfolio_id;\n",
  "    jsonb_build_object('reason', btrim(p_reason), 'prev_status', v_status));\n\n" +
  "  -- Co-support house: the other half is rejected too (both or neither).\n" +
  "  IF v_pending.id IS NOT NULL AND v_pending.source = 'self_managed_house' THEN\n" +
  "    FOR v_other IN SELECT x FROM public._co_support_pair_pending_portfolios(p_portfolio_id) x LOOP\n" +
  "      PERFORM public.reject_pending_portfolio(v_other, p_reason);\n" +
  "    END LOOP;\n" +
  "  END IF;\n\n  RETURN p_portfolio_id;\n", 'reject tail');

let tpl = rd(path.join(S, 'template_p4.sql'))
  .replace('@@FEED@@', () => '-- Funder feed: live body + one condition.\n' + feed)
  .replace('@@REJECT@@', () => '-- reject_pending_portfolio: live body + reject the other half.\n' + rej);
if (/@@[A-Z_]+@@/.test(tpl)) throw new Error('placeholder left');
fs.writeFileSync(path.join(MIG, NAME), tpl);
console.log('wrote', NAME, tpl.length);

// ---------------------------------------------------------------- rollback
// Phase 1 versions of the co-support functions this phase replaced.
const p1 = rd(path.join(MIG, '20261115090000_co_support_phase1.sql'));
function p1Fn(name) {
  const start = p1.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`phase 1 ${name} not found`);
  const end = p1.indexOf('\n$$;', start);
  if (end < 0) throw new Error(`phase 1 ${name} end not found`);
  return p1.slice(start, end + 4);
}
const replaced = ['_co_support_expire_stale', '_co_support_invite_json', 'co_support_preview', 'co_support_accept',
  'co_support_decline', 'co_support_cancel', 'co_support_reinvite', 'co_support_fund_alone',
  'co_support_staff_cancel', 'co_support_integrity_check'];
const rb = `-- Rollback for ${NAME}.
-- Puts back the live bodies of the four changed objects and the Phase 1
-- versions of the co-support functions; removes everything house-specific.
-- Refuses while any house invitation or co-supported house row exists.
SET client_encoding = 'UTF8';
SET lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.co_support_invites WHERE house_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.partner_supported_houses WHERE co_support_id IS NOT NULL) THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: co-supported houses exist';
  END IF;
END $$;

-- 1. Live bodies
${liveDef('house_has_live_claim')}

${feedOrig}

${liveDef('approve_pending_portfolio')}

${rejOrig}

-- 2. Phase 1 co-support functions
${replaced.map(p1Fn).join('\n\n')}

-- 3. House-only objects
DROP TRIGGER IF EXISTS trg_co_support_house_row_status ON public.partner_supported_houses;
DROP FUNCTION IF EXISTS public._co_support_house_row_status();
DROP TRIGGER IF EXISTS trg_psh_no_mixed_support ON public.partner_supported_houses;
DROP FUNCTION IF EXISTS public._psh_no_mixed_support();
DROP FUNCTION IF EXISTS public.co_support_create_house(uuid);
DROP FUNCTION IF EXISTS public.co_support_staff_list(integer);
DROP FUNCTION IF EXISTS public._co_support_pair_pending_portfolios(uuid);
DROP FUNCTION IF EXISTS public._co_support_open_house_half(uuid, uuid, numeric, numeric, text);
DROP FUNCTION IF EXISTS public._co_support_house_lead_checks(uuid, uuid);
DROP FUNCTION IF EXISTS public._co_support_house_problem(uuid);
DROP FUNCTION IF EXISTS public._co_support_require_partner_house(uuid);

-- 4. Supported-house rows back to one per house
DROP INDEX IF EXISTS public.ux_psh_house_live_co_support;
DROP INDEX IF EXISTS public.idx_psh_co_support;
DROP INDEX IF EXISTS public.ux_psh_house_live;
CREATE UNIQUE INDEX ux_psh_house_live ON public.partner_supported_houses USING btree (house_id) WHERE (status = ANY (ARRAY['pending'::text, 'active'::text]));
ALTER TABLE public.partner_supported_houses DROP COLUMN IF EXISTS co_support_id;

-- 5. Invitations back to Rent Plans only
ALTER TABLE public.co_support_invites DROP CONSTRAINT IF EXISTS co_support_invites_house_id_fkey;
DROP INDEX IF EXISTS public.ux_co_support_one_open_per_house;
ALTER TABLE public.co_support_invites DROP CONSTRAINT IF EXISTS co_support_one_target;
ALTER TABLE public.co_support_invites DROP COLUMN IF EXISTS house_id;
ALTER TABLE public.co_support_invites ALTER COLUMN rent_request_id SET NOT NULL;
`;
const rbDir = path.join(MIG, '..', 'rollbacks');
fs.writeFileSync(path.join(rbDir, NAME.replace('.sql', '.rollback.sql')), rb);
console.log('wrote rollback', rb.length);
