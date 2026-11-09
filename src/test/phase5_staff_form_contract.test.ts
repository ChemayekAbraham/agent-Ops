/**
 * Partner Returns Phase 5: the staff form contract (design v2 §6.1) in the handler code of the
 * forms that are too large to render in a unit test (COOPartnersPage, NewPartnersPanel,
 * CreateInvestmentAccountDialog, ActivePartnersDetail). The behaviour of the pieces is tested in
 * partnerRateHooks.test.tsx (useStaffPortfolioRate) and phase5_staff_*_dialog.test.tsx (rendered
 * dialogs); this pins that each form is wired to them.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

/** The create-portfolio-invite call of a form, from invoke( to the end of its body object. */
function inviteCall(code: string): string {
  const at = code.indexOf("invoke('create-portfolio-invite'");
  expect(at).toBeGreaterThan(-1);
  return code.slice(at, code.indexOf('});', at));
}

const createForms: { file: string; switchOffPrefill: string }[] = [
  { file: 'components/coo/COOPartnersPage.tsx', switchOffPrefill: "'20'" },
  { file: 'components/executive/NewPartnersPanel.tsx', switchOffPrefill: "'20'" },
  { file: 'components/manager/CreateInvestmentAccountDialog.tsx', switchOffPrefill: "'20'" },
  { file: 'components/partner/InvitePartnerPortfolioDialog.tsx', switchOffPrefill: "'15'" },
];

describe('staff create forms: useStaffPortfolioRate drives the rate field and the request', () => {
  for (const { file, switchOffPrefill } of createForms) {
    describe(file, () => {
      const code = src(file);

      it(`keeps today's switch-off prefill (${switchOffPrefill})`, () => {
        expect(code).toMatch(new RegExp(`useStaffPortfolioRate\\([^)]*, ${switchOffPrefill}\\)`));
      });

      it('sends the rate fields of the contract, never a raw rate', () => {
        const call = inviteCall(code);
        expect(call).toContain('...rateFields.fields');
        expect(call).not.toMatch(/roi_percentage\s*:/);
        expect(code).toMatch(/requestFields\(\)/);
        expect(code).toMatch(/'error' in rateFields/);
      });

      it('waits for its own policy read, and refuses an unedited rate when that read failed (O2)', () => {
        expect(code).toMatch(/staffRateSubmitBlock\((?:rate|addPortfolioRate)\)/);
        expect(code).toMatch(/if \(rateBlock\)/);
      });

      it('answers a 409 POLICY_CHANGED with the reload message and a policy refetch', () => {
        expect(code).toContain('isPolicyChangedError(');
        expect(code).toContain('POLICY_CHANGED_MESSAGE');
        expect(code).toContain('refetchPolicy()');
      });

      it('never invents a rate in the request', () => {
        for (const bad of [/\?\?\s*15\b/, /\|\|\s*15\b/, /\*\s*0\.15\b/, /\|\|\s*10\b/]) {
          expect(inviteCall(code)).not.toMatch(bad);
        }
      });
    });
  }
});

describe('rate pushes on existing portfolios are typed changes', () => {
  it('COOPartnersPage: the bulk partner edit writes the rate only when edited (or the switch is seen off)', () => {
    const code = src('components/coo/COOPartnersPage.tsx');
    expect(code).toMatch(/const roiEdited = editRoi\.trim\(\) !== String\(editPartner\.roiPercentage\);/);
    expect(code).toMatch(/\(rateSwitchOffSeen \|\| roiEdited\)\) updateFields\.roi_percentage = newRoi;/);
    expect(code).toMatch(/const rateSwitchOffSeen = partnerReturnPolicy\.fromNetwork && partnerReturnPolicy\.enabled === false;/);
  });

  it('COOPartnersPage: the portfolio edit keeps the stored rate (read back) in local state', () => {
    const code = src('components/coo/COOPartnersPage.tsx');
    expect(code).toMatch(/\.update\(updatePayload\)\s*\.eq\('id', editPortfolio\.id\)\s*\.select\('roi_percentage'\)/);
    expect(code).toContain('roi_percentage: storedRoi');
  });

  it('ActivePartnersDetail: rate push only when edited (or switch seen off); insert omits the rate unless so; stored rate read back', () => {
    const code = src('pages/coo/ActivePartnersDetail.tsx');
    expect(code).toMatch(/\(rateSwitchOffSeen \|\| roiEdited\)\) updateFields\.roi_percentage = newRoi;/);
    // The spread may carry a type cast (the generated types mark roi_percentage required).
    expect(code).toMatch(/\.\.\.\(\(?sendInsertRoi \? \{ roi_percentage: insertRoi \} : \{\}\)/);
    expect(code).toMatch(/const sendInsertRoi = rateSwitchOffSeen \|\| \(roiEdited && rateOrNull\(insertRoi\) !== null\);/);
    expect(code).toMatch(/\.insert\(\{[\s\S]*?\}\)\s*\.select\('roi_percentage'\)/);
    expect(code).toContain('created missing portfolio with ${createdRoi}% monthly Returns');
    expect(code).toMatch(/usePartnerReturnPolicy\(\{ fresh: true \}\)/);
  });
});
