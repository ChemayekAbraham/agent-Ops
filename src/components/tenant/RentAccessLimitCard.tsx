import { useState, useEffect } from 'react';
import { Wallet, ChevronRight } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface RentAccessLimitCardProps {
  userId: string;
}

const formatShort = (amount: number): string => {
  if (amount >= 1000000) return `${(amount / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (amount >= 1000) return `${(amount / 1000).toFixed(0)}K`;
  return amount.toString();
};

export function RentAccessLimitCard({ userId }: RentAccessLimitCardProps) {
  const [limit, setLimit] = useState({ availableLimit: 0, usedLimit: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLimit({ availableLimit: 0, usedLimit: 0 });
    setLoading(false);
  }, [userId]);

  const remainingLimit = limit.availableLimit - limit.usedLimit;

  if (loading) {
    return <div className="h-10 rounded-xl bg-muted/50 animate-pulse" />;
  }

  return (
    <p className="text-xs text-primary font-medium cursor-pointer active:opacity-70">
      💰 Tap to check your rent fee limit
    </p>
  );
}