// TEMPORARY design preview for the agent nudge toasts. Remove once signed off.
import { useState } from 'react';
import { toast } from 'sonner';
import { AgentNudgeToast } from '@/components/agent/AgentNudgeToast';
import type { RenderedNudge } from '@/lib/agentNudges';

const PREVIEW_EMAIL = 'pexpert46@gmail.com';

const SAMPLES: (RenderedNudge & { ctaLabel?: string })[] = [
  { id: 'p1', tone: 'celebrate', category: 'rank', title: "You're #1 today! 🥇👑", body: 'You lead the board with 14 collections. Keep the crown, Boss!', cta: 'leaderboard', ctaLabel: 'See the board' },
  { id: 'p2', tone: 'nudge', category: 'collect', title: 'Hi 👋 Boss', body: '6 tenants are still waiting for you to collect today. Let\'s go! 💪', cta: 'collect', ctaLabel: 'Collect now' },
  { id: 'p3', tone: 'nudge', category: 'commission', title: 'Money on the table 🤑', body: "You're missing out on UGX 23,490 in commission. Collect for your tenants, Boss 😎", cta: 'collect', ctaLabel: 'Collect now' },
  { id: 'p4', tone: 'celebrate', category: 'streak', title: '5-day streak! 🔥', body: 'You have collected every day this week. Don\'t break the chain!' },
  { id: 'p5', tone: 'info', category: 'new_tenant', title: 'Grow your list 🌱', body: 'Every new tenant on a Rent Plan grows your commission. Add one today.', cta: 'add_tenant', ctaLabel: 'Add tenant' },
  { id: 'p6', tone: 'celebrate', category: 'celebrate', title: 'Big day! 🎉', body: 'You collected UGX 412,000 today. Your Supporters are proud!' },
  { id: 'p7', tone: 'info', category: 'morning', title: 'Good morning ☀️', body: '9 tenants are due today. A quick start makes a great day.' },
];

export function AgentNudgePreviewButton({ email }: { email?: string | null }) {
  const [i, setI] = useState(0);
  if (email?.toLowerCase() !== PREVIEW_EMAIL) return null;

  const show = () => {
    const n = SAMPLES[i % SAMPLES.length];
    setI(i + 1);
    toast.custom(
      (t) => (
        <AgentNudgeToast
          nudge={n}
          ctaLabel={n.ctaLabel}
          onCta={n.ctaLabel ? () => toast.dismiss(t) : undefined}
          onClose={() => toast.dismiss(t)}
        />
      ),
      { id: 'agent-nudge', duration: 9_000, unstyled: true },
    );
  };

  return (
    <button
      type="button"
      onClick={show}
      className="fixed left-3 bottom-28 z-[60] rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-lg"
    >
      Preview nudge ({(idx.current % SAMPLES.length) + 1}/{SAMPLES.length})
    </button>
  );
}
