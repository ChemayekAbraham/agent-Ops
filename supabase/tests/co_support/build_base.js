// Appends the live (md5-checked) bodies + the original view to stub_base.sql -> base.sql
const fs = require('fs'), path = require('path');
const S = __dirname;
const MIG = 'C:/Users/USER/Documents/projects/lovable/welilereceipts-com-98bba33b/.claude/worktrees/selftopup/supabase/migrations';
const rd = (f) => fs.readFileSync(path.join(S, f), 'utf8');
const fn = (header, file) => `${header}\nAS $function$${rd(file)}$function$;\n\n`;

let out = rd('stub_base.sql') + '\n';
const ben = fs.readFileSync(path.join(MIG, '20261114120000_funder_direct_release_to_agent_float.sql'), 'utf8').replace(/\r\n/g, '\n');
const vStart = ben.indexOf('CREATE OR REPLACE VIEW public.v_partner_self_fundable_plans AS');
const vEnd = ben.indexOf('IS NOT NULL;', ben.indexOf('COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL;', vStart)) + 'IS NOT NULL;'.length;
out += ben.slice(vStart, vEnd) + '\n\n';
// production carries this comment (set by the same live migration)
out += "COMMENT ON VIEW public.v_partner_self_fundable_plans IS\n  'Rent Plans a partner may fund. Plans with no assigned agent are excluded.';\n\n";

out += fn(`CREATE FUNCTION public.psm_activate_line_on_disbursement() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'`, 'activate_body.sql');
out += `CREATE TRIGGER trg_psm_activate_line AFTER UPDATE OF disbursed_at, funded_at ON public.rent_requests FOR EACH ROW EXECUTE FUNCTION public.psm_activate_line_on_disbursement();\n\n`;
out += fn(`CREATE FUNCTION public.psm_disburse_landlord_float(p_commitment_id uuid, p_topup_id uuid DEFAULT NULL::uuid, p_rent_request_ids uuid[] DEFAULT NULL::uuid[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'`, 'disburse_body.sql');
out += fn(`CREATE FUNCTION public._approve_pending_portfolio_core(p_portfolio_id uuid, p_actor uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'`, 'live__approve_pending_portfolio_core.sql');
out += fn(`CREATE FUNCTION public.psm_release_cancelled_idempotency(p_partner uuid, p_key text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'`, 'live_psm_release_cancelled_idempotency.sql');
out += fn(`CREATE FUNCTION public.psm_confirm_commitment_for(p_partner uuid, p_rent_request_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text, p_actor uuid DEFAULT NULL::uuid, p_promissory_note_id uuid DEFAULT NULL::uuid, p_funding_mode text DEFAULT 'float'::text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'`, 'live_psm_confirm_commitment_for.sql');
out += fn(`CREATE FUNCTION public.funder_support_tenant_direct(p_rent_request_ids uuid[], p_promised_deposit_date date DEFAULT NULL::date, p_term_months integer DEFAULT 1) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'`, 'live_funder_support_tenant_direct.sql');
out += fn(`CREATE FUNCTION public.psm_release_self_funding_line(p_line_id uuid, p_reason text DEFAULT 'Self-support funding cancelled — plan released back to ready to fund'::text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'`, 'live_psm_release_self_funding_line.sql');
out += fn(`CREATE FUNCTION public.psm_release_plan_on_line_cancel() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'`, 'live_psm_release_plan_on_line_cancel.sql');
out += `CREATE TRIGGER trg_psm_release_plan_on_line_cancel AFTER UPDATE OF status ON public.partner_self_funding_lines FOR EACH ROW EXECUTE FUNCTION public.psm_release_plan_on_line_cancel();\n\n`;
fs.writeFileSync(path.join(S, 'base.sql'), out);
console.log('base.sql', out.length);
