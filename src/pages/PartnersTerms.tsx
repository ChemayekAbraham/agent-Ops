import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export default function PartnersTerms() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="mb-6 gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>

        <h1 className="text-2xl font-bold mb-2">Partner & Funder Terms of Service</h1>
        <p className="text-sm text-muted-foreground mb-6">
          These terms apply exclusively to Welile Partners and Funders (Tenant Supporters / Investors). For general platform terms, see <a href="/terms" className="text-primary underline">Terms & Conditions</a>.
        </p>

        <div className="prose prose-sm dark:prose-invert space-y-6">
          <section>
            <h2 className="text-lg font-semibold">1. Eligibility</h2>
            <p className="text-muted-foreground leading-relaxed">
              Partners and Funders must be at least 18 years old, hold a valid government-issued ID, and complete Welile's KYC verification before activating a portfolio. Welile reserves the right to decline or revoke partner status at its sole discretion.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">2. Capital Contribution</h2>
            <p className="text-muted-foreground leading-relaxed">
              All capital contributed to a Welile portfolio is in Ugandan Shillings (UGX). The minimum portfolio entry is UGX 50,000. Funds deposited through MoMo, bank, or cash receipt are credited to your portfolio only after Welile Financial Operations verifies the inbound transfer.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">3. Returns (ROI)</h2>
            <p className="text-muted-foreground leading-relaxed">
              Returns are paid as a flat monthly rate disclosed at portfolio creation. Returns accrue daily and are settled to your withdrawable wallet on the agreed payout day each cycle, or compounded into your portfolio if the Compounding mode is selected. Returns are not guaranteed and are contingent on tenant repayment performance.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">4. Withdrawals & Notice Period</h2>
            <p className="text-muted-foreground leading-relaxed">
              Withdrawal of principal requires a mandatory <strong>90-day notice period</strong>, during which ROI accrual is paused on the noticed amount. Wallet (ROI) withdrawals are processed within 24 business hours, subject to Financial Operations verification. Withdrawals below UGX 500 are not processed.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">5. Portfolio Top-Ups</h2>
            <p className="text-muted-foreground leading-relaxed">
              Mid-cycle top-ups are parked in a pending top-up state and merged into the active portfolio only after manual approval. Top-ups begin accruing returns from the merge date, not the deposit date.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">6. Risk Disclosure</h2>
            <p className="text-muted-foreground leading-relaxed">
              Welile facilitates rent advances to verified tenants. While Welile actively manages collections, replacements, and field enforcement, partner capital remains exposed to tenant default risk, operational risk, and regulatory risk. Past performance does not guarantee future returns.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">7. Proxy Agent Delegation</h2>
            <p className="text-muted-foreground leading-relaxed">
              Partners may delegate field collections to an assigned Proxy Agent. A 2% instant commission on proxy agent deposits is paid to the partner of record. Partners remain responsible for monitoring agent activity through their dashboard.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">8. Reporting & Statements</h2>
            <p className="text-muted-foreground leading-relaxed">
              Partners receive real-time portfolio statements via the Welile dashboard, with downloadable PDF and Excel reports formatted to GAAP-aligned standards. All transactions are recorded on Welile's double-entry general ledger.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">9. Confidentiality & Data</h2>
            <p className="text-muted-foreground leading-relaxed">
              Partner identity, portfolio balances, and tenant assignments are confidential. Welile will not disclose partner information to third parties except where required by law, regulatory authorities (BoU/CMA), or with explicit consent.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">10. Suspension & Termination</h2>
            <p className="text-muted-foreground leading-relaxed">
              Welile may suspend or terminate a partner account for breach of these terms, suspected fraud, sanctions exposure, or regulatory directive. Upon termination, principal and accrued returns (net of recoverable costs) are settled within the 90-day notice window.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">11. Regulatory Compliance</h2>
            <p className="text-muted-foreground leading-relaxed">
              Welile operates in compliance with Bank of Uganda (BoU) and Capital Markets Authority (CMA) guidance. Partners agree to cooperate with KYC refresh, source-of-funds checks, and tax reporting where applicable.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">12. Limitation of Liability</h2>
            <p className="text-muted-foreground leading-relaxed">
              Welile's aggregate liability to a partner is limited to the partner's contributed principal less any returns already paid out. Welile is not liable for indirect, incidental, or consequential losses.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">13. Amendments</h2>
            <p className="text-muted-foreground leading-relaxed">
              These partner terms may be updated as Welile evolves its product and regulatory posture. Material changes will be notified via the dashboard and SMS. Continued participation after notice constitutes acceptance.
            </p>
          </section>

          <p className="text-xs text-muted-foreground pt-4 border-t">
            Last updated: April 2026 · Welile Technologies Limited, Uganda
          </p>
        </div>
      </div>
    </div>
  );
}