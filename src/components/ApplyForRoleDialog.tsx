import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Home, Users, Building2, Loader2, CheckCircle2, Clock, ShieldCheck } from 'lucide-react';
import type { AppRole } from '@/hooks/auth/types';

interface ApplyForRoleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: AppRole | null;
  hasApplied: boolean;
  onApply: (role: AppRole, reason?: string) => Promise<{ error: Error | null }>;
}

const roleInfo: Record<string, { label: string; icon: React.ReactNode; description: string }> = {
  tenant: {
    label: 'Tenant',
    icon: <Home className="h-6 w-6 text-primary" />,
    description: 'Access the tenant dashboard to manage your rent, view landlord details, and track payments.',
  },
  agent: {
    label: 'Agent',
    icon: <Users className="h-6 w-6 text-warning" />,
    description: 'Become a field agent to register tenants, collect rent, and earn commissions.',
  },
  landlord: {
    label: 'Landlord',
    icon: <Building2 className="h-6 w-6 text-accent" />,
    description: 'Access the landlord dashboard to manage your properties and receive rent payments.',
  },
};

export default function ApplyForRoleDialog({ open, onOpenChange, role, hasApplied, onApply }: ApplyForRoleDialogProps) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  const info = role ? roleInfo[role] : null;

  const handleApply = async () => {
    if (!role) return;
    setSubmitting(true);
    const { error } = await onApply(role, reason.trim() || undefined);
    setSubmitting(false);
    if (!error) {
      setSuccess(true);
      setTimeout(() => {
        setSuccess(false);
        setReason('');
        onOpenChange(false);
      }, 2000);
    }
  };

  if (!role || !info) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!submitting) { onOpenChange(v); setSuccess(false); setReason(''); } }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {info.icon}
            Apply for {info.label} Role
          </DialogTitle>
          <DialogDescription className="text-sm">
            {info.description}
          </DialogDescription>
        </DialogHeader>

        {hasApplied ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center gap-3 py-4"
          >
            <div className="w-14 h-14 rounded-full bg-warning/20 flex items-center justify-center">
              <Clock className="h-7 w-7 text-warning" />
            </div>
            <p className="font-semibold text-center">Application Pending</p>
            <p className="text-sm text-muted-foreground text-center">
              Your request to access the {info.label} dashboard is being reviewed by a manager. You'll be notified once approved.
            </p>
          </motion.div>
        ) : success ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center gap-3 py-4"
          >
            <div className="w-14 h-14 rounded-full bg-success/20 flex items-center justify-center">
              <CheckCircle2 className="h-7 w-7 text-success" />
            </div>
            <p className="font-semibold text-center">Application Submitted!</p>
            <p className="text-sm text-muted-foreground text-center">
              A manager will review and grant you access soon.
            </p>
          </motion.div>
        ) : (
          <div className="space-y-4">
            <div className="bg-muted/50 border border-border/50 rounded-xl p-3 flex items-start gap-2">
              <ShieldCheck className="h-4 w-4 text-primary mt-0.5 shrink-0" />
              <p className="text-xs text-muted-foreground">
                As a qualified investor with deployed capital, role access requires manager approval. This ensures platform security.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Why do you need this role? (optional)</label>
              <Textarea
                placeholder={`Tell us why you'd like access to the ${info.label} dashboard...`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="resize-none h-20"
              />
            </div>

            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1">
                Cancel
              </Button>
              <Button onClick={handleApply} disabled={submitting} className="flex-1 gap-2">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {submitting ? 'Submitting...' : 'Apply'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
