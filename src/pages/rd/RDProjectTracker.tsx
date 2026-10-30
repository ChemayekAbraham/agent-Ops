import React from 'react';
import { Progress } from '@/components/ui/progress';
import { ShieldCheck, CheckCircle2, Lock } from 'lucide-react';

export type MilestoneCategory = 'All' | 'Core' | 'Receipts & Signages' | 'Agent App' | 'Security & QA';
export type MilestoneStatus = 'Completed' | 'In QA' | 'Planned';

export interface MilestoneItem {
  id: string;
  title: string;
  category: Exclude<MilestoneCategory, 'All'>;
  status: MilestoneStatus;
  date: string;
  description: string;
  details?: string;
}

export const MILESTONES: MilestoneItem[] = [
  {
    id: 'auth-rbac',
    title: 'Authentication & RBAC',
    category: 'Core',
    status: 'Completed',
    date: 'Oct 18, 2026',
    description: 'Role-based access control with secure phone authentication, session lifecycle guards, and stakeholder role-gated visibility.',
    details: 'Enforces strict role boundaries for field agents, operational staff, and executive stakeholders.',
  },
  {
    id: 'welile-signages',
    title: 'Welile Signages Management',
    category: 'Receipts & Signages',
    status: 'Completed',
    date: 'Oct 30, 2026',
    description: 'Field signage submissions, pipeline status filtering (Submitted/Pending, Approved, Declined), and My Spot active locations.',
    details: 'Real-time signage review pipeline with strict validation and live status telemetry.',
  },
  {
    id: 'digital-receipts',
    title: 'Digital Receipt Generation & Audit Logs',
    category: 'Receipts & Signages',
    status: 'Completed',
    date: 'Oct 24, 2026',
    description: 'Tamper-evident digital receipts, QR verification anchors, automated ledger synchronisation, and immutable audit logs.',
    details: 'Instant receipt verification with offline checksum verification.',
  },
  {
    id: 'test-suites',
    title: 'Automated Test Suites',
    category: 'Security & QA',
    status: 'Completed',
    date: 'Oct 30, 2026',
    description: 'Comprehensive Vitest automation asserting signage submission states, status normalization, and regression protection (welileSignages.test.ts).',
    details: '100% test pass rate across core signage and receipt evaluation matrices.',
  },
  {
    id: 'ledger-guard',
    title: 'Front-end Ledger Write Protection',
    category: 'Security & QA',
    status: 'Completed',
    date: 'Oct 20, 2026',
    description: 'Automated build-time guards restricting ledger updates exclusively to SECURITY DEFINER database procedures.',
    details: 'Prevents client-side balance manipulation or unauthorized ledger posting.',
  },
  {
    id: 'mobile-optimization',
    title: 'Mobile Field Optimization',
    category: 'Agent App',
    status: 'In QA',
    date: 'Nov 05, 2026',
    description: 'PWA caching, low-bandwidth optimizations, offline receipt drafting, and lightweight touch interaction for field agents.',
    details: 'Engineered specifically for low-connectivity field environments in Uganda.',
  },
  {
    id: 'agent-gps',
    title: 'Agent Field Signage GPS & Map Tracking',
    category: 'Agent App',
    status: 'In QA',
    date: 'Nov 08, 2026',
    description: 'Interactive geospatial mapping for physical signage installations and field inspection routes.',
    details: 'Allows operational leads to inspect geographical coverage of physical Welile branding.',
  },
  {
    id: 'prod-launch',
    title: 'Production Launch',
    category: 'Core',
    status: 'Planned',
    date: 'Nov 15, 2026',
    description: 'Multi-region production rollout, real-time telemetry monitoring, and executive stakeholder handover.',
    details: 'Final milestone unlocking broad commercial roll-out for all tenant and agent networks.',
  },
];

export const CATEGORIES: MilestoneCategory[] = [
  'All',
  'Core',
  'Receipts & Signages',
  'Agent App',
  'Security & QA',
];

export default function RDProjectTracker() {
  const completedCount = MILESTONES.filter((m) => m.status === 'Completed').length;
  const totalCount = MILESTONES.length;
  const progressPercent = Math.round((completedCount / totalCount) * 100);

  return (
    <div className="space-y-6 pb-8">
      {/* 1. Executive Header with Read-Only Badge */}
      <div className="relative overflow-hidden rounded-2xl border border-border/80 bg-gradient-to-br from-card via-card to-primary/5 p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                R&amp;D Oversight Portal • Read-Only Mode
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/50 px-2.5 py-1 text-[11px] font-mono text-muted-foreground">
                <Lock className="h-3 w-3" />
                Protected View
              </span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              Welile Homes R&amp;D Project Tracker
            </h1>
            <p className="text-xs text-muted-foreground sm:text-sm">
              Real-time engineering milestone telemetry, automated test health, and sprint deliverable tracking.
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-3 rounded-xl border border-border/80 bg-background/80 p-3 backdrop-blur sm:p-4">
            <div className="text-right">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Sprint Progress
              </div>
              <div className="text-2xl font-black text-primary">{progressPercent}%</div>
              <div className="text-[10px] font-mono text-muted-foreground">Build v2.4.0-prod</div>
            </div>
            <div className="h-10 w-px bg-border" />
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <CheckCircle2 className="h-5 w-5" />
            </div>
          </div>
        </div>

        <div className="mt-5 space-y-2">
          <div className="flex justify-between text-xs font-medium text-foreground">
            <span>Overall Sprint Completion</span>
            <span className="font-semibold text-primary">{completedCount} of {totalCount} Deliverables Finished ({progressPercent}%)</span>
          </div>
          <Progress value={progressPercent} className="h-2.5 w-full bg-muted" variant="default" />
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Sprint Kickoff (Oct 2026)</span>
            <span>Target Handover: Nov 15, 2026</span>
          </div>
        </div>
      </div>
    </div>
  );
}
