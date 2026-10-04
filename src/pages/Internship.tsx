import { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import { Zap, BookOpen, Banknote, ArrowRight, Loader2, GraduationCap, CheckCircle2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
import { cn } from '@/lib/utils';
import welileLogo from '@/assets/welile-logo.png';

const benefits = [
  { icon: BookOpen, title: 'Learn Real Skills', desc: 'Sales, digital tools, and financial literacy', gradient: 'from-blue-500 to-indigo-600' },
  { icon: Banknote, title: 'Earn Income', desc: 'Commission on every registration & collection', gradient: 'from-emerald-500 to-teal-600' },
  { icon: Zap, title: 'Gain Experience', desc: 'Build a career in fintech & field operations', gradient: 'from-amber-500 to-orange-600' },
];

export default function Internship() {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [reference, setReference] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [form, setForm] = useState({
    fullName: '',
    phone: '',
    email: '',
    motivation: '',
    skills: '',
    readyToLearn: 'yes',
    referralCode: '',
    institution: '',
    course: '',
    yearOfStudy: '',
    expectedCompletion: '',
    availabilityStart: '',
    availabilityWeeks: '',
    availabilityDaysPerWeek: '',
    preferredContactChannel: '',
    futureRolesConsent: false,
  });
  // Name captured in parts; `form.fullName` stays the single submitted string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const applyNameParts = (next: PersonNameParts) => {
    setNameParts(next);
    setForm(prev => ({ ...prev, fullName: joinPersonName(next) }));
  };

  const updateField = (field: string, value: string) => setForm(prev => ({ ...prev, [field]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nameCheck = validatePersonNameParts(nameParts);
    if (!nameCheck.valid || !form.phone.trim()) {
      toast({ title: 'Required fields', description: nameCheck.error || 'Please fill in your name and phone number', variant: 'destructive' });
      return;
    }
    if (!form.motivation.trim()) {
      toast({ title: 'Tell us why', description: 'Please share why you want to join Welile', variant: 'destructive' });
      return;
    }
    if (!form.preferredContactChannel) {
      toast({ title: 'Contact preference required', description: 'Please choose how we should contact you', variant: 'destructive' });
      return;
    }
    if (!consent) {
      toast({ title: 'Consent required', description: 'Please tick the consent checkbox to continue', variant: 'destructive' });
      return;
    }

    setIsSubmitting(true);
    try {
      const submitReference = crypto.randomUUID().slice(0, 8);
      const { error } = await supabase.from('internship_applications').insert({
        full_name: form.fullName.trim(),
        phone: form.phone.trim(),
        email: form.email.trim() || null,
        motivation: form.motivation.trim(),
        skills: form.skills.trim() || null,
        ready_to_learn: form.readyToLearn === 'yes',
        referral_code: form.referralCode.trim() || null,
        institution: form.institution.trim() || null,
        course: form.course.trim() || null,
        year_of_study: form.yearOfStudy ? Number(form.yearOfStudy) : null,
        expected_completion: form.expectedCompletion || null,
        availability_start: form.availabilityStart || null,
        availability_weeks: form.availabilityWeeks ? Number(form.availabilityWeeks) : null,
        availability_days_per_week: form.availabilityDaysPerWeek ? Number(form.availabilityDaysPerWeek) : null,
        preferred_contact_channel: form.preferredContactChannel,
        future_roles_consent: form.futureRolesConsent,
        consent_text_version: 'internship-v1-2026-08-13',
        consented_at: new Date().toISOString(),
      });

      if (error) throw error;

      setReference(submitReference);
      setSubmitted(true);
      toast({ title: 'Application submitted', description: `Reference: ${submitReference}` });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message || 'Failed to submit. Please try again.', variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-success/20 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-8 h-8 text-success" />
          </div>
          <h2 className="text-xl font-bold">Application Received</h2>
          <p className="text-muted-foreground">
            Your reference: <span className="font-mono font-semibold">{reference}</span>
          </p>
          <p className="text-sm text-muted-foreground">
            To ask what we hold about you, or to have it deleted, contact us and quote this reference.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Welile Internship — Learn, Earn & Grow</title>
        <meta name="description" content="Join the Welile internship program. Gain real fintech experience, earn as you learn, and build a career across Africa." />
        <link rel="canonical" href="https://welileapp.com/internship" />
        <meta property="og:title" content="Welile Internship — Learn, Earn & Grow" />
        <meta property="og:description" content="Join the Welile internship program. Gain real fintech experience, earn as you learn, and build a career across Africa." />
        <meta property="og:url" content="https://welileapp.com/internship" />
      </Helmet>
      {/* Hero */}
      <div className="relative overflow-hidden bg-gradient-to-br from-amber-500/10 via-background to-orange-500/10">
        <div className="max-w-lg mx-auto px-4 pt-8 pb-6 text-center">
          <img src={welileLogo} alt="Welile" className="h-10 mx-auto mb-4" />
          <div className="inline-flex items-center gap-2 bg-amber-500/15 text-amber-600 dark:text-amber-400 rounded-full px-3 py-1 text-xs font-semibold mb-3">
            <GraduationCap className="w-3.5 h-3.5" />
            Earn While You Learn Program
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">
            Earn While You Learn<br />
            <span className="text-primary">with Welile</span>
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed max-w-sm mx-auto">
            Build real skills, earn income, and grow into a high-performing agent. Takes less than 2 minutes.
          </p>
        </div>
      </div>

      {/* Benefits */}
      <div className="max-w-lg mx-auto px-4 -mt-2 mb-6">
        <div className="grid grid-cols-3 gap-2">
          {benefits.map((b) => (
            <Card key={b.title} className="border-border/40">
              <CardContent className="p-3 text-center space-y-1.5">
                <div className={cn('w-9 h-9 rounded-xl bg-gradient-to-br flex items-center justify-center mx-auto', b.gradient)}>
                  <b.icon className="w-4.5 h-4.5 text-white" />
                </div>
                <p className="text-xs font-semibold leading-tight">{b.title}</p>
                <p className="text-[10px] text-muted-foreground leading-tight">{b.desc}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Form */}
      <div className="max-w-lg mx-auto px-4 pb-12">
        <form onSubmit={handleSubmit} className="space-y-4">
          <h2 className="text-lg font-semibold">Apply Now</h2>

          {/* Basic Info */}
          <div className="space-y-3">
            <div>
              <Label>Full Name *</Label>
              <PersonNameFields idPrefix="internship" value={nameParts} onChange={applyNameParts} />
            </div>
            <div>
              <Label htmlFor="phone">Phone Number *</Label>
              <Input id="phone" type="tel" placeholder="07XX XXX XXX" value={form.phone} onChange={e => updateField('phone', e.target.value)} required />
            </div>
            <div>
              <Label htmlFor="email">Email Address</Label>
              <Input id="email" type="email" placeholder="you@email.com" value={form.email} onChange={e => updateField('email', e.target.value)} />
            </div>
          </div>

          {/* Mindset */}
          <div className="space-y-3 pt-2">
            <div>
              <Label htmlFor="motivation">Why do you want to join Welile? *</Label>
              <Textarea id="motivation" placeholder="e.g. To gain skills, earn income, grow my career..." value={form.motivation} onChange={e => updateField('motivation', e.target.value)} className="min-h-[70px]" required />
            </div>
            <div>
              <Label htmlFor="skills">What skills or strengths do you have?</Label>
              <Textarea id="skills" placeholder="e.g. Communication, sales, social media..." value={form.skills} onChange={e => updateField('skills', e.target.value)} className="min-h-[60px]" />
            </div>
            <div>
              <Label>Are you ready to learn and actively participate? *</Label>
              <RadioGroup value={form.readyToLearn} onValueChange={v => updateField('readyToLearn', v)} className="flex gap-4 mt-1.5">
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="yes" id="ready-yes" />
                  <Label htmlFor="ready-yes" className="font-normal cursor-pointer">Yes, I'm ready</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="no" id="ready-no" />
                  <Label htmlFor="ready-no" className="font-normal cursor-pointer">Just exploring</Label>
                </div>
              </RadioGroup>
            </div>
          </div>

          {/* Referral */}
          <div>
            <Label htmlFor="referralCode">Referral Code (optional)</Label>
            <Input id="referralCode" placeholder="If someone invited you" value={form.referralCode} onChange={e => updateField('referralCode', e.target.value)} />
          </div>

          {/* Education & Availability */}
          <div className="space-y-3 pt-2">
            <div>
              <Label htmlFor="institution">Institution</Label>
              <Input id="institution" placeholder="School or university" value={form.institution} onChange={e => updateField('institution', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="course">Course or programme</Label>
              <Input id="course" placeholder="e.g. Business Administration" value={form.course} onChange={e => updateField('course', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="yearOfStudy">Year of study</Label>
              <Input id="yearOfStudy" type="number" min={1} max={8} placeholder="1-8" value={form.yearOfStudy} onChange={e => updateField('yearOfStudy', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="expectedCompletion">Expected completion</Label>
              <Input id="expectedCompletion" type="date" value={form.expectedCompletion} onChange={e => updateField('expectedCompletion', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="availabilityStart">Earliest start date</Label>
              <Input id="availabilityStart" type="date" value={form.availabilityStart} onChange={e => updateField('availabilityStart', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="availabilityWeeks">How many weeks are you available?</Label>
              <Input id="availabilityWeeks" type="number" min={1} max={52} placeholder="1-52" value={form.availabilityWeeks} onChange={e => updateField('availabilityWeeks', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="availabilityDaysPerWeek">Days per week</Label>
              <Input id="availabilityDaysPerWeek" type="number" min={1} max={7} placeholder="1-7" value={form.availabilityDaysPerWeek} onChange={e => updateField('availabilityDaysPerWeek', e.target.value)} />
            </div>
            <div>
              <Label htmlFor="preferredContactChannel">How should we contact you? *</Label>
              <Select value={form.preferredContactChannel} onValueChange={v => updateField('preferredContactChannel', v)} required>
                <SelectTrigger id="preferredContactChannel">
                  <SelectValue placeholder="Select a contact method" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="phone">Phone</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Consent */}
          <div className="space-y-3 pt-2">
            <div className="flex items-start gap-3">
              <Checkbox id="consent" checked={consent} onCheckedChange={c => setConsent(c === true)} required />
              <Label htmlFor="consent" className="font-normal cursor-pointer leading-tight">
                I consent to Welile Technologies (U) Ltd holding these details to consider my application. *
              </Label>
            </div>
            <div className="flex items-start gap-3">
              <Checkbox id="futureRoles" checked={form.futureRolesConsent} onCheckedChange={c => setForm(prev => ({ ...prev, futureRolesConsent: c === true }))} />
              <Label htmlFor="futureRoles" className="font-normal cursor-pointer leading-tight">
                Keep my details for future opportunities for up to 24 months.
              </Label>
            </div>
          </div>

          {/* CTA */}
          <Button type="submit" size="xl" className="w-full bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-white" disabled={isSubmitting || !consent}>
            {isSubmitting ? (
              <><Loader2 className="w-5 h-5 animate-spin" /> Submitting...</>
            ) : (
              <>Start My Journey <ArrowRight className="w-5 h-5" /></>
            )}
          </Button>

        </form>
      </div>
    </div>
  );
}
