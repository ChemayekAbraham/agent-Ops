import { useState, useEffect } from 'react';
import { Clock, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface FlashSaleCountdownProps {
  endDate: string;
  compact?: boolean;
}

interface TimeLeft {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  expired: boolean;
}

const calculateTimeLeft = (endDate: string): TimeLeft => {
  const difference = new Date(endDate).getTime() - new Date().getTime();
  
  if (difference <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, expired: true };
  }

  return {
    days: Math.floor(difference / (1000 * 60 * 60 * 24)),
    hours: Math.floor((difference / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((difference / 1000 / 60) % 60),
    seconds: Math.floor((difference / 1000) % 60),
    expired: false,
  };
};

export function FlashSaleCountdown({ endDate, compact = false }: FlashSaleCountdownProps) {
  const [timeLeft, setTimeLeft] = useState<TimeLeft>(() => calculateTimeLeft(endDate));

  useEffect(() => {
    const timer = setInterval(() => {
      const newTimeLeft = calculateTimeLeft(endDate);
      setTimeLeft(newTimeLeft);
      
      if (newTimeLeft.expired) {
        clearInterval(timer);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [endDate]);

  if (timeLeft.expired) {
    return null;
  }

  const formatNumber = (num: number) => num.toString().padStart(2, '0');

  if (compact) {
    // Compact version for ProductCard
    const timeString = timeLeft.days > 0
      ? `${timeLeft.days}d ${formatNumber(timeLeft.hours)}h`
      : `${formatNumber(timeLeft.hours)}:${formatNumber(timeLeft.minutes)}:${formatNumber(timeLeft.seconds)}`;

    return (
      <Badge 
        variant="outline" 
        className="bg-gradient-to-r from-amber-500/20 to-orange-500/20 border-amber-500/50 text-amber-600 dark:text-amber-400 gap-1 animate-pulse"
      >
        <Zap className="h-3 w-3 fill-current" />
        {timeString}
      </Badge>
    );
  }

  // Full version for ProductDetailDialog
  return (
    <div className="flex flex-col gap-2 p-3 rounded-lg bg-gradient-to-r from-amber-500/10 to-orange-500/10 border border-amber-500/30">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
          <Zap className="h-4 w-4 fill-current animate-pulse" />
          <span className="font-bold text-sm uppercase tracking-wide">Flash Sale</span>
        </div>
        <div className="flex items-center gap-1 text-muted-foreground ml-auto">
          <Clock className="h-3.5 w-3.5" />
          <span className="text-xs">Ends in</span>
        </div>
      </div>
      <div className="flex items-center justify-center gap-1">
        {timeLeft.days > 0 && (
          <>
            <TimeBlock value={timeLeft.days} label="Days" />
            <TimeSeparator />
          </>
        )}
        <TimeBlock value={timeLeft.hours} label="Hours" />
        <TimeSeparator />
        <TimeBlock value={timeLeft.minutes} label="Mins" />
        <TimeSeparator />
        <TimeBlock value={timeLeft.seconds} label="Secs" highlight />
      </div>
    </div>
  );
}

function TimeBlock({ value, label, highlight = false }: { value: number; label: string; highlight?: boolean }) {
  return (
    <div className="flex flex-col items-center">
      <div 
        className={`
          text-xl font-bold tabular-nums min-w-[2.5rem] text-center px-2 py-1 rounded
          ${highlight 
            ? 'bg-destructive text-destructive-foreground' 
            : 'bg-background text-foreground'
          }
        `}
      >
        {value.toString().padStart(2, '0')}
      </div>
      <span className="text-[10px] text-muted-foreground uppercase mt-0.5">{label}</span>
    </div>
  );
}

function TimeSeparator() {
  return <span className="text-xl font-bold text-muted-foreground pb-4">:</span>;
}
