
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { 
  Wallet, Shield, Clock, ArrowRight, Share2, 
  Smartphone, CreditCard, Send, PiggyBank, 
  Star, Users, TrendingUp 
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { Helmet } from 'react-helmet-async';

const ORIGIN = getPublicOrigin();
const PAGE_URL = `${ORIGIN}/rent-money`;

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "FinancialProduct",
  "name": "Welile Rent Money",
  "description": "Digital wallet for rent payments in Africa. Deposit, withdraw, send money and pay rent — all from your phone.",
  "url": PAGE_URL,
  "provider": {
    "@type": "Organization",
    "name": "Welile",
    "url": ORIGIN,
    "logo": `${ORIGIN}/welile-logo.png`
  },
  "areaServed": "Africa",
  "category": "Mobile Wallet",
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "UGX",
    "description": "Free to sign up. Start with as little as UGX 5,000."
  }
};

const features = [
  { icon: CreditCard, title: 'Deposit', desc: 'Add money via Mobile Money (MTN & Airtel) instantly' },
  { icon: Send, title: 'Send', desc: 'Wallet-to-wallet transfers to any Welile user in seconds' },
  { icon: Wallet, title: 'Withdraw', desc: 'Cash out to your mobile money anytime' },
  { icon: PiggyBank, title: 'Pay Rent', desc: 'Pay your landlord directly from your wallet' },
];

const benefits = [
  { icon: Shield, text: 'Secured by double-entry ledger — every transaction is audited' },
  { icon: Clock, text: 'Real-time balance updates across all devices' },
  { icon: Smartphone, text: 'Works on any phone — smartphones & feature phones' },
  { icon: Star, text: 'Earn referral rewards when friends join' },
];

const stats = [
  { value: '5,000+', label: 'Active Users' },
  { value: 'UGX 5K', label: 'Min Deposit' },
  { value: '24/7', label: 'Access' },
  { value: '15%', label: 'Supporter Rewards' },
];

export default function RentMoney() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const shareLink = user
    ? `${ORIGIN}/rent-money?ref=${user.id}`
    : PAGE_URL;

  const shareText = `💰 Rent Money by Welile — the easiest way to manage rent in Africa!

🏠 Deposit, send, withdraw & pay rent from your phone
📱 Works on MTN & Airtel Mobile Money
🔒 Every transaction is secured & audited
🎁 Sign up free and earn referral rewards!

Join now: ${shareLink}`;

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Welile Rent Money', text: shareText, url: shareLink });
        return;
      } catch (e: any) {
        if (e.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(shareText);
      toast.success('Link copied — share it anywhere!');
    } catch {
      const wa = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
      window.open(wa, '_blank');
    }
  };

  return (
    <>
      <Helmet>
        <title>Rent Money by Welile — Your Wallet for Rent</title>
        <meta name="description" content="Deposit, send, withdraw and pay rent from your phone with Welile Rent Money. Works on MTN & Airtel Mobile Money." />
        <link rel="canonical" href={PAGE_URL} />
        <meta property="og:title" content="Rent Money by Welile — Your Wallet for Rent" />
        <meta property="og:description" content="Deposit, send, withdraw and pay rent from your phone with Welile Rent Money. Works on MTN & Airtel Mobile Money." />
        <meta property="og:url" content={PAGE_URL} />
        <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
      </Helmet>

      <div className="min-h-screen bg-background">
        {/* Hero */}
        <section className="relative overflow-hidden bg-gradient-to-br from-primary/10 via-background to-accent/10 py-16 px-4 sm:px-6 lg:px-8">
          <div className="max-w-4xl mx-auto text-center">
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
              <div className="inline-flex items-center gap-2 rounded-full bg-primary/15 px-4 py-1.5 text-sm font-medium text-primary mb-6">
                <Wallet className="h-4 w-4" />
                Rent Money by Welile
              </div>
              <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-foreground leading-tight mb-4">
                Your Rent, <span className="text-primary">Your Wallet</span>, Your Control
              </h1>
              <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-8">
                Deposit, send, withdraw and pay rent — all from your phone. 
                Built for tenants, supporters and agents across Africa.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Button size="lg" onClick={() => navigate('/auth?role=tenant')} className="gap-2 text-base">
                  Get Started Free <ArrowRight className="h-4 w-4" />
                </Button>
                <Button size="lg" variant="outline" onClick={handleShare} className="gap-2 text-base">
                  <Share2 className="h-4 w-4" /> Share with Friends
                </Button>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Stats */}
        <section className="py-10 px-4 border-b border-border">
          <div className="max-w-4xl mx-auto grid grid-cols-2 sm:grid-cols-4 gap-6 text-center">
            {stats.map((s) => (
              <div key={s.label}>
                <p className="text-2xl sm:text-3xl font-bold text-primary">{s.value}</p>
                <p className="text-sm text-muted-foreground">{s.label}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Features */}
        <section className="py-16 px-4 sm:px-6 lg:px-8">
          <div className="max-w-4xl mx-auto">
            <h2 className="text-2xl sm:text-3xl font-bold text-center text-foreground mb-10">
              Everything You Need in One Wallet
            </h2>
            <div className="grid sm:grid-cols-2 gap-5">
              {features.map((f, i) => (
                <motion.div key={f.title} initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1 }}>
                  <Card className="h-full hover:shadow-md transition-shadow border-border">
                    <CardContent className="p-5 flex gap-4">
                      <div className="h-11 w-11 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                        <f.icon className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-foreground mb-1">{f.title}</h3>
                        <p className="text-sm text-muted-foreground">{f.desc}</p>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* How It Works */}
        <section className="py-16 px-4 sm:px-6 lg:px-8 bg-muted/50">
          <div className="max-w-4xl mx-auto">
            <h2 className="text-2xl sm:text-3xl font-bold text-center text-foreground mb-10">
              How It Works
            </h2>
            <div className="grid sm:grid-cols-3 gap-6 text-center">
              {[
                { step: '1', title: 'Sign Up Free', desc: 'Create your account in 2 minutes — no fees, no paperwork.' },
                { step: '2', title: 'Add Rent Money', desc: 'Deposit via MTN or Airtel Mobile Money from anywhere.' },
                { step: '3', title: 'Pay & Earn', desc: 'Pay rent, send to friends, and earn rewards for referrals.' },
              ].map((item) => (
                <div key={item.step} className="space-y-3">
                  <div className="h-12 w-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-lg font-bold mx-auto">
                    {item.step}
                  </div>
                  <h3 className="font-semibold text-foreground">{item.title}</h3>
                  <p className="text-sm text-muted-foreground">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Benefits */}
        <section className="py-16 px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-2xl sm:text-3xl font-bold text-center text-foreground mb-10">
              Why Rent Money?
            </h2>
            <div className="space-y-4">
              {benefits.map((b) => (
                <div key={b.text} className="flex items-start gap-3 p-4 rounded-xl bg-card border border-border">
                  <div className="h-9 w-9 rounded-lg bg-success/10 flex items-center justify-center shrink-0">
                    <b.icon className="h-4.5 w-4.5 text-success" />
                  </div>
                  <p className="text-sm sm:text-base text-foreground">{b.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Supporters CTA */}
        <section className="py-16 px-4 sm:px-6 lg:px-8 bg-gradient-to-br from-primary/5 to-success/5">
          <div className="max-w-3xl mx-auto text-center space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full bg-success/15 px-4 py-1.5 text-sm font-medium text-success">
              <TrendingUp className="h-4 w-4" />
              For Supporters
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold text-foreground">
              Earn Up to 15% Monthly Rewards
            </h2>
            <p className="text-muted-foreground max-w-xl mx-auto">
              Help tenants pay rent and earn platform rewards. Your contribution is secured by Welile's Operational Assurance.
            </p>
            <p className="text-sm font-semibold italic text-purple-600 dark:text-purple-400">
              ✨ Welile is turning rent into an asset
            </p>
            <Button size="lg" onClick={() => navigate('/become-supporter')} className="gap-2">
              Become a Supporter <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </section>

        {/* Share CTA */}
        <section className="py-16 px-4 sm:px-6 lg:px-8">
          <div className="max-w-md mx-auto text-center space-y-5">
            <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
              <Users className="h-8 w-8 text-primary" />
            </div>
            <h2 className="text-xl sm:text-2xl font-bold text-foreground">
              Share & Earn UGX 500
            </h2>
            <p className="text-sm text-muted-foreground">
              Every person who signs up through your link earns you UGX 500 instantly!
            </p>
            <Button size="lg" onClick={handleShare} className="gap-2 w-full sm:w-auto bg-gradient-to-r from-primary to-primary/80">
              <Share2 className="h-4 w-4" /> Share Rent Money Link
            </Button>
            <p className="text-xs text-muted-foreground break-all font-mono">{shareLink}</p>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-border py-8 px-4 text-center text-sm text-muted-foreground">
          <p>© {new Date().getFullYear()} Welile — Africa's Rent Facilitation Platform</p>
          <div className="flex justify-center gap-4 mt-2">
            <a href="/terms" className="hover:text-foreground transition-colors">Terms</a>
            <a href="/privacy" className="hover:text-foreground transition-colors">Privacy</a>
          </div>
        </footer>
      </div>
    </>
  );
}
