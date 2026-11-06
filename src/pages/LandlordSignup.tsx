import { useState, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { supabase } from '@/integrations/supabase/client';
import { Shield, CheckCircle2, Clock, Users, Home, BadgeCheck, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { toast } from 'sonner';
import {
  LANDLORD_PITCH_PERIOD_MONTHS,
  LANDLORD_SIGNUP_COPY,
  calculateLandlordPeriodRent,
  formatLandlordPeriodOffer,
  type LandlordPitchPeriodMonths,
} from '@/lib/landlordPitchScript';

const VALUE_PROPS = [
  { icon: Clock, text: 'Get paid every month on time for your tenant’s Rent Plan' },
  { icon: Shield, text: 'Welile pays your agreed Rent Plan schedule while the tenant repays Welile over time' },
  { icon: Users, text: 'No chasing tenants for late monthly rent' },
  { icon: Home, text: 'We support tenant placement and replacement for registered units' },
  { icon: BadgeCheck, text: 'Predictable, verified rent collection for 3, 6, or 12 months' },
];

export default function LandlordSignup() {
  const [params] = useSearchParams();
  const agentId = params.get('ref') || null;
  const campaign = params.get('campaign') || params.get('utm_campaign') || null;

  // Calculator state (defaults to 3 months so the initial figure is specific and believable)
  const [calcRent, setCalcRent] = useState('');
  const [calcUnits, setCalcUnits] = useState('1');
  const [calcMonths, setCalcMonths] = useState<LandlordPitchPeriodMonths>(3);

  const periodAmount = useMemo(
    () =>
      calculateLandlordPeriodRent(
        Number(calcRent) || 0,
        Number(calcUnits) || 0,
        calcMonths,
      ),
    [calcRent, calcUnits, calcMonths],
  );

  const periodOfferText = useMemo(
    () =>
      formatLandlordPeriodOffer(
        Number(calcRent) || 0,
        Number(calcUnits) || 0,
        calcMonths,
      ),
    [calcRent, calcUnits, calcMonths],
  );

  // Form state
  const [form, setForm] = useState({
    phone: '',
    location: '',
    units: '',
    rentPerUnit: '',
  });
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const set = useCallback((k: keyof typeof form, v: string) => setForm(p => ({ ...p, [k]: v })), []);

  // Name is captured in parts but stored as the same single `full_name` string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const nameCheckLive = validatePersonNameParts(nameParts);
  const nameOk = nameCheckLive.valid;
  const canSubmit = nameOk && form.phone && form.location && form.units && form.rentPerUnit && agreed && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const nameCheck = validatePersonNameParts(nameParts);
    if (!nameCheck.valid) {
      toast.error(nameCheck.error || 'Please enter your full name (first and last)');
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase.from('landlord_leads').insert({
        full_name: nameCheck.fullName,
        phone: form.phone.trim(),
        property_location: form.location.trim(),
        number_of_units: Number(form.units),
        rent_per_unit: Number(form.rentPerUnit),
        referrer_agent_id: agentId,
        campaign,
        status: 'new_lead',
      });
      if (error) throw error;
      setSubmitted(true);
    } catch (err) {
      console.error('Submission error:', err);
      alert('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  // Confirmation must go to the Welile WhatsApp line shown in the SMS invite.
  const whatsappUrl = `https://wa.me/256777607640?text=${encodeURIComponent('I have completed my Welile landlord signup')}`;

  if (submitted) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <Helmet>
          <title>Welcome to Welile — Landlord Rent Plan Partner</title>
          <link rel="canonical" href="https://welileapp.com/landlord-signup" />
          <meta property="og:url" content="https://welileapp.com/landlord-signup" />
        </Helmet>
        <div className="max-w-md w-full text-center space-y-6 py-12">
          <div className="mx-auto w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
            <CheckCircle2 className="w-10 h-10 text-primary" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">
            {LANDLORD_SIGNUP_COPY.submittedTitle}
          </h1>
          <p className="text-muted-foreground text-base leading-relaxed">
            {LANDLORD_SIGNUP_COPY.submittedLead}
          </p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {LANDLORD_SIGNUP_COPY.submittedSubtext}
          </p>

          <div className="flex items-center justify-center gap-2 rounded-xl border border-border/60 bg-muted/40 px-4 py-3 min-h-[44px]">
            <MessageCircle className="w-4 h-4 text-primary" />
            <span className="text-sm text-muted-foreground">Confirm on WhatsApp</span>
            <span className="text-sm font-semibold text-foreground">0777 607 640</span>
          </div>

          <a
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 bg-primary text-primary-foreground font-semibold rounded-xl px-6 py-3.5 min-h-[44px] hover:bg-primary/90 transition-colors"
          >
            <MessageCircle className="w-5 h-5" />
            Confirm on WhatsApp
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>{LANDLORD_SIGNUP_COPY.pageTitle}</title>
        <meta name="description" content={LANDLORD_SIGNUP_COPY.metaDescription} />
        <link rel="canonical" href="https://welileapp.com/landlord-signup" />
        <meta property="og:url" content="https://welileapp.com/landlord-signup" />
      </Helmet>

      {/* Hero: Leads with what Welile actually does */}
      <section className="relative overflow-hidden bg-gradient-to-br from-primary via-primary/90 to-primary/80 text-primary-foreground px-4 pt-10 pb-16">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.1),transparent_60%)]" />
        <div className="relative max-w-lg mx-auto text-center space-y-3">
          <p className="text-xs font-semibold tracking-widest uppercase opacity-85">
            {LANDLORD_SIGNUP_COPY.heroEyebrow}
          </p>
          <h1
            data-testid="landlord-signup-hero-title"
            className="text-2xl sm:text-4xl font-extrabold leading-tight"
          >
            {LANDLORD_SIGNUP_COPY.heroTitle}
          </h1>
          <p
            data-testid="landlord-signup-what-we-do"
            className="text-sm sm:text-base opacity-95 leading-relaxed"
          >
            {LANDLORD_SIGNUP_COPY.heroWhatWeDo}
          </p>
        </div>
      </section>

      {/* Calculator: 3, 6, or 12 months bounded Rent Plan offer */}
      <section className="px-4 -mt-8 relative z-10">
        <div
          data-testid="landlord-signup-calculator"
          className="max-w-lg mx-auto bg-card rounded-2xl border border-border/60 shadow-lg p-4 sm:p-6 space-y-4"
        >
          <div className="space-y-1 text-center">
            <h2 className="text-base sm:text-lg font-semibold text-foreground">
              {LANDLORD_SIGNUP_COPY.calculatorTitle}
            </h2>
            <p className="text-xs text-muted-foreground">
              Start with one tenant’s house or your full property across 3, 6, or 12 months.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="calc-rent-input" className="text-xs text-muted-foreground">
                Monthly Rent per Unit (UGX)
              </Label>
              <Input
                id="calc-rent-input"
                data-testid="calc-rent-input"
                type="number"
                inputMode="numeric"
                placeholder="e.g. 500,000"
                value={calcRent}
                onChange={e => setCalcRent(e.target.value)}
                className="min-h-[44px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="calc-units-input" className="text-xs text-muted-foreground">
                Number of Units Covered
              </Label>
              <Input
                id="calc-units-input"
                data-testid="calc-units-input"
                type="number"
                inputMode="numeric"
                placeholder="e.g. 1"
                value={calcUnits}
                onChange={e => setCalcUnits(e.target.value)}
                min={1}
                className="min-h-[44px]"
              />
            </div>
          </div>

          {/* 3, 6, or 12-Month Period Picker */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground block">
              {LANDLORD_SIGNUP_COPY.calculatorPeriodLabel}
            </Label>
            <div
              role="group"
              aria-label="Choose Rent Plan Period"
              className="grid grid-cols-3 gap-2"
            >
              {LANDLORD_PITCH_PERIOD_MONTHS.map(months => {
                const selected = calcMonths === months;
                return (
                  <button
                    key={months}
                    type="button"
                    data-testid={`calc-period-${months}m`}
                    aria-pressed={selected}
                    onClick={() => setCalcMonths(months)}
                    className={cn(
                      'min-h-[44px] rounded-xl border px-3 py-2 text-xs sm:text-sm font-semibold transition-colors',
                      selected
                        ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                        : 'border-border bg-background text-foreground hover:bg-muted/60',
                    )}
                  >
                    {months} months
                  </button>
                );
              })}
            </div>
          </div>

          {/* Bounded Offer Output: "UGX [amount] for [period]" */}
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-3.5 text-center space-y-1.5">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">
              {LANDLORD_SIGNUP_COPY.calculatorResultEyebrow(calcMonths)}
            </p>
            <p
              data-testid="calc-period-offer-output"
              className={cn(
                'font-extrabold tracking-tight transition-all duration-200 break-words',
                periodAmount > 0
                  ? 'text-2xl sm:text-3xl text-primary'
                  : 'text-xl sm:text-2xl text-muted-foreground',
              )}
            >
              {periodOfferText}
            </p>
            <p
              data-testid="calc-how-money-moves"
              className="text-xs text-muted-foreground leading-relaxed pt-1"
            >
              {LANDLORD_SIGNUP_COPY.howMoneyMovesNote}
            </p>
          </div>
        </div>
      </section>

      {/* Value Props */}
      <section className="px-4 py-10 max-w-lg mx-auto">
        <h2 className="text-lg font-semibold text-foreground mb-5 text-center">
          Why Landlords Choose Welile
        </h2>
        <div className="space-y-3">
          {VALUE_PROPS.map(({ icon: Icon, text }) => (
            <div key={text} className="flex items-start gap-3 p-3 rounded-xl bg-card border border-border/40">
              <div className="mt-0.5 shrink-0 w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Icon className="w-4 h-4 text-primary" />
              </div>
              <p className="text-sm text-foreground leading-relaxed">{text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Form */}
      <section className="px-4 pb-32 max-w-lg mx-auto">
        <h2 className="text-lg font-semibold text-foreground mb-5 text-center">
          {LANDLORD_SIGNUP_COPY.formHeading}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <PersonNameFields idPrefix="landlord-signup" value={nameParts} onChange={setNameParts} />
          <div className="space-y-1.5">
            <Label htmlFor="landlord-phone">Phone Number</Label>
            <Input
              id="landlord-phone"
              type="tel"
              inputMode="tel"
              placeholder="e.g. 0770 000 000"
              value={form.phone}
              onChange={e => set('phone', e.target.value)}
              required
              className="min-h-[44px]"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="landlord-location">Property Location</Label>
            <Input
              id="landlord-location"
              placeholder="e.g. Ntinda, Kampala"
              value={form.location}
              onChange={e => set('location', e.target.value)}
              required
              className="min-h-[44px]"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="landlord-units">Number of Units</Label>
              <Input
                id="landlord-units"
                type="number"
                inputMode="numeric"
                placeholder="e.g. 5"
                value={form.units}
                onChange={e => set('units', e.target.value)}
                required
                min={1}
                className="min-h-[44px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="landlord-rent-per-unit">Rent per Unit (UGX)</Label>
              <Input
                id="landlord-rent-per-unit"
                type="number"
                inputMode="numeric"
                placeholder="e.g. 500000"
                value={form.rentPerUnit}
                onChange={e => set('rentPerUnit', e.target.value)}
                required
                min={1}
                className="min-h-[44px]"
              />
            </div>
          </div>

          {/* Agreement */}
          <div className="flex items-start gap-3 p-4 rounded-xl bg-muted/50 border border-border/40">
            <Checkbox
              id="agree"
              checked={agreed}
              onCheckedChange={(c) => setAgreed(c === true)}
              className="mt-0.5 h-5 w-5"
            />
            <label htmlFor="agree" className="text-xs sm:text-sm text-muted-foreground leading-relaxed cursor-pointer">
              {LANDLORD_SIGNUP_COPY.consentLabel}
            </label>
          </div>

          {/* Sticky CTA */}
          <div className="fixed bottom-0 left-0 right-0 p-4 bg-background/95 backdrop-blur-sm border-t border-border/40 z-50">
            <div className="max-w-lg mx-auto">
              <Button
                type="submit"
                disabled={!canSubmit}
                data-testid="landlord-signup-submit-btn"
                className="w-full h-14 min-h-[44px] text-sm sm:text-base font-bold rounded-2xl shadow-lg"
                size="xl"
              >
                {submitting ? 'Submitting...' : LANDLORD_SIGNUP_COPY.submitButtonLabel}
              </Button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}
