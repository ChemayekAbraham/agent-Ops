import React from 'react';

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
  return null;
}
