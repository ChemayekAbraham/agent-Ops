// Builds the co-support migration from template.sql + live-matching bodies taken
// from repo migrations (their md5 was checked against production prosrc).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const S = __dirname;
const MIG = 'C:/Users/USER/Documents/projects/lovable/welilereceipts-com-98bba33b/.claude/worktrees/selftopup/supabase/migrations';
const out = path.join(MIG, process.argv[2]);
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

let tpl = fs.readFileSync(path.join(S, 'template.sql'), 'utf8').replace(/\r\n/g, '\n');

// psm_disburse_landlord_float: live body (md5 9a5eef5b...) + co-support branch.
let body = fs.readFileSync(path.join(S, 'disburse_body.sql'), 'utf8');
if (md5(body) !== '9a5eef5bc74c5fdefa7c5872b787f456') throw new Error('disburse body does not match live');
const anchor = "  IF v_partner IS NULL THEN\n    RETURN jsonb_build_object('funded', 0, 'skipped', 0, 'reason', 'commitment_not_found');\n  END IF;\n";
if (body.split(anchor).length !== 2) throw new Error('disburse anchor not found exactly once');
const branch = anchor + `
  -- Co-support: two partners each fund half of one Rent Plan. The landlord
  -- float is released once, for the full rent, after both halves are paid.
  IF p_topup_id IS NULL AND EXISTS (
    SELECT 1 FROM public.partner_self_funding_lines l
     WHERE l.commitment_id = p_commitment_id AND l.co_support_id IS NOT NULL
  ) THEN
    RETURN public._co_support_disburse_landlord_float(p_commitment_id);
  END IF;
`;
body = body.replace(anchor, branch);
tpl = tpl.replace('@@DISBURSE_BODY@@', () => body);

// View: Benjamin's live definition (20261114120000, applied as ..._part*) + one condition.
const ben = fs.readFileSync(path.join(MIG, '20261114120000_funder_direct_release_to_agent_float.sql'), 'utf8').replace(/\r\n/g, '\n');
const vStart = ben.indexOf('CREATE OR REPLACE VIEW public.v_partner_self_fundable_plans AS');
const vEndMarker = '    AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL;';
const vEnd = ben.indexOf(vEndMarker, vStart);
if (vStart < 0 || vEnd < 0) throw new Error('view not found');
const view = ben.slice(vStart, vEnd) + '    AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL\n' +
  '    -- Co-support: a plan with an open 48-hour invitation is on nobody\'s list.\n' +
  "    AND NOT EXISTS (\n      SELECT 1 FROM public.co_support_invites ci\n       WHERE ci.rent_request_id = rr.id AND ci.status = 'open' AND ci.expires_at > now());\n\n" +
  "COMMENT ON VIEW public.v_partner_self_fundable_plans IS\n  'Rent Plans a partner may fund. Plans with no assigned agent, or with an open co-support invitation, are excluded.';";
tpl = tpl.replace('@@VIEW@@', () => view);

// psm_release_self_funding_line: live body (md5 aa58b06a...) + refuse one half of a pair.
const relOrig = fs.readFileSync(path.join(S, 'live_psm_release_self_funding_line.sql'), 'utf8');
if (md5(relOrig) !== 'aa58b06af90cb9ffac2716d17f4f4b88') throw new Error('release body does not match live');
const relAnchor = "  IF v_line.rent_request_id IS NULL THEN\n    RETURN jsonb_build_object('success', false, 'error', 'Funding line has no rent plan.');\n  END IF;\n";
if (relOrig.split(relAnchor).length !== 2) throw new Error('release anchor not found exactly once');
const relBody = relOrig.replace(relAnchor, relAnchor + `
  -- Co-support: a plan funded by two partners is released only once both
  -- halves are cancelled (psm_release_plan_on_line_cancel cancels the pair).
  IF v_line.co_support_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.partner_self_funding_lines l2
     WHERE l2.co_support_id = v_line.co_support_id AND l2.id <> v_line.id AND l2.status <> 'cancelled'
  ) THEN
    RETURN jsonb_build_object('success', false,
      'error', 'Co-supported Rent Plan: cancel both halves together (co_support_staff_cancel).');
  END IF;
`);
tpl = tpl.replace('@@RELEASE_BODY@@', () => relBody);

if (/@@[A-Z_]+@@/.test(tpl)) throw new Error('placeholder left');
fs.writeFileSync(out, tpl);
console.log('wrote', out, tpl.length, 'chars');

// Rollback: the same live bodies, unedited.
const orig = fs.readFileSync(path.join(S, 'disburse_body.sql'), 'utf8');
const act = fs.readFileSync(path.join(S, 'activate_body.sql'), 'utf8');
if (md5(act) !== 'ffd05d6396766746b6734d4e5bb5a914') throw new Error('activate body does not match live');
const viewOrig = ben.slice(vStart, vEnd) + vEndMarker;
let rb = fs.readFileSync(path.join(S, 'rollback_template.sql'), 'utf8').replace(/\r\n/g, '\n')
  .replace('@@DISBURSE_ORIG@@', () => orig)
  .replace('@@ACTIVATE_ORIG@@', () => act)
  .replace('@@VIEW_ORIG@@', () => viewOrig)
  .replace('@@RELEASE_ORIG@@', () => relOrig)
  .replace('@@TRIGGER_ORIG@@', () => {
    const t = fs.readFileSync(path.join(S, 'live_psm_release_plan_on_line_cancel.sql'), 'utf8');
    if (md5(t) !== '0af80a69952d5eba6ac25bab66242ed5') throw new Error('trigger body does not match live');
    return t;
  });
if (/@@[A-Z_]+@@/.test(rb)) throw new Error('rollback placeholder left');
const rbDir = path.join(MIG, '..', 'rollbacks');
fs.mkdirSync(rbDir, { recursive: true });
const rbOut = path.join(rbDir, process.argv[2].replace('.sql', '.rollback.sql'));
fs.writeFileSync(rbOut, rb);
console.log('wrote', rbOut, rb.length, 'chars');
