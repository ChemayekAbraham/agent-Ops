import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Phone, ShieldCheck, Star, FileText, MessageCircle, Headphones, TrendingUp, Handshake,
  Users, XCircle, Ear, User, Heart, Smile, Sparkles, Target, Lightbulb, HeartHandshake,
  ChevronDown,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

type Step = {
  n: number;
  icon: typeof Phone;
  title: string;
  tag?: string;
  lines: { text: string; muted?: boolean; hint?: boolean }[];
};

const STEPS: Step[] = [
  {
    n: 1, icon: Phone, title: 'Introduction', tag: 'Build trust immediately',
    lines: [
      { text: '“Hello, may I speak to [Tenant Name] please?”' },
      { text: '(Once confirmed)', muted: true },
      { text: '“Good morning/afternoon, my name is ___ calling from Welile Technologies.' },
      { text: 'We are doing a short service check-in to understand how your experience has been so far and improve our service to tenants. It will take less than 2 minutes.”' },
      { text: '“Is this a good time?”' },
    ],
  },
  {
    n: 2, icon: ShieldCheck, title: 'Set Safe Tone', tag: 'Important for rent-sensitive tenants',
    lines: [
      { text: '“We are not calling about any complaints or enforcement issues — just general feedback to improve our service to you.”' },
    ],
  },
  {
    n: 3, icon: Star, title: 'Question 1 — Overall Experience',
    lines: [
      { text: '“First, how would you describe your overall experience as a tenant with Welile so far?”' },
      { text: '(If negative)', hint: true },
      { text: '“I understand. What has been the main challenge for you?”' },
    ],
  },
  {
    n: 4, icon: FileText, title: 'Question 2 — Rent Clarity',
    lines: [
      { text: '“Is your rent amount, due date, and payment process clear and easy for you to understand?”' },
      { text: '– Yes / No', muted: true },
      { text: '(If no)', hint: true },
      { text: '“What part would you like us to explain better?”' },
    ],
  },
  {
    n: 5, icon: MessageCircle, title: 'Question 3 — Communication',
    lines: [
      { text: '“When we send rent reminders or tenancy updates, are they clear and helpful for you?”' },
      { text: '– Yes / Sometimes / No', muted: true },
    ],
  },
  {
    n: 6, icon: Headphones, title: 'Question 4 — Support Experience',
    lines: [
      { text: '“If you ever have a concern like maintenance or tenancy questions, do you get support in a timely way?”' },
      { text: '– Yes / Sometimes / No', muted: true },
    ],
  },
  {
    n: 7, icon: TrendingUp, title: 'Question 5 — Improvement', tag: 'Open and calm',
    lines: [
      { text: '“From your side, what can we improve to make your experience smoother and more comfortable as a tenant?”' },
      { text: '(Pause and listen fully — don’t interrupt)', hint: true },
    ],
  },
  {
    n: 8, icon: Handshake, title: 'Closing', tag: 'Protect relationship tone',
    lines: [
      { text: '“Thank you very much for your feedback. We really appreciate your time.' },
      { text: 'Your responses will help us improve the service for all tenants. Have a great day.” 🙂' },
    ],
  },
];

const KEY_RULES: { icon: typeof Users; text: string }[] = [
  { icon: Users, text: 'Never mention agents.' },
  { icon: XCircle, text: 'Never defend or explain during the call.' },
  { icon: Ear, text: 'Stay neutral even if tenant is emotional.' },
  { icon: User, text: 'Do not argue or correct tenant feelings.' },
  { icon: Heart, text: 'Listen more than you speak.' },
];

const TONE_GUIDE: { icon: typeof Smile; label: string; desc: string }[] = [
  { icon: Smile, label: 'Calm', desc: 'Stay relaxed and composed.' },
  { icon: Handshake, label: 'Respectful', desc: 'Show respect in every word.' },
  { icon: Ear, label: 'Understanding', desc: 'Empathize, don’t judge.' },
  { icon: Sparkles, label: 'Professional', desc: 'Keep it short, clear and helpful.' },
];

export function CallScriptGuide() {
  const [open, setOpen] = useState(true);

  return (
    <Card className="overflow-hidden border-primary/20">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 p-4 text-left touch-manipulation bg-gradient-to-r from-primary/10 via-background to-background"
      >
        <div className="p-2.5 rounded-xl bg-primary/15 shrink-0">
          <Headphones className="h-5 w-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-sm sm:text-base">Customer Care Call Script — Tenant Feedback</h3>
          <p className="text-xs text-muted-foreground">A short conversation. A better experience for every tenant.</p>
        </div>
        <ChevronDown className={`h-5 w-5 text-muted-foreground shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <CardContent className="p-4 pt-0">
              <div className="grid gap-4 lg:grid-cols-3">
                {/* Script steps */}
                <div className="lg:col-span-2 space-y-3">
                  {STEPS.map((s) => {
                    const Icon = s.icon;
                    return (
                      <div key={s.n} className="rounded-xl border bg-card p-3 flex gap-3">
                        <div className="flex flex-col items-center shrink-0">
                          <div className="p-2 rounded-lg bg-primary/10">
                            <Icon className="h-4 w-4 text-primary" />
                          </div>
                          <span className="mt-1.5 h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                            {s.n}
                          </span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="font-semibold text-sm uppercase tracking-tight">{s.title}</h4>
                            {s.tag && (
                              <Badge variant="secondary" className="text-[10px] font-medium">{s.tag}</Badge>
                            )}
                          </div>
                          <div className="mt-1.5 space-y-1">
                            {s.lines.map((l, i) => (
                              <p
                                key={i}
                                className={`text-xs leading-relaxed ${
                                  l.hint ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                                  : l.muted ? 'text-muted-foreground' : 'text-foreground'
                                }`}
                              >
                                {l.text}
                              </p>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Sidebar: rules + tone + goals */}
                <div className="space-y-4">
                  <div className="rounded-xl border bg-primary/5 p-3">
                    <h4 className="font-bold text-xs uppercase tracking-wide text-primary mb-2.5">Key Rules For Our Team</h4>
                    <ul className="space-y-2.5">
                      {KEY_RULES.map((r, i) => {
                        const Icon = r.icon;
                        return (
                          <li key={i} className="flex items-start gap-2.5">
                            <Icon className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                            <span className="text-xs leading-snug">{r.text}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>

                  <div className="rounded-xl border bg-card p-3">
                    <h4 className="font-bold text-xs uppercase tracking-wide text-primary mb-2.5">Tone Guide</h4>
                    <ul className="space-y-2.5">
                      {TONE_GUIDE.map((t, i) => {
                        const Icon = t.icon;
                        return (
                          <li key={i} className="flex items-start gap-2.5">
                            <Icon className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                            <div className="min-w-0">
                              <p className="text-xs font-semibold">{t.label}</p>
                              <p className="text-[11px] text-muted-foreground leading-snug">{t.desc}</p>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>

                  <div className="rounded-xl border bg-card p-3 space-y-3">
                    <div className="flex items-start gap-2.5">
                      <Target className="h-4 w-4 text-rose-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs font-semibold">Our Goal</p>
                        <p className="text-[11px] text-muted-foreground leading-snug">Happy tenants. Strong relationships. Better communities.</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2.5">
                      <Lightbulb className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs font-semibold">Remember</p>
                        <p className="text-[11px] text-muted-foreground leading-snug">Every call is an opportunity to improve someone’s experience.</p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl bg-primary p-3 text-primary-foreground flex items-start gap-2.5">
                    <HeartHandshake className="h-5 w-5 shrink-0 mt-0.5" />
                    <p className="text-xs leading-snug font-medium">
                      We listen. We care. We improve. Together, we build better living experiences.
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}