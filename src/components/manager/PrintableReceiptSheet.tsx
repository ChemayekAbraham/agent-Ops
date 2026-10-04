import { useState, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Printer, Download, QrCode, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Vendor {
  id: string;
  name: string;
  location: string | null;
  phone: string | null;
}

interface ReceiptNumber {
  id: string;
  receipt_code: string;
  vendor_id: string;
  status: string;
  created_at: string;
}

interface PrintableReceiptSheetProps {
  vendors: Vendor[];
  receiptNumbers: ReceiptNumber[];
  open: boolean;
  onClose: () => void;
}

export function PrintableReceiptSheet({ 
  vendors, 
  receiptNumbers, 
  open, 
  onClose 
}: PrintableReceiptSheetProps) {
  const [selectedVendor, setSelectedVendor] = useState<string>('');
  const printRef = useRef<HTMLDivElement>(null);

  const selectedVendorData = vendors.find(v => v.id === selectedVendor);
  const vendorReceipts = receiptNumbers.filter(
    r => r.vendor_id === selectedVendor && r.status === 'available'
  );

  const handlePrint = () => {
    const printContent = printRef.current;
    if (!printContent) return;

    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Receipt Codes - ${selectedVendorData?.name}</title>
          <style>
            * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
            }
            body {
              font-family: 'Arial', sans-serif;
              padding: 20px;
              background: white;
            }
            .header {
              text-align: center;
              margin-bottom: 30px;
              padding-bottom: 20px;
              border-bottom: 2px solid #333;
            }
            .header h1 {
              font-size: 24px;
              margin-bottom: 5px;
            }
            .header p {
              color: #666;
              font-size: 14px;
            }
            .vendor-info {
              text-align: center;
              margin-bottom: 20px;
              padding: 15px;
              background: #f5f5f5;
              border-radius: 8px;
            }
            .vendor-info h2 {
              font-size: 20px;
              margin-bottom: 5px;
            }
            .vendor-info p {
              color: #666;
              font-size: 12px;
            }
            .receipt-grid {
              display: grid;
              grid-template-columns: repeat(3, 1fr);
              gap: 15px;
            }
            .receipt-card {
              border: 2px dashed #ccc;
              border-radius: 12px;
              padding: 15px;
              text-align: center;
              page-break-inside: avoid;
            }
            .receipt-card .qr-container {
              display: flex;
              justify-content: center;
              margin-bottom: 10px;
            }
            .receipt-card .code {
              font-family: 'Courier New', monospace;
              font-size: 14px;
              font-weight: bold;
              letter-spacing: 1px;
              margin-bottom: 5px;
            }
            .receipt-card .instructions {
              font-size: 10px;
              color: #666;
            }
            .footer {
              margin-top: 30px;
              text-align: center;
              font-size: 11px;
              color: #999;
              padding-top: 20px;
              border-top: 1px solid #eee;
            }
            @media print {
              body { padding: 10px; }
              .receipt-grid { gap: 10px; }
              .receipt-card { padding: 10px; }
            }
          </style>
        </head>
        <body>
          ${printContent.innerHTML}
        </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 250);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="h-5 w-5" />
            Print Receipt Codes
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <Select value={selectedVendor} onValueChange={setSelectedVendor}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder="Select vendor" />
              </SelectTrigger>
              <SelectContent>
                {vendors.map((vendor) => {
                  const count = receiptNumbers.filter(
                    r => r.vendor_id === vendor.id && r.status === 'available'
                  ).length;
                  return (
                    <SelectItem key={vendor.id} value={vendor.id}>
                      {vendor.name} ({count} available)
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>

            <Button 
              onClick={handlePrint} 
              disabled={!selectedVendor || vendorReceipts.length === 0}
              className="gap-2"
            >
              <Printer className="h-4 w-4" />
              Print Sheet
            </Button>
          </div>

          {selectedVendor && vendorReceipts.length === 0 && (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No available receipt codes for this vendor.
                <br />
                Generate new receipts first.
              </CardContent>
            </Card>
          )}

          {selectedVendor && vendorReceipts.length > 0 && (
            <div className="border rounded-lg p-4 bg-white">
              <div ref={printRef}>
                <div className="header">
                  <h1>WELILE Receipt Codes</h1>
                  <p>Give one code per customer transaction</p>
                </div>

                <div className="vendor-info">
                  <h2>{selectedVendorData?.name}</h2>
                  {selectedVendorData?.location && (
                    <p>{selectedVendorData.location}</p>
                  )}
                  <p>Generated: {new Date().toLocaleDateString()}</p>
                </div>

                <div className="receipt-grid">
                  {vendorReceipts.slice(0, 24).map((receipt) => (
                    <div key={receipt.id} className="receipt-card">
                      <div className="qr-container">
                        <QRCodeSVG 
                          value={receipt.receipt_code}
                          size={80}
                          level="M"
                        />
                      </div>
                      <div className="code">{receipt.receipt_code}</div>
                      <div className="instructions">
                        Customer scans or enters code in Welile app
                      </div>
                    </div>
                  ))}
                </div>

                <div className="footer">
                  <p>After giving out a receipt code, mark it with the purchase amount in your Vendor Portal.</p>
                  <p>Vendor Portal: welile.app/vendor-portal</p>
                </div>
              </div>
            </div>
          )}

          {selectedVendor && vendorReceipts.length > 24 && (
            <p className="text-sm text-muted-foreground text-center">
              Showing first 24 of {vendorReceipts.length} available codes. Print multiple sheets if needed.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
