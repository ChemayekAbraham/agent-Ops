import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Store, LogOut, Receipt, CheckCircle, Clock, AlertCircle } from 'lucide-react';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { motion, AnimatePresence } from 'framer-motion';

interface Vendor {
  id: string;
  name: string;
  phone: string;
  location: string;
}

interface VendorSession {
  vendor: Vendor;
  vendorToken: string;
}

interface ReceiptNumber {
  id: string;
  receipt_code: string;
  status: string;
  vendor_amount: number | null;
  created_at: string;
  vendor_marked_at: string | null;
}

export default function VendorPortal() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [vendorToken, setVendorToken] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<ReceiptNumber[]>([]);
  const [loading, setLoading] = useState(false);
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [markingReceipt, setMarkingReceipt] = useState<string | null>(null);
  const [markAmount, setMarkAmount] = useState('');

  // Check if vendor is already logged in (stored in sessionStorage)
  useEffect(() => {
    const storedVendor = sessionStorage.getItem('vendor_session');
    if (storedVendor) {
      const parsed = JSON.parse(storedVendor) as Partial<VendorSession>;
      if (!parsed.vendor || !parsed.vendorToken) {
        sessionStorage.removeItem('vendor_session');
        return;
      }
      setVendor(parsed.vendor);
      setVendorToken(parsed.vendorToken);
      setIsLoggedIn(true);
      fetchReceipts(parsed.vendor.id);
    }
  }, []);

  const handleLogin = async () => {
    if (!phone || pin.length !== 4) {
      toast.error('Please enter phone number and 4-digit PIN');
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('vendor-login', {
        body: { phone, pin }
      });

      if (error) throw error;
      if (!data.success) {
        toast.error(data.message || 'Invalid credentials');
        return;
      }

      setVendor(data.vendor);
      setVendorToken(data.vendorToken);
      setIsLoggedIn(true);
      sessionStorage.setItem('vendor_session', JSON.stringify({
        vendor: data.vendor,
        vendorToken: data.vendorToken,
      } satisfies VendorSession));
      fetchReceipts(data.vendor.id);
      toast.success(`Welcome, ${data.vendor.name}!`);
    } catch (error: any) {
      console.error('Login error:', error);
      toast.error('Login failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  const fetchReceipts = async (vendorId: string) => {
    try {
      const { data, error } = await supabase
        .from('receipt_numbers')
        .select('*')
        .eq('vendor_id', vendorId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setReceipts(data || []);
    } catch (error) {
      console.error('Error fetching receipts:', error);
    }
  };

  const handleMarkReceipt = async (receiptId: string) => {
    if (!markAmount || parseFloat(markAmount) <= 0) {
      toast.error('Please enter a valid amount');
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('vendor-mark-receipt', {
        body: {
          vendorId: vendor?.id,
          vendorToken,
          receiptId,
          amount: parseFloat(markAmount)
        }
      });

      if (error) throw error;
      if (!data.success) {
        toast.error(data.message || 'Failed to mark receipt');
        return;
      }

      toast.success('Receipt marked successfully!');
      setMarkingReceipt(null);
      setMarkAmount('');
      fetchReceipts(vendor!.id);
    } catch (error: any) {
      console.error('Mark receipt error:', error);
      toast.error('Failed to mark receipt');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem('vendor_session');
    setVendor(null);
    setVendorToken(null);
    setIsLoggedIn(false);
    setReceipts([]);
    setPhone('');
    setPin('');
    toast.info('Logged out successfully');
  };

  const availableReceipts = receipts.filter(r => r.status === 'available');
  const markedReceipts = receipts.filter(r => r.status === 'marked');
  const usedReceipts = receipts.filter(r => r.status === 'used');

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <Card className="w-full max-w-md">
            <CardHeader className="text-center">
              <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                <Store className="h-8 w-8 text-primary" />
              </div>
              <CardTitle className="text-2xl">Vendor Portal</CardTitle>
              <CardDescription>
                Log in with your phone number and PIN to manage receipts
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="phone">Phone Number</Label>
                <Input
                  id="phone"
                  type="tel"
                  placeholder="Enter your phone number"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label>4-Digit PIN</Label>
                <div className="flex justify-center">
                  <InputOTP
                    maxLength={4}
                    value={pin}
                    onChange={(value) => setPin(value)}
                  >
                    <InputOTPGroup>
                      <InputOTPSlot index={0} />
                      <InputOTPSlot index={1} />
                      <InputOTPSlot index={2} />
                      <InputOTPSlot index={3} />
                    </InputOTPGroup>
                  </InputOTP>
                </div>
              </div>

              <Button
                onClick={handleLogin}
                disabled={loading || !phone || pin.length !== 4}
                className="w-full"
              >
                {loading ? 'Logging in...' : 'Login'}
              </Button>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5">
      <header className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center">
              <Store className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="font-semibold">{vendor?.name}</h1>
              <p className="text-xs text-muted-foreground">{vendor?.location}</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={handleLogout}>
            <LogOut className="h-4 w-4 mr-2" />
            Logout
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-primary">{availableReceipts.length}</div>
              <p className="text-xs text-muted-foreground">Available</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-amber-500">{markedReceipts.length}</div>
              <p className="text-xs text-muted-foreground">Marked</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-green-500">{usedReceipts.length}</div>
              <p className="text-xs text-muted-foreground">Used</p>
            </CardContent>
          </Card>
        </div>

        {/* Available Receipts */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Receipt className="h-5 w-5" />
              Available Receipts
            </CardTitle>
            <CardDescription>
              Mark these when a customer makes a purchase
            </CardDescription>
          </CardHeader>
          <CardContent>
            {availableReceipts.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">
                No available receipts. Contact manager for more.
              </p>
            ) : (
              <div className="space-y-3">
                <AnimatePresence>
                  {availableReceipts.map((receipt) => (
                    <motion.div
                      key={receipt.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, x: -100 }}
                      className="border rounded-lg p-4"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <code className="text-lg font-mono font-bold text-primary">
                            {receipt.receipt_code}
                          </code>
                          <p className="text-xs text-muted-foreground mt-1">
                            Created {new Date(receipt.created_at).toLocaleDateString()}
                          </p>
                        </div>
                        <Badge variant="outline" className="bg-blue-500/10 text-blue-500">
                          <Clock className="h-3 w-3 mr-1" />
                          Available
                        </Badge>
                      </div>

                      {markingReceipt === receipt.id ? (
                        <div className="space-y-3 pt-3 border-t">
                          <div className="space-y-2">
                            <Label>Customer's Total Purchase Amount (UGX)</Label>
                            <Input
                              type="number"
                              placeholder="Enter total amount"
                              value={markAmount}
                              onChange={(e) => setMarkAmount(e.target.value)}
                              autoFocus
                            />
                          </div>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={() => handleMarkReceipt(receipt.id)}
                              disabled={loading}
                              className="flex-1"
                            >
                              <CheckCircle className="h-4 w-4 mr-1" />
                              Confirm
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setMarkingReceipt(null);
                                setMarkAmount('');
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setMarkingReceipt(receipt.id)}
                          className="w-full"
                        >
                          Mark as Used
                        </Button>
                      )}
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Marked Receipts */}
        {markedReceipts.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-amber-500" />
                Pending Verification
              </CardTitle>
              <CardDescription>
                Waiting for customers to submit these receipts
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {markedReceipts.map((receipt) => (
                  <div
                    key={receipt.id}
                    className="flex items-center justify-between p-3 border rounded-lg bg-amber-500/5"
                  >
                    <div>
                      <code className="font-mono font-bold">{receipt.receipt_code}</code>
                      <p className="text-sm text-muted-foreground">
                        Amount: UGX {receipt.vendor_amount?.toLocaleString()}
                      </p>
                    </div>
                    <Badge variant="outline" className="bg-amber-500/10 text-amber-500">
                      Marked
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Used Receipts */}
        {usedReceipts.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-green-500" />
                Verified Receipts
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {usedReceipts.slice(0, 10).map((receipt) => (
                  <div
                    key={receipt.id}
                    className="flex items-center justify-between p-3 border rounded-lg bg-green-500/5"
                  >
                    <div>
                      <code className="font-mono">{receipt.receipt_code}</code>
                      <p className="text-sm text-muted-foreground">
                        UGX {receipt.vendor_amount?.toLocaleString()}
                      </p>
                    </div>
                    <Badge variant="outline" className="bg-green-500/10 text-green-500">
                      Verified
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
