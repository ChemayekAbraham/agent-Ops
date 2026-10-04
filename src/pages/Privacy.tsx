import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Button } from '@/components/ui/button';

export default function Privacy() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Privacy Policy | Welile</title>
        <meta
          name="description"
          content="Learn how Welile collects, uses, shares, and protects your personal information, including identity, transaction, and location data on our rent platform."
        />
        <link rel="canonical" href="https://welileapp.com/privacy" />
        <meta property="og:title" content="Privacy Policy | Welile" />
        <meta
          property="og:description"
          content="How Welile handles and protects your personal data."
        />
        <meta property="og:url" content="https://welileapp.com/privacy" />
      </Helmet>
      <div className="max-w-2xl mx-auto px-4 py-8">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="mb-6 gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>

        <h1 className="text-2xl font-bold mb-6">Privacy Policy</h1>

        <div className="prose prose-sm dark:prose-invert space-y-6">
          <section>
            <h2 className="text-lg font-semibold">1. Information We Collect</h2>
            <p className="text-muted-foreground leading-relaxed">
              We collect personal information you provide during registration, including your name, phone number, email address, National ID, and location data. We also collect transaction data, device information, and usage analytics.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">2. How We Use Your Information</h2>
            <p className="text-muted-foreground leading-relaxed">
              Your information is used to provide and improve our services, verify identities, process transactions, calculate credit limits, facilitate communication between users, and comply with legal obligations.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">3. Data Sharing</h2>
            <p className="text-muted-foreground leading-relaxed">
              We share relevant information with other platform users as necessary for transactions (e.g., landlord details with tenants, agent information with managers). We do not sell your personal data to third parties.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">4. Data Security</h2>
            <p className="text-muted-foreground leading-relaxed">
              We implement industry-standard security measures including encryption, secure authentication, and row-level access controls to protect your data. However, no system is completely secure.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">5. Location Data</h2>
            <p className="text-muted-foreground leading-relaxed">
              We collect GPS location data during registration and property verification to ensure service accuracy and prevent fraud. Location data is stored securely and only shared with authorized personnel.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">6. Data Retention</h2>
            <p className="text-muted-foreground leading-relaxed">
              We retain your data for as long as your account is active and as required by applicable laws. You may request deletion of your account by contacting support.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">7. Your Rights</h2>
            <p className="text-muted-foreground leading-relaxed">
              You have the right to access, correct, or request deletion of your personal data. Contact us at support for any privacy-related inquiries.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold">8. Updates to This Policy</h2>
            <p className="text-muted-foreground leading-relaxed">
              We may update this Privacy Policy from time to time. We will notify users of significant changes through the platform.
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
