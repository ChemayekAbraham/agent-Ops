import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { User } from '@supabase/supabase-js';
import { 
  Wallet, 
  Building2, 
  Menu,
  Home,
  DoorOpen,
  Banknote,
  BadgeCheck,
} from 'lucide-react';
import { AppRole } from '@/hooks/useAuth';
import { ReactNode } from 'react';
import DashboardHeader from '@/components/DashboardHeader';
import AiIdButton from '@/components/ai-id/AiIdButton';
import { AgentNotificationBell } from '@/components/agent/AgentNotificationBell';

import { useProfile } from '@/hooks/useProfile';
import { UserAvatar } from '@/components/UserAvatar';
import { WelileHomesLandlordBadge } from '@/components/landlord/WelileHomesLandlordBadge';
import { LandlordMenuDrawer } from '@/components/landlord/LandlordMenuDrawer';
import RegisterPropertyDialog from '@/components/landlord/RegisterPropertyDialog';
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
import { CreditAccessCard } from '@/components/CreditAccessCard';
import { InviteAndEarnCard } from '@/components/shared/InviteAndEarnCard';
import { VerificationChecklist } from '@/components/shared/VerificationChecklist';
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [registerPropertyOpen, setRegisterPropertyOpen] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
  const [showProperties, setShowProperties] = useState(false);
  const [showListedHouses, setShowListedHouses] = useState(false);

  const handleRefresh = async () => {
    await Promise.all([refreshWallet(), refreshStats()]);
  };

  const handleViewWallet = () => { hapticTap(); setShowWallet(true); };
  const handleOpenRegisterProperty = () => { hapticTap(); setRegisterPropertyOpen(true); };
  const handleOpenMenu = () => { hapticTap(); setMenuOpen(true); };

  const menuItems = [
    { icon: Building2, label: 'Register Property', onClick: () => setRegisterPropertyOpen(true) },
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

          <MissionBanner dashboardRole="landlord" />

          {/* Portfolio Hero Card */}
          <UnifiedWalletHeroCard
            balance={wallet?.balance ?? 0}
            role="landlord"
            secondaryLabel="Withdrawable"
            secondaryValue={formatUGX(wallet?.balance ?? 0)}
            onOpenWallet={handleViewWallet}
            quickActions={
              <FunderQuickActions
                variant="hero"
                availableBalance={wallet?.balance ?? 0}
                onChanged={() => { refreshWallet(); }}
              />
            }
          />

          {/* Verification Checklist */}
          <VerificationChecklist userId={user.id} highlightRole="landlord" compact />

          {/* Credit Access */}
          <CreditAccessCard userId={user.id} />

          {/* Action Buttons — Clean & Minimal */}
          <div className="space-y-2">
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider px-0.5">Actions</p>

            <button
              onClick={handleOpenRegisterProperty}
              className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl border border-border/60 bg-card hover:bg-muted/40 transition-colors touch-manipulation"
            >
              <Building2 className="h-5 w-5 text-primary shrink-0" />
              <div className="flex-1 text-left min-w-0">
                <p className="font-medium text-sm">Register Property</p>
                <p className="text-xs text-muted-foreground">Start earning guaranteed monthly rent</p>
              </div>
              <span className="text-xs text-muted-foreground">→</span>
            </button>

            <button
              onClick={handleOpenMenu}
              className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl border border-border/60 bg-card hover:bg-muted/40 transition-colors touch-manipulation"
            >
              <Menu className="h-5 w-5 text-foreground/70 shrink-0" />
              <div className="flex-1 text-left">
                <p className="font-medium text-sm">Menu</p>
                <p className="text-xs text-muted-foreground">Tenants, receipts, loans & more</p>
              </div>
              <span className="text-xs text-muted-foreground">→</span>
            </button>
          </div>

          {/* Invite & Earn */}
          <InviteAndEarnCard variant="landlord" />

          <WalletDisclaimer />
        </main>
      </div>

      {/* Full-screen wallet sheet */}
      <FullScreenWalletSheet open={showWallet} onOpenChange={setShowWallet} />

      {/* Properties sheet */}
      <MyPropertiesSheet open={showProperties} onOpenChange={setShowProperties} userId={user.id} />

      {/* Menu Drawer */}
      <LandlordMenuDrawer
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onViewListedHouses={() => { setMenuOpen(false); setShowListedHouses(true); }}
      />

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
