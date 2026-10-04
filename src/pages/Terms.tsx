import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Button } from '@/components/ui/button';

export default function Terms() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Terms & Conditions | Welile</title>
        <meta
          name="description"
          content="Read Welile's Terms & Conditions covering platform services, user accounts, rent facilitation, and your responsibilities when using Welile in Uganda."
        />
        <link rel="canonical" href="https://welileapp.com/terms" />
        <meta property="og:title" content="Terms & Conditions | Welile" />
        <meta
          property="og:description"
          content="The terms governing your use of Welile's rent facilitation platform."
        />
        <meta property="og:url" content="https://welileapp.com/terms" />
      </Helmet>
      <div className="max-w-2xl mx-auto px-4 py-8">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="mb-6 gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>

        <h1 className="text-2xl font-bold mb-6">Terms & Conditions</h1>

        <div className="prose prose-sm dark:prose-invert space-y-6">
          <section>
            <h2 className="text-lg font-semibold">1. Acceptance of Terms</h2>
            <p className="text-muted-foreground leading-relaxed">
              By accessing and using Welile ("the Platform"), you agree to be bound by these Terms and Conditions. If you do not agree, please discontinue use immediately.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">2. Platform Services</h2>
            <p className="text-muted-foreground leading-relaxed">
              Welile provides a digital platform connecting tenants, landlords, agents, and supporters to facilitate rent payments, financial services, and related transactions in Uganda.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">3. User Accounts</h2>
            <p className="text-muted-foreground leading-relaxed">
              You are responsible for maintaining the confidentiality of your account credentials. You agree to provide accurate information during registration and to update it as necessary. Each user may hold multiple roles (Tenant, Landlord, Agent, Supporter) simultaneously.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">4. Tenant Terms</h2>
            <p className="text-muted-foreground leading-relaxed">
              Tenants who receive rent advances agree to repay the total amount (including access fees) according to the agreed repayment schedule. Failure to make timely payments may affect your credit access limit and risk score.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">5. Landlord Terms</h2>
            <p className="text-muted-foreground leading-relaxed">
              Landlords who list properties on the platform agree to receive rent payments through Welile's payment channels. Landlords must provide accurate property information, including verified utility meter numbers and location data. The "Guaranteed Rent" program is subject to verification by Welile managers.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">6. Agent Terms</h2>
            <p className="text-muted-foreground leading-relaxed">
              Agents earn commissions for registering tenants and facilitating transactions. Sub-agent overrides (2%) are earned on transactions from recruited sub-agents. All agent activities are subject to verification and platform policies.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">7. Supporter Terms</h2>
            <p className="text-muted-foreground leading-relaxed">
              Supporters who fund rent requests do so at their own discretion. Interest rates and repayment terms are as displayed at the time of funding. Welile does not guarantee returns on funded requests.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">8. Fees & Charges</h2>
            <p className="text-muted-foreground leading-relaxed">
              All applicable fees (access fees, request fees, platform fees) are transparently displayed before any transaction is confirmed. Withdrawal requests below UGX 500 are not processed.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">9. Data & Privacy</h2>
            <p className="text-muted-foreground leading-relaxed">
              Your personal data is handled in accordance with our Privacy Policy. By using the platform, you consent to the collection and processing of your data as described therein.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">10. Limitation of Liability</h2>
            <p className="text-muted-foreground leading-relaxed">
              Welile acts as a facilitator and is not liable for disputes between users. The platform is provided "as is" without warranties of any kind.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">11. Modifications</h2>
            <p className="text-muted-foreground leading-relaxed">
              Welile reserves the right to modify these terms at any time. Continued use of the platform after changes constitutes acceptance of the updated terms.
            </p>
          </section>

          <p className="text-xs text-muted-foreground pt-4 border-t">
            Last updated: February 2026 · Welile Receipts Ltd, Uganda
          </p>
        </div>
      </div>
    </div>
  );
}
