import { useState, useMemo } from 'react';
import { useCurrency } from '@/hooks/useCurrency';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useWallet } from '@/hooks/useWallet';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  Loader2, ShoppingCart, Plus, Trash2, CheckCircle2,
  ArrowLeft, Receipt, Phone, Search, Apple, Beef, Egg,
  Milk, Wheat, Fish, Cookie, Cherry
} from 'lucide-react';

interface FoodMarketDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface CartItem {
  id: string;
  name: string;
  quantity: number;
  price: number;
}

type Step = 'cart' | 'pay' | 'success';

const POPULAR_ITEMS = [
  { name: 'Rice (1kg)', icon: <Wheat className="h-4 w-4" />, price: 4000 },
  { name: 'Beans (1kg)', icon: <Cherry className="h-4 w-4" />, price: 3500 },
  { name: 'Sugar (1kg)', icon: <Cookie className="h-4 w-4" />, price: 4500 },
  { name: 'Cooking Oil (1L)', icon: <Milk className="h-4 w-4" />, price: 8000 },
  { name: 'Maize Flour (2kg)', icon: <Wheat className="h-4 w-4" />, price: 5000 },
  { name: 'Eggs (Tray)', icon: <Egg className="h-4 w-4" />, price: 12000 },
  { name: 'Chicken (1kg)', icon: <Beef className="h-4 w-4" />, price: 15000 },
  { name: 'Fish (Tilapia)', icon: <Fish className="h-4 w-4" />, price: 10000 },
  { name: 'Tomatoes (1kg)', icon: <Apple className="h-4 w-4" />, price: 3000 },
  { name: 'Onions (1kg)', icon: <Apple className="h-4 w-4" />, price: 3500 },
  { name: 'Milk (1L)', icon: <Milk className="h-4 w-4" />, price: 3000 },
  { name: 'Bread', icon: <Wheat className="h-4 w-4" />, price: 5000 },
];

export function FoodMarketDialog({ open, onOpenChange }: FoodMarketDialogProps) {
  const { user } = useAuth();
  const { wallet, refreshWallet } = useWallet();
  const [step, setStep] = useState<Step>('cart');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [itemName, setItemName] = useState('');
  const [itemPrice, setItemPrice] = useState('');
  const [itemQty, setItemQty] = useState('1');
  const [sellerPhone, setSellerPhone] = useState('');
  const [sellerName, setSellerName] = useState('');
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const { formatAmount: formatCurrency } = useCurrency();

  const total = useMemo(() => cart.reduce((sum, item) => sum + item.price * item.quantity, 0), [cart]);

  const filteredPopular = POPULAR_ITEMS.filter(item =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const addItem = () => {
    const price = parseFloat(itemPrice);
    const qty = parseInt(itemQty) || 1;
    if (!itemName.trim()) { toast.error('Enter item name'); return; }
    if (isNaN(price) || price <= 0) { toast.error('Enter a valid price'); return; }

    setCart(prev => [...prev, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: itemName.trim(),
      quantity: qty,
      price,
    }]);
    setItemName('');
    setItemPrice('');
    setItemQty('1');
  };

  const addPopularItem = (item: typeof POPULAR_ITEMS[0]) => {
    setCart(prev => {
      const existing = prev.find(c => c.name === item.name);
      if (existing) {
        return prev.map(c => c.name === item.name ? { ...c, quantity: c.quantity + 1 } : c);
      }
      return [...prev, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: item.name,
        quantity: 1,
        price: item.price,
      }];
    });
  };

  const removeItem = (id: string) => {
    setCart(prev => prev.filter(item => item.id !== id));
  };

  const updateQuantity = (id: string, qty: number) => {
    if (qty < 1) return removeItem(id);
    setCart(prev => prev.map(item => item.id === id ? { ...item, quantity: qty } : item));
  };

  const handlePay = async () => {
    if (!user) return;
    if (cart.length === 0) { toast.error('Add items to your cart'); return; }
    if (!sellerPhone.trim() || sellerPhone.replace(/\D/g, '').length < 9) {
      toast.error('Enter a valid seller phone number');
      return;
    }
    if ((wallet?.balance || 0) < total) {
      toast.error('Insufficient wallet balance');
      return;
    }

    setLoading(true);
    try {
      const itemsSummary = cart.map(i => `${i.name} x${i.quantity} @${i.price}`).join(', ');
      const refId = `SHOP-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const normalizedPhone = sellerPhone.replace(/\D/g, '').slice(-9);

      // Look up seller by phone
      const { data: sellerProfile } = await supabase
        .from('profiles')
        .select('id, full_name')
        .or(`phone.ilike.%${normalizedPhone},phone.ilike.%0${normalizedPhone},phone.ilike.%256${normalizedPhone}`)
        .maybeSingle();

      if (!sellerProfile) {
        toast.error('Seller not found on Welile. They must have an account.');
        setLoading(false);
        return;
      }

      if (sellerProfile.id === user.id) {
        toast.error('You cannot pay yourself');
        setLoading(false);
        return;
      }

      // Use wallet-transfer edge function for proper ledger-based transfer
      const { data, error } = await supabase.functions.invoke('wallet-transfer', {
        body: {
          recipient_phone: normalizedPhone,
          amount: total,
          description: `Food shopping: ${itemsSummary.slice(0, 200)}`,
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      await refreshWallet();
      setSellerName(sellerProfile.full_name || 'Seller');
      setStep('success');
      toast.success(`Payment of ${formatCurrency(total)} sent to ${sellerProfile.full_name || 'seller'}!`);
    } catch (error: any) {
      toast.error(error.message || 'Payment failed');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = (value: boolean) => {
    if (!value) {
      setStep('cart');
      setCart([]);
      setItemName('');
      setItemPrice('');
      setItemQty('1');
      setSellerPhone('');
      setSellerName('');
      setSearchQuery('');
    }
    onOpenChange(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto p-0">
        {step === 'success' ? (
          <div className="p-6 py-10 flex flex-col items-center justify-center text-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-success/20 flex items-center justify-center">
              <CheckCircle2 className="h-8 w-8 text-success" />
            </div>
            <p className="text-lg font-semibold">Payment Sent!</p>
            <p className="text-sm text-muted-foreground">
              {formatCurrency(total)} paid to <span className="font-medium text-foreground">{sellerName}</span> for {cart.length} item{cart.length > 1 ? 's' : ''}
            </p>
            <div className="w-full space-y-1 bg-muted/50 rounded-xl p-3 text-left">
              {cart.map(item => (
                <div key={item.id} className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{item.name} ×{item.quantity}</span>
                  <span className="font-medium">{formatCurrency(item.price * item.quantity)}</span>
                </div>
              ))}
              <div className="border-t border-border mt-2 pt-2 flex justify-between text-sm font-bold">
                <span>Total</span>
                <span>{formatCurrency(total)}</span>
              </div>
            </div>
            <Button onClick={() => handleClose(false)} className="w-full">Done</Button>
          </div>
        ) : step === 'pay' ? (
          <div className="p-4 space-y-4">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setStep('cart')}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <h2 className="font-bold text-lg">Pay Seller</h2>
            </div>

            {/* Order summary */}
            <div className="bg-muted/50 rounded-xl p-3 space-y-1.5">
              <div className="flex items-center gap-2 mb-2">
                <Receipt className="h-4 w-4 text-muted-foreground" />
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Order Summary</span>
              </div>
              {cart.map(item => (
                <div key={item.id} className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{item.name} ×{item.quantity}</span>
                  <span className="font-medium">{formatCurrency(item.price * item.quantity)}</span>
                </div>
              ))}
              <div className="border-t border-border mt-2 pt-2 flex justify-between font-bold text-base">
                <span>Total</span>
                <span className="text-primary">{formatCurrency(total)}</span>
              </div>
            </div>

            {/* Seller info */}
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Seller's Phone Number</Label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="tel"
                    placeholder="0771234567"
                    value={sellerPhone}
                    onChange={(e) => setSellerPhone(e.target.value)}
                    className="pl-10 text-lg"
                    maxLength={13}
                  />
                </div>
              </div>
            </div>

            <div className="text-xs text-muted-foreground text-center">
              Balance: {formatCurrency(wallet?.balance || 0)}
              {(wallet?.balance || 0) < total && (
                <span className="text-destructive ml-1">(Insufficient)</span>
              )}
            </div>

            <Button
              onClick={handlePay}
              disabled={loading || (wallet?.balance || 0) < total}
              className="w-full gap-2"
              size="lg"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}
              Pay {formatCurrency(total)}
            </Button>
          </div>
        ) : (
          <div className="p-4 space-y-4">
            <DialogHeader className="pb-0">
              <DialogTitle className="flex items-center gap-2">
                <div className="p-2 rounded-xl bg-primary/10">
                  <ShoppingCart className="h-5 w-5 text-primary" />
                </div>
                Food Shopping
              </DialogTitle>
              <DialogDescription>
                Add items, see the total, and pay the seller instantly
              </DialogDescription>
            </DialogHeader>

            {/* Quick add popular items */}
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder="Search popular items..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 h-9 text-sm"
                />
              </div>
              <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                {filteredPopular.map((item) => {
                  const inCart = cart.find(c => c.name === item.name);
                  return (
                    <button
                      key={item.name}
                      onClick={() => addPopularItem(item)}
                      className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium border transition-all active:scale-95 touch-manipulation ${
                        inCart
                          ? 'bg-primary/10 border-primary/30 text-primary'
                          : 'bg-muted/50 border-border hover:border-primary/30'
                      }`}
                    >
                      {item.icon}
                      <span>{item.name}</span>
                      <span className="text-muted-foreground ml-0.5">{formatCurrency(item.price)}</span>
                      {inCart && (
                        <Badge variant="secondary" className="h-4 px-1 text-[10px] ml-0.5">
                          ×{inCart.quantity}
                        </Badge>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Custom item entry */}
            <div className="bg-muted/30 rounded-xl p-3 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Add Custom Item</p>
              <div className="flex gap-2">
                <Input
                  type="text"
                  placeholder="Item name"
                  value={itemName}
                  onChange={(e) => setItemName(e.target.value)}
                  className="flex-1 h-9 text-sm"
                  onKeyDown={(e) => e.key === 'Enter' && itemPrice && addItem()}
                />
                <Input
                  type="number"
                  placeholder="Qty"
                  value={itemQty}
                  onChange={(e) => setItemQty(e.target.value)}
                  className="w-14 h-9 text-sm text-center"
                  min="1"
                />
                <Input
                  type="number"
                  placeholder="Price"
                  value={itemPrice}
                  onChange={(e) => setItemPrice(e.target.value)}
                  className="w-24 h-9 text-sm"
                  min="100"
                  onKeyDown={(e) => e.key === 'Enter' && addItem()}
                />
                <Button size="sm" onClick={addItem} className="h-9 w-9 p-0 shrink-0">
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Cart */}
            {cart.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Your Cart ({cart.length} item{cart.length > 1 ? 's' : ''})
                  </p>
                  <Button variant="ghost" size="sm" className="h-6 text-xs text-destructive" onClick={() => setCart([])}>
                    Clear
                  </Button>
                </div>
                <div className="space-y-1 max-h-36 overflow-y-auto">
                  {cart.map(item => (
                    <div key={item.id} className="flex items-center justify-between bg-background rounded-lg p-2 border border-border/50">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{item.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatCurrency(item.price)} each
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => updateQuantity(item.id, item.quantity - 1)}
                        >
                          <span className="text-sm font-bold">−</span>
                        </Button>
                        <span className="text-sm font-bold w-5 text-center">{item.quantity}</span>
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => updateQuantity(item.id, item.quantity + 1)}
                        >
                          <span className="text-sm font-bold">+</span>
                        </Button>
                        <span className="text-sm font-bold w-16 text-right">
                          {formatCurrency(item.price * item.quantity)}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-destructive/60 hover:text-destructive"
                          onClick={() => removeItem(item.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Total + Pay */}
                <div className="bg-primary/5 border border-primary/20 rounded-xl p-3">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-semibold">Total Payable</span>
                    <span className="text-xl font-black text-primary">{formatCurrency(total)}</span>
                  </div>
                  <Button
                    onClick={() => setStep('pay')}
                    className="w-full gap-2"
                    size="lg"
                  >
                    <ShoppingCart className="h-4 w-4" />
                    Proceed to Pay
                  </Button>
                </div>
              </div>
            )}

            {cart.length === 0 && (
              <div className="text-center py-4 text-muted-foreground">
                <ShoppingCart className="h-10 w-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Tap items above or add your own</p>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
