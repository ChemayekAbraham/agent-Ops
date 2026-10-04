import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  UserPlus, 
  Bell, 
  MessageCircle, 
  UserCog, 
  Download,
  Users,
  Sparkles,
  Home,
  Briefcase,
  ChevronDown
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { hapticTap } from '@/lib/haptics';

interface QuickUserActionsProps {
  totalUsers: number;
  selectedCount: number;
  onNotifyAll: () => void;
  onWhatsAppAll: () => void;
  onExport: () => void;
  onExportByRole?: (role: 'tenant' | 'agent' | 'landlord') => void;
  onAddUser: () => void;
}

export function QuickUserActions({
  totalUsers,
  selectedCount,
  onNotifyAll,
  onWhatsAppAll,
  onExport,
  onExportByRole,
  onAddUser
}: QuickUserActionsProps) {
  const [showExportOptions, setShowExportOptions] = useState(false);

  const actions = [
    {
      icon: UserPlus,
      label: 'Add User',
      onClick: onAddUser,
      variant: 'primary' as const,
      description: 'Register new user'
    },
    {
      icon: Bell,
      label: 'Notify',
      onClick: onNotifyAll,
      variant: 'warning' as const,
      description: selectedCount > 0 ? `${selectedCount} selected` : 'All users'
    },
    {
      icon: MessageCircle,
      label: 'WhatsApp',
      onClick: onWhatsAppAll,
      variant: 'success' as const,
      description: 'Send message'
    },
    {
      icon: Download,
      label: 'Export',
      onClick: () => {
        hapticTap();
        setShowExportOptions(!showExportOptions);
      },
      variant: 'default' as const,
      description: 'Download list',
      noHaptic: true
    },
  ];

  const handleClick = (action: typeof actions[0]) => {
    if (!action.noHaptic) hapticTap();
    action.onClick();
  };

  const exportOptions = [
    { label: 'All Users', icon: Users, onClick: onExport },
    { label: 'Tenants Only', icon: Users, onClick: () => onExportByRole?.('tenant') },
    { label: 'Agents Only', icon: Briefcase, onClick: () => onExportByRole?.('agent') },
    { label: 'Landlords Only', icon: Home, onClick: () => onExportByRole?.('landlord') },
  ];

  return (
    <Card className="border-2 border-primary/20 bg-gradient-to-br from-primary/5 via-background to-success/5">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-xl bg-primary/20">
              <Sparkles className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h3 className="font-bold text-base">Quick Actions</h3>
              <p className="text-xs text-muted-foreground">Manage users easily</p>
            </div>
          </div>
          <Badge variant="outline" className="text-sm font-semibold">
            <Users className="h-3.5 w-3.5 mr-1.5" />
            {totalUsers}
          </Badge>
        </div>

        <div className="grid grid-cols-4 gap-2">
          {actions.map((action, index) => {
            const Icon = action.icon;
            const bgColor = {
              primary: 'bg-primary/15 hover:bg-primary/25 border-primary/30',
              success: 'bg-success/15 hover:bg-success/25 border-success/30',
              warning: 'bg-warning/15 hover:bg-warning/25 border-warning/30',
              default: 'bg-muted/50 hover:bg-muted border-border/50'
            }[action.variant];
            
            const textColor = {
              primary: 'text-primary',
              success: 'text-success',
              warning: 'text-warning',
              default: 'text-foreground'
            }[action.variant];

            return (
              <motion.button
                key={action.label}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: index * 0.05 }}
                onClick={() => handleClick(action)}
                className={`flex flex-col items-center justify-center gap-1 p-3 rounded-xl border transition-all active:scale-95 ${bgColor}`}
              >
                <Icon className={`h-6 w-6 ${textColor}`} />
                <span className={`text-xs font-semibold ${textColor}`}>{action.label}</span>
              </motion.button>
            );
          })}
        </div>

        {/* Export Options Dropdown */}
        <AnimatePresence>
          {showExportOptions && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-border/50">
                {exportOptions.map((option) => {
                  const OptIcon = option.icon;
                  return (
                    <motion.button
                      key={option.label}
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      onClick={() => {
                        hapticTap();
                        option.onClick();
                        setShowExportOptions(false);
                      }}
                      className="flex items-center gap-2 p-2.5 rounded-lg bg-muted/50 hover:bg-muted border border-border/50 transition-all active:scale-95"
                    >
                      <Download className="h-4 w-4 text-muted-foreground" />
                      <span className="text-xs font-medium">{option.label}</span>
                    </motion.button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}
