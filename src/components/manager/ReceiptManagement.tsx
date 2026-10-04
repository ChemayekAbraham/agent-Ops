import { useState, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import { Receipt, Store, Plus, CheckCircle, XCircle, Clock, Loader2, Users, FileText, Key, ExternalLink, Printer, TrendingUp, FileSpreadsheet, Share2, MessageCircle, Copy } from 'lucide-react';
import { PrintableReceiptSheet } from './PrintableReceiptSheet';
import { VendorAnalytics } from './VendorAnalytics';
import { exportToCSV, formatDateForExport } from '@/lib/exportUtils';
import { toast as sonnerToast } from 'sonner';
// jsPDF loaded dynamically when needed
import { QRCodeCanvas } from 'qrcode.react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from '@/components/ui/dialog';

interface Vendor {
  id: string;
  name: string;
  location: string | null;
  phone: string | null;
  has_pin?: boolean;
  active: boolean;
  created_at: string;
}

interface ReceiptNumber {
  id: string;
  receipt_code: string;
  vendor_id: string;
  vendor_amount: number | null;
  vendor_marked_at: string | null;
  status: string;
  created_at: string;
  vendors?: {
    name: string;
  };
}

interface UserReceipt {
  id: string;
  user_id: string;
  receipt_number_id: string;
  items_description: string;
  claimed_amount: number;
  verified: boolean;
  rejection_reason: string | null;
  loan_contribution: number | null;
  created_at: string;
  receipt_numbers?: {
    receipt_code: string;
    vendor_amount: number | null;
    vendors?: {
      name: string;
    };
  };
  profiles?: {
    full_name: string;
    phone: string;
  };
}

interface ReceiptManagementProps {
  userId: string;
}

// Vendor Card with PIN management
function VendorCard({ vendor, onPinSet }: { vendor: Vendor; onPinSet: () => void }) {
  const { toast } = useToast();
  const [showPinInput, setShowPinInput] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSetPin = async () => {
    if (newPin.length !== 4 || !/^\d{4}$/.test(newPin)) {
      toast({ title: 'Invalid PIN', description: 'PIN must be exactly 4 digits', variant: 'destructive' });
      return;
    }

    setSaving(true);
    const { error } = await supabase
      .from('vendors')
      .update({ pin_hash: newPin })
      .eq('id', vendor.id);

    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'PIN Set', description: `PIN set for ${vendor.name}` });
      setShowPinInput(false);
      setNewPin('');
      onPinSet();
    }
    setSaving(false);
  };

  return (
    <div className="p-4 rounded-xl bg-secondary/30 border border-border/50">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-semibold">{vendor.name}</p>
          {vendor.location && <p className="text-sm text-muted-foreground">{vendor.location}</p>}
          {vendor.phone && <p className="text-sm text-muted-foreground">{vendor.phone}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={vendor.has_pin ? 'success' : 'outline'} className="gap-1">
            <Key className="h-3 w-3" />
            {vendor.has_pin ? 'PIN Set' : 'No PIN'}
          </Badge>
          <Badge variant={vendor.active ? 'success' : 'secondary'}>
            {vendor.active ? 'Active' : 'Inactive'}
          </Badge>
        </div>
      </div>
      
      {showPinInput ? (
        <div className="mt-3 flex gap-2">
          <Input
            type="text"
            placeholder="4-digit PIN"
            maxLength={4}
            value={newPin}
            onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
            className="w-32 font-mono"
          />
          <Button size="sm" onClick={handleSetPin} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setShowPinInput(false); setNewPin(''); }}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button 
          size="sm" 
          variant="outline" 
          className="mt-3 gap-1"
          onClick={() => setShowPinInput(true)}
        >
          <Key className="h-3 w-3" />
          {vendor.has_pin ? 'Change PIN' : 'Set PIN'}
        </Button>
      )}
    </div>
  );
}

export function ReceiptManagement({ userId }: ReceiptManagementProps) {
  const { toast } = useToast();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [receiptNumbers, setReceiptNumbers] = useState<ReceiptNumber[]>([]);
  const [userReceipts, setUserReceipts] = useState<UserReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Form states
  const [vendorName, setVendorName] = useState('');
  const [vendorLocation, setVendorLocation] = useState('');
  const [vendorPhone, setVendorPhone] = useState('');
  const [selectedVendor, setSelectedVendor] = useState('');
  const [receiptCount, setReceiptCount] = useState('10');
  const [markReceiptCode, setMarkReceiptCode] = useState('');
  const [markAmount, setMarkAmount] = useState('');
  const [vendorDialogOpen, setVendorDialogOpen] = useState(false);
  const [receiptDialogOpen, setReceiptDialogOpen] = useState(false);
  const [printSheetOpen, setPrintSheetOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [generatedReceipts, setGeneratedReceipts] = useState<string[]>([]);
  const [generatedVendorName, setGeneratedVendorName] = useState('');
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const qrContainerRef = useRef<HTMLDivElement>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    
    const [vendorsRes, receiptsRes, userReceiptsRes] = await Promise.all([
      supabase
        .from('vendors')
        .select('id, name, location, phone, active, created_at')
        .order('created_at', { ascending: false }),
      supabase
        .from('receipt_numbers')
        .select('*, vendors(name)')
        .order('created_at', { ascending: false })
        .limit(200),
      supabase
        .from('user_receipts')
        .select(`
          *,
          receipt_numbers (
            receipt_code,
            vendor_amount,
            vendors (name)
          )
        `)
        .order('created_at', { ascending: false })
        .limit(100)
    ]);

    // Fetch user profiles for receipts
    const userIds = [...new Set((userReceiptsRes.data || []).map(r => r.user_id))];
    const { data: profiles } = userIds.length > 0 
      ? await supabase.from('profiles').select('id, full_name, phone').in('id', userIds)
      : { data: [] };

    const receiptsWithProfiles = (userReceiptsRes.data || []).map(r => ({
      ...r,
      profiles: profiles?.find(p => p.id === r.user_id)
    }));

    // Managers can see whether a PIN is set (without exposing the value)
    const { data: pinFlags } = await supabase.rpc('manager_vendor_pin_flags');
    const pinMap = new Map((pinFlags || []).map((f) => [f.vendor_id, f.has_pin]));
    setVendors(
      (vendorsRes.data || []).map((v) => ({ ...v, has_pin: pinMap.get(v.id) ?? false }))
    );
    setReceiptNumbers(receiptsRes.data || []);
    setUserReceipts(receiptsWithProfiles);
    setLoading(false);
  };

  const handleCreateVendor = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    const { error } = await supabase
      .from('vendors')
      .insert({
        name: vendorName.trim(),
        location: vendorLocation.trim() || null,
        phone: vendorPhone.trim() || null,
        created_by: userId
      });

    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Vendor Created', description: `${vendorName} has been added` });
      setVendorName('');
      setVendorLocation('');
      setVendorPhone('');
      setVendorDialogOpen(false);
      fetchData();
    }
    setSubmitting(false);
  };

  const handleGenerateReceipts = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVendor) return;
    setSubmitting(true);

    const count = parseInt(receiptCount);
    const receipts = [];
    const codes: string[] = [];
    
    for (let i = 0; i < count; i++) {
      const code = `WL-${Date.now().toString(36).toUpperCase()}${i.toString().padStart(3, '0')}`;
      codes.push(code);
      receipts.push({
        receipt_code: code,
        vendor_id: selectedVendor,
        created_by: userId
      });
    }

    const { error } = await supabase
      .from('receipt_numbers')
      .insert(receipts);

    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      // Store generated receipts for sharing
      const vendorName = vendors.find(v => v.id === selectedVendor)?.name || 'Vendor';
      setGeneratedReceipts(codes);
      setGeneratedVendorName(vendorName);
      setReceiptDialogOpen(false);
      setShareDialogOpen(true);
      toast({ 
        title: 'Receipts Generated', 
        description: `${count} receipt numbers created. Share them with the vendor!` 
      });
      fetchData();
    }
    setSubmitting(false);
  };

  // Helper function to generate QR code as data URL
  const generateQRCodeDataUrl = (text: string): Promise<string> => {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      
      // Use qrcode.react's internal rendering
      import('qrcode.react').then(({ QRCodeCanvas }) => {
        const container = document.createElement('div');
        container.style.position = 'absolute';
        container.style.left = '-9999px';
        document.body.appendChild(container);
        
        const root = document.createElement('div');
        container.appendChild(root);
        
        import('react-dom/client').then(({ createRoot }) => {
          const reactRoot = createRoot(root);
          reactRoot.render(
            <QRCodeCanvas value={text} size={64} level="M" />
          );
          
          setTimeout(() => {
            const qrCanvas = root.querySelector('canvas');
            if (qrCanvas) {
              resolve(qrCanvas.toDataURL('image/png'));
            } else {
              resolve('');
            }
            reactRoot.unmount();
            document.body.removeChild(container);
          }, 100);
        });
      });
    });
  };

  const generateReceiptPDF = async (): Promise<Blob> => {
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4'
    });

    const pageWidth = pdf.internal.pageSize.getWidth();
    const margin = 15;
    let yPos = margin;

    // Load the Welile logo
    let logoDataUrl: string | null = null;
    try {
      const logoResponse = await fetch('/welile-logo.png');
      const logoBlob = await logoResponse.blob();
      logoDataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(logoBlob);
      });
    } catch (e) {
      console.log('Could not load logo for PDF');
    }

    // Pre-generate all QR codes
    const qrCodes: string[] = [];
    for (const code of generatedReceipts) {
      const qrDataUrl = await generateQRCodeDataUrl(code);
      qrCodes.push(qrDataUrl);
    }

    // Header with logo
    if (logoDataUrl) {
      const logoWidth = 30;
      const logoHeight = 12;
      pdf.addImage(logoDataUrl, 'PNG', (pageWidth - logoWidth) / 2, yPos, logoWidth, logoHeight);
      yPos += logoHeight + 5;
    }
    
    pdf.setFontSize(16);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Receipt Codes', pageWidth / 2, yPos, { align: 'center' });
    yPos += 8;

    pdf.setFontSize(12);
    pdf.setFont('helvetica', 'normal');
    pdf.text(`Vendor: ${generatedVendorName}`, pageWidth / 2, yPos, { align: 'center' });
    yPos += 6;
    pdf.text(`Generated: ${new Date().toLocaleDateString()}`, pageWidth / 2, yPos, { align: 'center' });
    yPos += 8;

    pdf.setFontSize(10);
    pdf.setTextColor(100, 100, 100);
    pdf.text('Scan QR or use code to verify purchase.', pageWidth / 2, yPos, { align: 'center' });
    yPos += 12;

    // Receipt codes in a grid with QR codes
    pdf.setTextColor(0, 0, 0);
    pdf.setFontSize(10);
    
    const colWidth = (pageWidth - margin * 2) / 2;
    const rowHeight = 28;
    let col = 0;
    
    for (let i = 0; i < generatedReceipts.length; i++) {
      const x = margin + (col * colWidth);
      
      // Background for code
      pdf.setFillColor(248, 248, 255);
      pdf.setDrawColor(103, 58, 183);
      pdf.roundedRect(x, yPos - 4, colWidth - 5, rowHeight - 2, 2, 2, 'FD');
      
      // QR Code
      if (qrCodes[i]) {
        pdf.addImage(qrCodes[i], 'PNG', x + 2, yPos - 2, 18, 18);
      }
      
      // Mini logo for each receipt
      if (logoDataUrl) {
        pdf.addImage(logoDataUrl, 'PNG', x + 22, yPos - 2, 14, 5);
      }
      
      // Code number
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8);
      pdf.setTextColor(100, 100, 100);
      pdf.text(`#${i + 1}`, x + 22, yPos + 7);
      
      // Code
      pdf.setFont('courier', 'bold');
      pdf.setFontSize(11);
      pdf.setTextColor(103, 58, 183);
      pdf.text(generatedReceipts[i], x + 22, yPos + 13);
      
      col++;
      if (col >= 2) {
        col = 0;
        yPos += rowHeight;
        
        // New page if needed
        if (yPos > pdf.internal.pageSize.getHeight() - margin - 15) {
          pdf.addPage();
          yPos = margin;
        }
      }
    }

    // Footer
    yPos = pdf.internal.pageSize.getHeight() - 15;
    if (logoDataUrl) {
      pdf.addImage(logoDataUrl, 'PNG', (pageWidth - 20) / 2, yPos - 5, 20, 8);
    }
    pdf.setFontSize(8);
    pdf.setTextColor(100, 100, 100);
    pdf.text('Building credit through shopping', pageWidth / 2, yPos + 5, { align: 'center' });

    return pdf.output('blob');
  };

  const handleShareOnWhatsApp = async () => {
    setGeneratingPdf(true);
    
    try {
      const pdfBlob = await generateReceiptPDF();
      
      // Check if Web Share API with files is supported
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [new File([pdfBlob], 'receipts.pdf', { type: 'application/pdf' })] })) {
        const file = new File([pdfBlob], `welile-receipts-${generatedVendorName.replace(/\s+/g, '-')}.pdf`, { type: 'application/pdf' });
        
        await navigator.share({
          title: `Welile Receipt Codes for ${generatedVendorName}`,
          text: `Here are ${generatedReceipts.length} receipt codes for ${generatedVendorName}. Give one code to each customer when they make a purchase.`,
          files: [file]
        });
        
        sonnerToast.success('Shared successfully!');
      } else {
        // Fallback: Download and provide WhatsApp link
        const url = URL.createObjectURL(pdfBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `welile-receipts-${generatedVendorName.replace(/\s+/g, '-')}.pdf`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        
        // Open WhatsApp with pre-filled message
        const whatsappText = encodeURIComponent(
          `Hi! Here are ${generatedReceipts.length} Welile receipt codes for ${generatedVendorName}.\n\n` +
          `I've just sent you the PDF file. Give one code to each customer when they make a purchase.\n\n` +
          `Codes:\n${generatedReceipts.slice(0, 5).join('\n')}${generatedReceipts.length > 5 ? '\n...(see PDF for all codes)' : ''}`
        );
        window.open(`https://wa.me/?text=${whatsappText}`, '_blank');
        
        sonnerToast.success('PDF downloaded! Share it on WhatsApp.');
      }
      
      setShareDialogOpen(false);
    } catch (error) {
      console.error('Share error:', error);
      sonnerToast.error('Failed to share. Please try downloading instead.');
    }
    
    setGeneratingPdf(false);
  };

  const handleDownloadPdf = async () => {
    setGeneratingPdf(true);
    
    try {
      const pdfBlob = await generateReceiptPDF();
      const url = URL.createObjectURL(pdfBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `welile-receipts-${generatedVendorName.replace(/\s+/g, '-')}-${new Date().toISOString().split('T')[0]}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      sonnerToast.success('PDF downloaded successfully!');
    } catch (error) {
      console.error('Download error:', error);
      sonnerToast.error('Failed to generate PDF');
    }
    
    setGeneratingPdf(false);
  };

  const handleMarkReceipt = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    const { error } = await supabase
      .from('receipt_numbers')
      .update({
        vendor_amount: parseFloat(markAmount),
        vendor_marked_at: new Date().toISOString()
      })
      .eq('receipt_code', markReceiptCode.toUpperCase().trim());

    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ 
        title: 'Receipt Marked', 
        description: `Receipt ${markReceiptCode} marked with ${formatUGX(parseFloat(markAmount))}` 
      });
      setMarkReceiptCode('');
      setMarkAmount('');
      fetchData();
    }
    setSubmitting(false);
  };

  const availableReceipts = receiptNumbers.filter(r => r.status === 'available' && !r.vendor_amount);
  const markedReceipts = receiptNumbers.filter(r => r.vendor_amount !== null);
  const usedReceipts = receiptNumbers.filter(r => r.status === 'used');
  const verifiedUserReceipts = userReceipts.filter(r => r.verified);
  const pendingUserReceipts = userReceipts.filter(r => !r.verified && !r.rejection_reason);

  const handleExportUserReceipts = () => {
    const headers = ['Receipt Code', 'User Name', 'Phone', 'Vendor', 'Claimed Amount', 'Vendor Amount', 'Status', 'Loan Contribution', 'Date'];
    const rows = userReceipts.map(r => [
      r.receipt_numbers?.receipt_code || 'N/A',
      r.profiles?.full_name || 'Unknown',
      r.profiles?.phone || 'N/A',
      r.receipt_numbers?.vendors?.name || 'N/A',
      r.claimed_amount,
      r.receipt_numbers?.vendor_amount || 'Not marked',
      r.verified ? 'Verified' : r.rejection_reason ? 'Rejected' : 'Pending',
      r.loan_contribution || 0,
      formatDateForExport(r.created_at)
    ]);
    exportToCSV({ headers, rows }, 'user_receipts');
    sonnerToast.success('User receipts exported to CSV!');
  };

  const handleExportReceiptNumbers = () => {
    const headers = ['Receipt Code', 'Vendor', 'Status', 'Vendor Amount', 'Marked Date', 'Created Date'];
    const rows = receiptNumbers.map(r => [
      r.receipt_code,
      r.vendors?.name || 'N/A',
      r.status,
      r.vendor_amount || 'Not marked',
      r.vendor_marked_at ? formatDateForExport(r.vendor_marked_at) : 'N/A',
      formatDateForExport(r.created_at)
    ]);
    exportToCSV({ headers, rows }, 'receipt_numbers');
    sonnerToast.success('Receipt numbers exported to CSV!');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <Store className="h-5 w-5 text-primary" />
              <div>
                <p className="text-sm text-muted-foreground">Vendors</p>
                <p className="text-xl font-bold">{vendors.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-success/5 border-success/20">
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <CheckCircle className="h-5 w-5 text-success" />
              <div>
                <p className="text-sm text-muted-foreground">Verified</p>
                <p className="text-xl font-bold text-success">{verifiedUserReceipts.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-warning/5 border-warning/20">
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <Clock className="h-5 w-5 text-warning" />
              <div>
                <p className="text-sm text-muted-foreground">Pending</p>
                <p className="text-xl font-bold text-warning">{pendingUserReceipts.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <Receipt className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Available</p>
                <p className="text-xl font-bold">{availableReceipts.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Action Buttons */}
      <div className="flex flex-wrap gap-3">
        <Dialog open={vendorDialogOpen} onOpenChange={setVendorDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Store className="h-4 w-4" />
              Add Vendor
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add New Vendor</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreateVendor} className="space-y-4">
              <div className="space-y-2">
                <Label>Vendor Name</Label>
                <Input
                  placeholder="Shop/Supermarket name"
                  value={vendorName}
                  onChange={(e) => setVendorName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>Location</Label>
                <Input
                  placeholder="Address/Location"
                  value={vendorLocation}
                  onChange={(e) => setVendorLocation(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Phone</Label>
                <Input
                  placeholder="Contact phone"
                  value={vendorPhone}
                  onChange={(e) => setVendorPhone(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Create Vendor
              </Button>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog open={receiptDialogOpen} onOpenChange={setReceiptDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" className="gap-2">
              <Plus className="h-4 w-4" />
              Generate Receipts
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Generate Receipt Numbers</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleGenerateReceipts} className="space-y-4">
              <div className="space-y-2">
                <Label>Select Vendor</Label>
                <Select value={selectedVendor} onValueChange={setSelectedVendor}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose vendor" />
                  </SelectTrigger>
                  <SelectContent>
                    {vendors.map((v) => (
                      <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Number of Receipts</Label>
                <Select value={receiptCount} onValueChange={setReceiptCount}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10 receipts</SelectItem>
                    <SelectItem value="25">25 receipts</SelectItem>
                    <SelectItem value="50">50 receipts</SelectItem>
                    <SelectItem value="100">100 receipts</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" className="w-full" disabled={submitting || !selectedVendor}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Generate Receipts
              </Button>
            </form>
          </DialogContent>
        </Dialog>

        <Button 
          variant="outline" 
          className="gap-2"
          onClick={() => setPrintSheetOpen(true)}
        >
          <Printer className="h-4 w-4" />
          Print Receipt Codes
        </Button>
      </div>

      {/* Printable Receipt Sheet Dialog */}
      <PrintableReceiptSheet
        vendors={vendors}
        receiptNumbers={receiptNumbers}
        open={printSheetOpen}
        onClose={() => setPrintSheetOpen(false)}
      />

      {/* Share Generated Receipts Dialog */}
      <Dialog open={shareDialogOpen} onOpenChange={setShareDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-success" />
              Receipts Generated!
            </DialogTitle>
            <DialogDescription>
              {generatedReceipts.length} receipt codes created for {generatedVendorName}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            {/* Preview of codes */}
            <div className="max-h-40 overflow-y-auto bg-secondary/30 rounded-lg p-3">
              <div className="grid grid-cols-2 gap-2 text-sm font-mono">
                {generatedReceipts.slice(0, 10).map((code, i) => (
                  <div key={code} className="bg-background px-2 py-1 rounded text-xs">
                    {i + 1}. {code}
                  </div>
                ))}
                {generatedReceipts.length > 10 && (
                  <div className="col-span-2 text-center text-muted-foreground text-xs py-1">
                    +{generatedReceipts.length - 10} more codes...
                  </div>
                )}
              </div>
            </div>

            {/* Share buttons */}
            <div className="flex flex-col gap-3">
              <Button 
                variant="outline"
                onClick={() => {
                  const allCodes = generatedReceipts.join('\n');
                  navigator.clipboard.writeText(allCodes);
                  sonnerToast.success(`${generatedReceipts.length} codes copied to clipboard!`);
                }}
                className="w-full gap-2"
              >
                <Copy className="h-4 w-4" />
                Copy All Codes
              </Button>
              
              <Button 
                onClick={handleShareOnWhatsApp}
                disabled={generatingPdf}
                className="w-full gap-2 bg-[#25D366] hover:bg-[#20BD5A] text-white"
              >
                {generatingPdf ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <MessageCircle className="h-4 w-4" />
                )}
                Share on WhatsApp
              </Button>
              
              <Button 
                variant="outline"
                onClick={handleDownloadPdf}
                disabled={generatingPdf}
                className="w-full gap-2"
              >
                {generatingPdf ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FileText className="h-4 w-4" />
                )}
                Download PDF
              </Button>
            </div>

            <p className="text-xs text-muted-foreground text-center">
              Share this PDF with the vendor so they can give receipt codes to customers
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Mark Receipt Form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            Mark Receipt (Vendor Entry)
          </CardTitle>
          <CardDescription>
            When a vendor gives out a receipt, enter the code and amount here
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleMarkReceipt} className="flex flex-col sm:flex-row gap-3">
            <Input
              placeholder="Receipt Code (e.g., WL-ABC123)"
              value={markReceiptCode}
              onChange={(e) => setMarkReceiptCode(e.target.value.toUpperCase())}
              className="flex-1 font-mono uppercase"
              required
            />
            <Input
              type="number"
              placeholder="Amount (UGX)"
              value={markAmount}
              onChange={(e) => setMarkAmount(e.target.value)}
              className="w-full sm:w-40"
              required
              min="1000"
            />
            <Button type="submit" disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Mark'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Tabs for different views */}
      <Tabs defaultValue="user-receipts" className="space-y-4">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="user-receipts" className="gap-1 text-xs sm:text-sm">
            <Users className="h-4 w-4" />
            <span className="hidden sm:inline">User</span> Receipts
          </TabsTrigger>
          <TabsTrigger value="receipt-numbers" className="gap-1 text-xs sm:text-sm">
            <Receipt className="h-4 w-4" />
            <span className="hidden sm:inline">Receipt</span> Numbers
          </TabsTrigger>
          <TabsTrigger value="vendors" className="gap-1 text-xs sm:text-sm">
            <Store className="h-4 w-4" />
            Vendors
          </TabsTrigger>
          <TabsTrigger value="analytics" className="gap-1 text-xs sm:text-sm">
            <TrendingUp className="h-4 w-4" />
            Analytics
          </TabsTrigger>
        </TabsList>

        <TabsContent value="user-receipts" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Users className="h-5 w-5 text-primary" />
                  User Submitted Receipts
                </CardTitle>
                <CardDescription className="mt-1">
                  {pendingUserReceipts.length} pending • {verifiedUserReceipts.length} verified
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={handleExportUserReceipts} className="gap-2 touch-manipulation">
                <FileSpreadsheet className="h-4 w-4" />
                Export
              </Button>
            </CardHeader>
            <CardContent>
              {userReceipts.length === 0 ? (
                <div className="text-center py-12">
                  <Receipt className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
                  <p className="text-muted-foreground font-medium">No receipts submitted yet</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Users can submit receipts from their dashboard
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {userReceipts.map((receipt) => (
                    <div 
                      key={receipt.id} 
                      className={`p-4 rounded-xl border transition-all ${
                        receipt.verified 
                          ? 'bg-success/5 border-success/20' 
                          : receipt.rejection_reason 
                            ? 'bg-destructive/5 border-destructive/20'
                            : 'bg-warning/5 border-warning/20'
                      }`}
                    >
                      <div className="flex flex-col gap-3">
                        {/* Header Row */}
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <code className="text-sm font-mono bg-background/80 px-2 py-1 rounded font-bold">
                              {receipt.receipt_numbers?.receipt_code || 'N/A'}
                            </code>
                            {receipt.verified ? (
                              <Badge variant="success" className="gap-1">
                                <CheckCircle className="h-3 w-3" />
                                Verified
                              </Badge>
                            ) : receipt.rejection_reason ? (
                              <Badge variant="destructive" className="gap-1">
                                <XCircle className="h-3 w-3" />
                                Rejected
                              </Badge>
                            ) : (
                              <Badge variant="warning" className="gap-1 animate-pulse">
                                <Clock className="h-3 w-3" />
                                Pending
                              </Badge>
                            )}
                          </div>
                          <div className="text-right">
                            <p className="font-bold text-lg">{formatUGX(receipt.claimed_amount)}</p>
                          </div>
                        </div>
                        
                        {/* User & Vendor Info */}
                        <div className="grid grid-cols-2 gap-3 text-sm">
                          <div>
                            <p className="text-xs text-muted-foreground">User</p>
                            <p className="font-medium">{receipt.profiles?.full_name || 'Unknown'}</p>
                            <p className="text-xs text-muted-foreground">{receipt.profiles?.phone}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Vendor</p>
                            <p className="font-medium">{receipt.receipt_numbers?.vendors?.name || 'N/A'}</p>
                            {receipt.receipt_numbers?.vendor_amount && (
                              <p className="text-xs text-muted-foreground">
                                Amount: {formatUGX(receipt.receipt_numbers.vendor_amount)}
                              </p>
                            )}
                          </div>
                        </div>

                        {/* Items Description */}
                        {receipt.items_description && (
                          <div className="text-sm p-2 bg-background/50 rounded-lg">
                            <p className="text-xs text-muted-foreground mb-1">Items</p>
                            <p className="text-foreground">{receipt.items_description}</p>
                          </div>
                        )}

                        {/* Loan Contribution & Actions */}
                        <div className="flex items-center justify-between pt-2 border-t border-border/50">
                          <div>
                            {receipt.loan_contribution ? (
                              <p className="text-sm text-success font-medium">
                                +{formatUGX(receipt.loan_contribution)} rent access
                              </p>
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                {new Date(receipt.created_at).toLocaleDateString()}
                              </p>
                            )}
                          </div>
                          
                          {/* Action Buttons for Pending Receipts */}
                          {!receipt.verified && !receipt.rejection_reason && (
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-1 h-8 text-destructive border-destructive/30 hover:bg-destructive/10 touch-manipulation"
                                onClick={async () => {
                                  const reason = prompt('Rejection reason:');
                                  if (reason) {
                                    const { error } = await supabase
                                      .from('user_receipts')
                                      .update({ rejection_reason: reason })
                                      .eq('id', receipt.id);
                                    if (error) {
                                      toast({ title: 'Error', description: error.message, variant: 'destructive' });
                                    } else {
                                      toast({ title: 'Receipt Rejected' });
                                      fetchData();
                                    }
                                  }
                                }}
                              >
                                <XCircle className="h-3.5 w-3.5" />
                                Reject
                              </Button>
                              <Button
                                size="sm"
                                className="gap-1 h-8 bg-success hover:bg-success/90 touch-manipulation"
                                onClick={async () => {
                                  // Calculate loan contribution (10% of claimed amount)
                                  const contribution = Math.round(receipt.claimed_amount * 0.1);
                                  
                                  const { error } = await supabase
                                    .from('user_receipts')
                                    .update({ 
                                      verified: true,
                                      loan_contribution: contribution
                                    })
                                    .eq('id', receipt.id);
                                    
                                  if (error) {
                                    toast({ title: 'Error', description: error.message, variant: 'destructive' });
                                  } else {
                                    // loan_limits table removed - skip update
                                    console.log('Loan limits update skipped - table removed');
                                    
                                    toast({ 
                                      title: 'Receipt Verified!', 
                                      description: `+${formatUGX(contribution)} added to rent access limit` 
                                    });
                                    fetchData();
                                  }
                                }}
                              >
                                <CheckCircle className="h-3.5 w-3.5" />
                                Verify
                              </Button>
                            </div>
                          )}
                          
                          {receipt.rejection_reason && (
                            <p className="text-xs text-destructive max-w-[200px] truncate">
                              Reason: {receipt.rejection_reason}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="receipt-numbers" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-lg">Receipt Numbers</CardTitle>
                <CardDescription>
                  {availableReceipts.length} available • {markedReceipts.length} marked • {usedReceipts.length} used
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={handleExportReceiptNumbers} className="gap-2">
                <FileSpreadsheet className="h-4 w-4" />
                Export CSV
              </Button>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {receiptNumbers.slice(0, 50).map((receipt) => (
                  <div 
                    key={receipt.id} 
                    className="flex items-center justify-between p-3 rounded-lg bg-secondary/30 border border-border/50"
                  >
                    <div className="flex items-center gap-3">
                      <code className="font-mono text-sm">{receipt.receipt_code}</code>
                      <Badge variant={
                        receipt.status === 'used' ? 'success' : 
                        receipt.vendor_amount ? 'default' : 'outline'
                      }>
                        {receipt.status === 'used' ? 'Used' : receipt.vendor_amount ? 'Marked' : 'Available'}
                      </Badge>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-muted-foreground">{receipt.vendors?.name}</p>
                      {receipt.vendor_amount && (
                        <p className="text-sm font-medium">{formatUGX(receipt.vendor_amount)}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="vendors" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center justify-between">
                <span>Registered Vendors</span>
                <a 
                  href="/vendor-portal" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-sm font-normal text-primary hover:underline flex items-center gap-1"
                >
                  Vendor Portal <ExternalLink className="h-3 w-3" />
                </a>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {vendors.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">No vendors registered yet</p>
              ) : (
                <div className="space-y-3">
                  {vendors.map((vendor) => (
                    <VendorCard 
                      key={vendor.id} 
                      vendor={vendor} 
                      onPinSet={fetchData}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="analytics">
          <VendorAnalytics />
        </TabsContent>
      </Tabs>
    </div>
  );
}
