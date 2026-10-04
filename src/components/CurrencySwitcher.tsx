import React, { useState } from 'react';
import { DollarSign, Search, Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useCurrency, currencies, Currency } from '@/hooks/useCurrency';

interface CurrencySwitcherProps {
  variant?: 'default' | 'compact';
  className?: string;
}

// Group currencies by region
const currencyRegions: { name: string; codes: string[] }[] = [
  { 
    name: 'Africa', 
    codes: ['UGX', 'KES', 'TZS', 'RWF', 'ETB', 'NGN', 'GHS', 'ZAR', 'EGP', 'MAD', 'XOF', 'XAF'] 
  },
  { 
    name: 'Americas', 
    codes: ['USD', 'CAD', 'MXN', 'BRL', 'ARS', 'COP'] 
  },
  { 
    name: 'Europe', 
    codes: ['EUR', 'GBP', 'CHF', 'SEK', 'NOK', 'PLN', 'TRY', 'RUB', 'UAH'] 
  },
  { 
    name: 'Asia', 
    codes: ['CNY', 'JPY', 'INR', 'PKR', 'BDT', 'IDR', 'MYR', 'PHP', 'THB', 'VND', 'KRW', 'SGD', 'HKD', 'TWD'] 
  },
  { 
    name: 'Middle East', 
    codes: ['AED', 'SAR', 'ILS', 'QAR', 'KWD'] 
  },
  { 
    name: 'Oceania', 
    codes: ['AUD', 'NZD'] 
  },
];

export const CurrencySwitcher: React.FC<CurrencySwitcherProps> = ({ 
  variant = 'default',
  className = '' 
}) => {
  const { currency, setCurrency } = useCurrency();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const filteredCurrencies = currencies.filter(c => 
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.code.toLowerCase().includes(search.toLowerCase())
  );

  const handleSelect = (selected: Currency) => {
    setCurrency(selected);
    setOpen(false);
    setSearch('');
  };

  const getCurrenciesByRegion = (codes: string[]) => {
    return filteredCurrencies.filter(c => codes.includes(c.code));
  };

  if (variant === 'compact') {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button 
            variant="ghost" 
            size="icon" 
            className={`h-9 w-9 ${className}`}
            aria-label="Select currency"
          >
            <span className="text-sm font-medium">{currency.symbol}</span>
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-md max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5" />
              Select Currency
            </DialogTitle>
          </DialogHeader>
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search currencies..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10"
            />
          </div>
          <ScrollArea className="h-[400px] pr-4">
            {currencyRegions.map(region => {
              const regionCurrencies = getCurrenciesByRegion(region.codes);
              if (regionCurrencies.length === 0) return null;
              
              return (
                <div key={region.name} className="mb-4">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-2">
                    {region.name}
                  </h4>
                  <div className="space-y-1">
                    {regionCurrencies.map(c => (
                      <button
                        key={c.code}
                        onClick={() => handleSelect(c)}
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                          currency.code === c.code 
                            ? 'bg-primary/10 text-primary' 
                            : 'hover:bg-muted'
                        }`}
                      >
                        <span className="text-lg">{c.flag}</span>
                        <div className="flex-1 text-left">
                          <div className="font-medium text-sm">{c.code}</div>
                          <div className="text-xs text-muted-foreground">{c.name}</div>
                        </div>
                        <span className="text-sm font-mono text-muted-foreground">{c.symbol}</span>
                        {currency.code === c.code && (
                          <Check className="h-4 w-4 text-primary" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button 
          variant="outline" 
          size="sm" 
          className={`gap-2 ${className}`}
          aria-label="Select currency"
        >
          <span className="text-base">{currency.flag}</span>
          <span className="font-medium">{currency.code}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            Select Your Currency
          </DialogTitle>
        </DialogHeader>
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search currencies..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <ScrollArea className="h-[400px] pr-4">
          {currencyRegions.map(region => {
            const regionCurrencies = getCurrenciesByRegion(region.codes);
            if (regionCurrencies.length === 0) return null;
            
            return (
              <div key={region.name} className="mb-4">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-2">
                  {region.name}
                </h4>
                <div className="space-y-1">
                  {regionCurrencies.map(c => (
                    <button
                      key={c.code}
                      onClick={() => handleSelect(c)}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                        currency.code === c.code 
                          ? 'bg-primary/10 text-primary' 
                          : 'hover:bg-muted'
                      }`}
                    >
                      <span className="text-lg">{c.flag}</span>
                      <div className="flex-1 text-left">
                        <div className="font-medium text-sm">{c.code}</div>
                        <div className="text-xs text-muted-foreground">{c.name}</div>
                      </div>
                      <span className="text-sm font-mono text-muted-foreground">{c.symbol}</span>
                      {currency.code === c.code && (
                        <Check className="h-4 w-4 text-primary" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};
