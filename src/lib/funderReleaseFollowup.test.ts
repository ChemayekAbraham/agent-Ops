import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const notices = read('supabase/migrations/20261116110000_funder_release_landlord_sms_agent_whatsapp.sql');
const cover = read('supabase/migrations/20261115130100_welile_cover_revenue.sql');
const status = read('supabase/migrations/20261115130200_fundable_status_includes_agent_verified.sql');
const sender = read('supabase/functions/notify-funder-release-sms/index.ts');
const dashboard = read('src/pages/FunderDashboardNew.tsx');
const sheet = read('src/components/partner/SelfPortfolioPlanDetailSheet.tsx');

const landlordSms = 'WELILE: UGX ';
const zoe = 'this is Zoe from Welile.';

describe('funder release follow-up', () => {
  it('queues landlord SMS on funder_release_sms and never names the funder', () => {
    expect(notices).toContain(landlordSms);
    expect(notices).toContain('is with your Welile agent');
    expect(notices).toContain('Keep your phone on.');
    expect(notices).toContain("VALUES (p_rent_request_id, 'landlord', 'sms', v_landlord_phone, v_msg)");
    expect(notices).toContain("audience = 'legacy_tenant'");
    expect(notices).toContain('funder_release_sms_request_phone_key');
    expect(notices).toContain("WHERE audience <> 'legacy_tenant'");
    expect(notices).not.toMatch(/partner_float_landlord_notices'\s*\)/);
    expect(notices).not.toMatch(/\u2014/);
  });

  it('queues one Zoe WhatsApp per plan with an SMS fallback and a masked log', () => {
    expect(notices).toContain(zoe);
    expect(notices).toContain("'agent', 'whatsapp'");
    expect(notices).toContain('fallback_message');
    expect(notices).toContain('_funder_release_mask_phone');
    expect(notices).toContain("CHECK (channel IN ('email', 'in_app', 'sms', 'whatsapp'))");
    expect(sender).toContain('zoe_agent_landlord_float');
    expect(sender).toContain('meta_delivery_unknown');
    expect(sender).toContain('maskPhone');
    expect(notices).not.toMatch(/\u2014/);
  });

  it('books kept Welile Cover as R1 revenue and still pays a proxy agent the same wallet credit', () => {
    expect(cover).toContain("'category', 'welile_cover_fee', 'ledger_scope', 'platform'");
    expect(cover).toContain("'R1', 'cash_out'");
    expect(cover).toContain("'Welile Cover'");
    expect(cover).toContain("THEN 'partner_commission' ELSE 'agent_commission'");
    expect(cover).not.toContain('agent_commission_earned');
    expect(cover).not.toMatch(/\u2014/);
  });

  it('includes agent_verified when a released plan is marked funded', () => {
    expect(status).toContain("'agent_verified'");
    expect(status).toContain('psm_disburse_landlord_float');
    expect(status).toContain('_co_support_disburse_landlord_float');
  });

  it('checks funder_float_available and opens the fund chooser before the Welile review', () => {
    expect(dashboard).toContain('useFunderFloatAvailable');
    expect(dashboard).not.toContain('wallet.withdrawable');
    expect(dashboard).toContain('fundChoice.ask');
    expect(sheet).toContain('onClick={() => onFund(plan)}');
    expect(sheet).not.toContain('setReviewOpen');
    expect(sheet).not.toContain('FunderFundChooser');
  });
});
