/**
 * Shared navigation entries for My Space.
 *
 * Presentation-only: this is the single list used by both the My Space hub cards
 * and the My Space side menu, so the menu can never offer a destination the hub
 * does not already offer. No access logic lives here — routing guards continue to
 * decide who may open each route, exactly as before.
 */
import {
  FileText,
  Briefcase,
  User,
  Bell,
  FolderOpen,
  Ticket,
  PhoneIncoming,
  Wallet,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';

export interface PersonalNavItem {
  to: string;
  icon: LucideIcon;
  title: string;
  description: string;
  requiresPsoOfficer?: boolean;
  requiresStaff?: boolean;
}

export const PERSONAL_NAV: PersonalNavItem[] = [
  { to: '/your-profile', icon: User, title: 'My profile', description: 'Your personal details' },
  { to: '/me/payslips', icon: FileText, title: 'My payslips', description: 'Your own pay records' },
  { to: '/me/work', icon: Briefcase, title: 'My work', description: 'Tasks assigned to you' },
  {
    to: '/me/concerns',
    icon: PhoneIncoming,
    title: 'Concerns',
    description: 'Caller concerns forwarded to you from the Calling Center',
    requiresStaff: true,
  },
  { to: '/me/performance', icon: TrendingUp, title: 'My performance', description: 'Your notes, your cohort', requiresPsoOfficer: true },
  { to: '/me/tickets', icon: Ticket, title: 'Tickets', description: 'Raise a fault or pick one up' },
  {
    to: '/me/requisitions',
    icon: Wallet,
    title: 'Make a requisition',
    description: 'Ask for funds — reviewed by your head, COO, then CFO',
  },
  { to: '/notifications', icon: Bell, title: 'Notifications', description: 'Messages and alerts' },
  {
    to: '/me/documents',
    icon: FolderOpen,
    title: 'My documents',
    description: 'Your contracts, letters and certificates',
  },
];
