import { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ArrowLeftRight, RefreshCw } from 'lucide-react';
import { useCurrency, Currency } from '@/hooks/useCurrency';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { motion } from 'framer-motion';

// List of popular currencies for the converter
const popularCurrencies = [
  { code: 'UGX', symbol: 'UGX', name: 'Ugandan Shilling', flag: '🇺🇬', rate: 1 },
  { code: 'USD', symbol: '$', name: 'US Dollar', flag: '🇺🇸', rate: 0.00027 },
  { code: 'EUR', symbol: '€', name: 'Euro', flag: '🇪🇺', rate: 0.00025 },
  { code: 'GBP', symbol: '£', name: 'British Pound', flag: '🇬🇧', rate: 0.00021 },
  { code: 'KES', symbol: 'KSh', name: 'Kenyan Shilling', flag: '🇰🇪', rate: 0.035 },
  { code: 'TZS', symbol: 'TSh', name: 'Tanzanian Shilling', flag: '🇹🇿', rate: 0.68 },
  { code: 'RWF', symbol: 'FRw', name: 'Rwandan Franc', flag: '🇷🇼', rate: 0.35 },
  { code: 'ZAR', symbol: 'R', name: 'South African Rand', flag: '🇿🇦', rate: 0.0049 },
  { code: 'NGN', symbol: '₦', name: 'Nigerian Naira', flag: '🇳🇬', rate: 0.42 },
  { code: 'GHS', symbol: '₵', name: 'Ghanaian Cedi', flag: '🇬🇭', rate: 0.0042 },
  { code: 'INR', symbol: '₹', name: 'Indian Rupee', flag: '🇮🇳', rate: 0.023 },
  { code: 'CNY', symbol: '¥', name: 'Chinese Yuan', flag: '🇨🇳', rate: 0.0019 },
  { code: 'AED', symbol: 'د.إ', name: 'UAE Dirham', flag: '🇦🇪', rate: 0.00099 },
  { code: 'SAR', symbol: '﷼', name: 'Saudi Riyal', flag: '🇸🇦', rate: 0.001 },
];

interface CurrencyConverterProps {
  variant?: 'full' | 'compact';
}

export const CurrencyConverter: React.FC<CurrencyConverterProps> = ({ variant = 'full' }) => {
  const { currency: currentCurrency } = useCurrency();
  const [amount, setAmount] = useState<string>('100000');
  const [fromCurrency, setFromCurrency] = useState<string>('UGX');
  const [toCurrency, setToCurrency] = useState<string>('USD');

  const convertedAmount = useMemo(() => {
    const numAmount = parseFloat(amount.replace(/,/g, '')) || 0;
    const fromRate = popularCurrencies.find(c => c.code === fromCurrency)?.rate || 1;
    const toRate = popularCurrencies.find(c => c.code === toCurrency)?.rate || 1;
    
    // Convert to UGX first, then to target currency
    const amountInUGX = numAmount / fromRate;
    const result = amountInUGX * toRate;
    
    return result;
  }, [amount, fromCurrency, toCurrency]);

  const handleSwap = () => {
    setFromCurrency(toCurrency);
    setToCurrency(fromCurrency);
  };

  const formatNumber = (num: number) => {
    if (num >= 1000000) {
      return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
    return num.toLocaleString('en-US', { maximumFractionDigits: 4 });
  };

  const fromSymbol = popularCurrencies.find(c => c.code === fromCurrency)?.symbol || '';
  const toSymbol = popularCurrencies.find(c => c.code === toCurrency)?.symbol || '';

  if (variant === 'compact') {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <Input
              type="text"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="Amount"
              className="text-sm"
            />
          </div>
          <Select value={fromCurrency} onValueChange={setFromCurrency}>
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {popularCurrencies.map(c => (
                <SelectItem key={c.code} value={c.code}>
                  {c.flag} {c.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        
        <div className="flex items-center justify-center">
          <Button variant="ghost" size="icon" onClick={handleSwap}>
            <ArrowLeftRight className="h-4 w-4" />
          </Button>
        </div>
        
        <div className="flex items-center gap-2">
          <div className="flex-1 p-2 rounded-lg bg-muted/50 text-center font-mono font-semibold text-sm">
            {toSymbol} {formatNumber(convertedAmount)}
          </div>
          <Select value={toCurrency} onValueChange={setToCurrency}>
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {popularCurrencies.map(c => (
                <SelectItem key={c.code} value={c.code}>
                  {c.flag} {c.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    );
  }

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <RefreshCw className="h-4 w-4 text-primary" />
          Currency Converter
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* From */}
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">From</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                {fromSymbol}
              </span>
              <Input
                type="text"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                className="pl-10"
              />
            </div>
            <Select value={fromCurrency} onValueChange={setFromCurrency}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {popularCurrencies.map(c => (
                  <SelectItem key={c.code} value={c.code}>
                    <span className="flex items-center gap-2">
                      <span>{c.flag}</span>
                      <span>{c.code}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Swap Button */}
        <div className="flex justify-center">
          <Button 
            variant="outline" 
            size="icon" 
            onClick={handleSwap}
            className="rounded-full h-10 w-10"
          >
            <ArrowLeftRight className="h-4 w-4" />
          </Button>
        </div>

        {/* To */}
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">To</label>
          <div className="flex gap-2">
            <motion.div 
              key={convertedAmount}
              initial={{ opacity: 0.5, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex-1 flex items-center px-3 py-2 rounded-md border bg-muted/30"
            >
              <span className="text-muted-foreground text-sm mr-2">{toSymbol}</span>
              <span className="font-mono font-bold text-lg">
                {formatNumber(convertedAmount)}
              </span>
            </motion.div>
            <Select value={toCurrency} onValueChange={setToCurrency}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {popularCurrencies.map(c => (
                  <SelectItem key={c.code} value={c.code}>
                    <span className="flex items-center gap-2">
                      <span>{c.flag}</span>
                      <span>{c.code}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Rate Info */}
        <div className="text-center text-xs text-muted-foreground pt-2 border-t">
          1 {fromCurrency} = {formatNumber(popularCurrencies.find(c => c.code === toCurrency)!.rate / popularCurrencies.find(c => c.code === fromCurrency)!.rate)} {toCurrency}
        </div>
      </CardContent>
    </Card>
  );
};
