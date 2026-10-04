import { useState } from 'react';
import { useCurrency } from '@/hooks/useCurrency';

interface CompactAmountProps {
  value: number;
  className?: string;
}

export function CompactAmount({ value, className = '' }: CompactAmountProps) {
  const [showFull, setShowFull] = useState(false);
  const { formatAmount, formatAmountCompact } = useCurrency();

  return (
    <span
      className={`cursor-pointer border-b border-dotted border-current/40 transition-opacity hover:opacity-80 ${className}`}
      onClick={(e) => { e.stopPropagation(); setShowFull(prev => !prev); }}
      title={showFull ? 'Tap for compact' : 'Tap for full amount'}
    >
      {showFull ? formatAmount(value) : formatAmountCompact(value)}
    </span>
  );
}
