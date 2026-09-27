import {
  CalendarDays,
  GitBranch,
  MapPin,
  Phone,
  Sun,
  UserCog,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

export type WorkspaceSectionId =
  | 'today'
  | 'collections'
  | 'calling'
  | 'tenants'
  | 'agents'
  | 'places'
  | 'pipeline'
  | 'weekly';

export interface WorkspaceNavSection {
  id: WorkspaceSectionId;
  label: string;
  icon: LucideIcon;
  description: string;
}

export const WORKSPACE_NAV_SECTIONS: WorkspaceNavSection[] = [
  {
    id: 'today',
    label: 'Today',
    icon: Sun,
    description: "What's due, what's overdue, and what needs attention right now.",
  },
  {
    id: 'collections',
    label: 'Collections',
    icon: Wallet,
    description: 'Expected vs collected, on-schedule vs arrears — capped and honest.',
  },
  {
    id: 'calling',
    label: 'Calling',
    icon: Phone,
    description: 'Who to call next, ranked by money at risk.',
  },
  {
    id: 'tenants',
    label: 'Tenants',
    icon: Users,
    description: "Every tenant's plan position — on track, behind, or ahead.",
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: UserCog,
    description: "Agent accountability: who's collecting, who isn't.",
  },
  {
    id: 'places',
    label: 'Places',
    icon: MapPin,
    description: 'Where the risk is, by location.',
  },
  {
    id: 'pipeline',
    label: 'Pipeline',
    icon: GitBranch,
    description: 'Plans moving through funding, disbursement and repayment start.',
  },
  {
    id: 'weekly',
    label: 'Weekly',
    icon: CalendarDays,
    description: 'The Wed→Tue reporting week, trended over time.',
  },
];
