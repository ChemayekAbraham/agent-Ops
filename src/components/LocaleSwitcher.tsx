import React from 'react';
import { Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { LanguageSwitcher } from './LanguageSwitcher';
import { CurrencySwitcher } from './CurrencySwitcher';
import { useLanguage } from '@/hooks/useLanguage';
import { useCurrency } from '@/hooks/useCurrency';
import { languageFlags } from '@/i18n/translations';

interface LocaleSwitcherProps {
  variant?: 'default' | 'compact' | 'combined';
  className?: string;
}

export const LocaleSwitcher: React.FC<LocaleSwitcherProps> = ({ 
  variant = 'default',
  className = '' 
}) => {
  const { language } = useLanguage();
  const { currency } = useCurrency();

  if (variant === 'compact') {
    return (
      <div className={`flex items-center gap-1 ${className}`}>
        <LanguageSwitcher variant="compact" />
        <CurrencySwitcher variant="compact" />
      </div>
    );
  }

  if (variant === 'combined') {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button 
            variant="ghost" 
            size="sm" 
            className={`gap-1.5 h-8 px-2 rounded-lg ${className}`}
            aria-label="Locale settings"
          >
            <Globe className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{languageFlags[language]}</span>
            <span className="text-[10px] opacity-75">{currency.code}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-4 rounded-2xl shadow-xl border-border/50" align="end">
          <div className="space-y-5">
            <div>
              <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2.5 block">
                Language
              </label>
              <LanguageSwitcher />
            </div>
            <div className="border-t border-border/50 pt-4">
              <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2.5 block">
                Currency
              </label>
              <CurrencySwitcher />
            </div>
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <LanguageSwitcher />
      <CurrencySwitcher />
    </div>
  );
};
