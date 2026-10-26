import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { userBehaviourTracker } from '@/lib/userBehaviourTracker';
import { User } from '@supabase/supabase-js';
import {
  Wallet,
  Building2,
  Home,
  DoorOpen,
  Banknote,
  BadgeCheck,
  ArrowRight,
  Receipt,
  History,
  Users,
  Share2,
  Download,
  HelpCircle,
  ScrollText,
  PiggyBank,
  FileText,
  Gift,
} from 'lucide-react';
import { AppRole } from '@/hooks/useAuth';
import { ReactNode } from 'react';
import DashboardHeader from '@/components/DashboardHeader';
import AiIdButton from '@/components/ai-id/AiIdButton';
import { AgentNotificationBell } from '@/components/agent/AgentNotificationBell';

import { useProfile } from '@/hooks/useProfile';
import { UserAvatar } from '@/components/UserAvatar';
import { WelileHomesLandlordBadge } from '@/components/landlord/WelileHomesLandlordBadge';
import RegisterPropertyDialog from '@/components/landlord/RegisterPropertyDialog';
import { LandlordRegisterHouseCard } from '@/components/landlord/LandlordRegisterHouseCard';
import { FullScreenWalletSheet } from '@/components/wallet/FullScreenWalletSheet';
import { WalletDisclaimer } from '@/components/wallet/WalletDisclaimer';
import { UnifiedWalletHeroCard } from '@/components/wallet/UnifiedWalletHeroCard';
import { MyPropertiesSheet } from '@/components/landlord/MyPropertiesSheet';
import { AvailableHousesSheet } from '@/components/tenant/AvailableHousesSheet';
import { useWallet } from '@/hooks/useWallet';
import { useLandlordStats } from '@/hooks/useLandlordStats';
import { formatUGX } from '@/lib/rentCalculations';
import { motion } from 'framer-motion';
import { hapticTap } from '@/lib/haptics';
import { Skeleton } from '@/components/ui/skeleton';
import { InviteAndEarnCard } from '@/components/shared/InviteAndEarnCard';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { FunderQuickActions } from '@/components/supporter/FunderQuickActions';
import { MissionBanner } from '@/components/mission/MissionBanner';
import { useTrackSection } from '@/hooks/useTrackSection';

interface LandlordDashboardProps {
  user: User;
  signOut: () => Promise<void>;
  currentRole: AppRole;
  availableRoles: AppRole[];
  onRoleChange: (role: AppRole) => void;
  addRoleComponent: ReactNode;
}

export default function LandlordDashboard({ user, signOut, currentRole, availableRoles, onRoleChange, addRoleComponent }: LandlordDashboardProps) {
  // Behaviour telemetry tracking
  useTrackSection('landlord-overview', 'landlord');

  const navigate = useNavigate();
  const { profile } = useProfile();
  const { wallet, refreshWallet } = useWallet();
  const { stats: landlordStats, loading: statsLoading, refreshStats } = useLandlordStats(user.id);
  const [registerPropertyOpen, setRegisterPropertyOpen] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
  const [showProperties, setShowProperties] = useState(false);
  const [showListedHouses, setShowListedHouses] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  // Dynamic telemetry tracking across landlord sheets
  useEffect(() => {
    if (showWallet) {
      userBehaviourTracker.setSection('landlord-wallet', 'landlord');
    } else if (showProperties) {
      userBehaviourTracker.setSection('landlord-properties', 'landlord');
    } else if (registerPropertyOpen) {
      userBehaviourTracker.setSection('landlord-register-property', 'landlord');
    } else if (showListedHouses) {
      userBehaviourTracker.setSection('landlord-listed-houses', 'landlord');
    } else {
      userBehaviourTracker.setSection('landlord-overview', 'landlord');
    }
  }, [showWallet, showProperties, registerPropertyOpen, showListedHouses]);

  const handleRefresh = async () => {
    await Promise.all([refreshWallet(), refreshStats()]);
  };

  const handleViewWallet = () => { hapticTap(); setShowWallet(true); };
  const handleOpenRegisterProperty = () => { hapticTap(); setRegisterPropertyOpen(true); };

  const goTo = (path: string) => () => { hapticTap(); navigate(path); };

  // Top-right menu, below "Your Profile". These are the former "Menu" drawer items, one
  // row each; `separator` starts a new group where the drawer started a new section.
  // (The drawer's "Settings" row is omitted: the menu already ends with Settings.)
  const menuItems = [
    { icon: Building2, label: 'Register Property', onClick: () => setRegisterPropertyOpen(true) },
    // Property management
    { icon: DoorOpen, label: 'Daily Rent Listings', badge: 'Daily Rent', separator: true, onClick: () => { hapticTap(); setShowListedHouses(true); } },
    { icon: Users, label: 'My Tenants', onClick: goTo('/landlord-welile-homes') },
    { icon: PiggyBank, label: 'Welile Homes Impact', onClick: goTo('/landlord-welile-homes') },
    // Finances
    { icon: Receipt, label: 'My Receipts', separator: true, onClick: goTo('/my-receipts') },
    { icon: Banknote, label: 'My Loans', onClick: goTo('/my-loans') },
    { icon: History, label: 'Payment History', onClick: goTo('/transactions') },
    { icon: FileText, label: 'Financial Statement', onClick: goTo('/financial-statement') },
    // Growth
    { icon: Gift, label: 'Invite & Earn', badge: 'UGX 100', separator: true, onClick: () => { hapticTap(); setInviteOpen(true); } },
    { icon: Receipt, label: 'Post Shopping Receipt', badge: 'Earn benefits', onClick: goTo('/my-receipts') },
    { icon: Users, label: 'My Referrals', onClick: goTo('/referrals') },
    { icon: Share2, label: 'Share & Earn', onClick: goTo('/benefits') },
    // More
    { icon: ScrollText, label: 'Landlord Agreement', separator: true, onClick: goTo('/landlord-agreement') },
    { icon: Download, label: 'Share App', onClick: goTo('/install') },
    { icon: HelpCircle, label: 'Help & Support', onClick: goTo('/settings') },
  ];

  return (
    <div className="h-[100dvh] bg-background flex flex-col overflow-hidden">
      <DashboardHeader
        currentRole={currentRole}
        availableRoles={availableRoles}
        onRoleChange={onRoleChange}
        onSignOut={signOut}
        menuItems={menuItems}
        headerActions={<AgentNotificationBell userId={user.id} />}
      />

      <div className="flex-1 overflow-y-auto pb-nav">
        <main className="px-4 py-5 space-y-5 animate-fade-in max-w-lg mx-auto">

          {/* Register your house — the page's major action. Same card, same size
              (min 300px, 360px from sm up) and same caption as the agent dashboard's
              "Post a rent request here". */}
          <div className="flex flex-col space-y-2">
            <LandlordRegisterHouseCard
              onOpen={handleOpenRegisterProperty}
              className="w-full min-h-[300px] sm:min-h-[360px]"
            />
            <p
              onClick={handleOpenRegisterProperty}
              className="text-xs sm:text-sm text-center text-muted-foreground font-medium shrink-0 pt-2 pb-0.5 select-none cursor-pointer"
            >
              and <span className="font-semibold text-green-600 dark:text-green-400">start earning guaranteed monthly rent</span>
            </p>
          </div>

          <MissionBanner dashboardRole="landlord" />

          <WalletDisclaimer />
        </main>
      </div>

      {/* Full-screen wallet sheet */}
      <FullScreenWalletSheet open={showWallet} onOpenChange={setShowWallet} />

      {/* Properties sheet */}
      <MyPropertiesSheet open={showProperties} onOpenChange={setShowProperties} userId={user.id} />

      {/* Invite & Earn: opened from the top-right menu. The card loads its stats and
          short link only while open. */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="max-w-sm p-4 pt-14 gap-0">
          <DialogTitle className="sr-only">Invite &amp; Earn</DialogTitle>
          <DialogDescription className="sr-only">
            Share your invite link with friends and earn for everyone who joins.
          </DialogDescription>
          <InviteAndEarnCard variant="landlord" />
        </DialogContent>
      </Dialog>

      {/* Dialogs */}
      <RegisterPropertyDialog
        open={registerPropertyOpen}
        onOpenChange={setRegisterPropertyOpen}
      />
      <AvailableHousesSheet open={showListedHouses} onOpenChange={setShowListedHouses} />

      {/* Fixed footer navigation */}
      
    </div>
  );
}
