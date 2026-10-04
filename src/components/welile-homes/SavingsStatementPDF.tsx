import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { 
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Download, FileText, Loader2, Calendar, TrendingUp, Wallet, Percent } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
// jsPDF loaded dynamically when needed

interface Contribution {
  id: string;
  contribution_type: string;
  amount: number;
  balance_after: number;
  notes: string | null;
  created_at: string;
}

interface SavingsStatementPDFProps {
  userName: string;
  monthlyRent: number;
  totalSavings: number;
  monthsEnrolled: number;
  subscriptionStatus: string;
  createdAt: string;
  contributions: Contribution[];
  trigger?: React.ReactNode;
}

export function SavingsStatementPDF({
  userName,
  monthlyRent,
  totalSavings,
  monthsEnrolled,
  subscriptionStatus,
  createdAt,
  contributions,
  trigger,
}: SavingsStatementPDFProps) {
  const [open, setOpen] = useState(false);
  const [generating, setGenerating] = useState(false);

  const totalDeposits = contributions
    .filter(c => c.contribution_type === 'rent_payment')
    .reduce((sum, c) => sum + c.amount, 0);
  
  const totalInterest = contributions
    .filter(c => c.contribution_type === 'interest')
    .reduce((sum, c) => sum + c.amount, 0);

  const monthlyContribution = monthlyRent * 0.10;

  // Calculate projected savings
  const calculateProjection = (months: number) => {
    let balance = 0;
    for (let i = 0; i < months; i++) {
      balance = (balance * 1.05) + monthlyContribution;
    }
    return Math.round(balance);
  };

  const generatePDF = async () => {
    setGenerating(true);
    
    try {
      const { default: jsPDF } = await import('jspdf');
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();
      const margin = 20;
      let yPos = 20;

      // Helper function for centered text
      const centerText = (text: string, y: number, size: number = 12) => {
        doc.setFontSize(size);
        const textWidth = doc.getStringUnitWidth(text) * size / doc.internal.scaleFactor;
        doc.text(text, (pageWidth - textWidth) / 2, y);
      };

      // Header
      doc.setFillColor(147, 51, 234); // Purple
      doc.rect(0, 0, pageWidth, 45, 'F');
      
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(24);
      doc.setFont('helvetica', 'bold');
      centerText('WELILE HOMES', 20, 24);
      
      doc.setFontSize(12);
      doc.setFont('helvetica', 'normal');
      centerText('Savings Statement', 30, 12);
      
      doc.setFontSize(10);
      centerText(`Generated: ${format(new Date(), 'MMMM d, yyyy')}`, 38, 10);

      yPos = 60;
      doc.setTextColor(0, 0, 0);

      // Account Holder Info
      doc.setFillColor(249, 250, 251);
      doc.rect(margin, yPos - 5, pageWidth - (margin * 2), 35, 'F');
      
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text('Account Holder', margin + 5, yPos + 5);
      
      doc.setFontSize(11);
      doc.setFont('helvetica', 'normal');
      doc.text(`Name: ${userName}`, margin + 5, yPos + 15);
      doc.text(`Enrollment Date: ${format(new Date(createdAt), 'MMMM d, yyyy')}`, margin + 5, yPos + 23);
      doc.text(`Status: ${subscriptionStatus.toUpperCase()}`, pageWidth - margin - 40, yPos + 15);

      yPos += 45;

      // Summary Box
      doc.setFillColor(236, 253, 245); // Light green
      doc.rect(margin, yPos, pageWidth - (margin * 2), 50, 'F');
      doc.setDrawColor(34, 197, 94);
      doc.rect(margin, yPos, pageWidth - (margin * 2), 50, 'S');
      
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(22, 101, 52);
      doc.text('ACCOUNT SUMMARY', margin + 5, yPos + 12);
      
      doc.setFontSize(24);
      doc.text(formatUGX(totalSavings).replace('UGX', 'UGX '), margin + 5, yPos + 30);
      
      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.text('Current Balance', margin + 5, yPos + 40);

      // Right side stats
      doc.setFontSize(10);
      doc.setTextColor(0, 0, 0);
      const rightCol = pageWidth - margin - 60;
      doc.text(`Months Enrolled: ${monthsEnrolled}`, rightCol, yPos + 15);
      doc.text(`Total Deposits: ${formatUGX(totalDeposits)}`, rightCol, yPos + 25);
      doc.text(`Interest Earned: ${formatUGX(totalInterest)}`, rightCol, yPos + 35);
      doc.text(`Monthly Rent: ${formatUGX(monthlyRent)}`, rightCol, yPos + 45);

      yPos += 60;

      // Growth Projections
      doc.setTextColor(0, 0, 0);
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.text('PROJECTED GROWTH (at 5% monthly compound interest)', margin, yPos + 10);
      
      yPos += 15;
      
      const projections = [
        { label: '1 Year', value: calculateProjection(12) },
        { label: '2 Years', value: calculateProjection(24) },
        { label: '3 Years', value: calculateProjection(36) },
        { label: '5 Years', value: calculateProjection(60) },
      ];

      const colWidth = (pageWidth - (margin * 2)) / 4;
      projections.forEach((proj, i) => {
        const x = margin + (i * colWidth);
        doc.setFillColor(243, 232, 255); // Light purple
        doc.rect(x, yPos, colWidth - 5, 25, 'F');
        
        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(107, 33, 168);
        doc.text(proj.label, x + 5, yPos + 8);
        
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.text(formatUGX(proj.value), x + 5, yPos + 18);
      });

      yPos += 35;

      // Contribution History
      doc.setTextColor(0, 0, 0);
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.text('CONTRIBUTION HISTORY', margin, yPos + 10);
      
      yPos += 18;

      // Table Header
      doc.setFillColor(147, 51, 234);
      doc.rect(margin, yPos, pageWidth - (margin * 2), 8, 'F');
      
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.text('Date', margin + 3, yPos + 6);
      doc.text('Type', margin + 45, yPos + 6);
      doc.text('Amount', margin + 95, yPos + 6);

      yPos += 8;
      doc.setTextColor(0, 0, 0);
      doc.setFont('helvetica', 'normal');

      // Table Rows (limit to avoid overflow)
      const displayContributions = contributions.slice(0, 15);
      displayContributions.forEach((contrib, index) => {
        if (yPos > 270) return; // Stop if near page end
        
        if (index % 2 === 0) {
          doc.setFillColor(249, 250, 251);
          doc.rect(margin, yPos, pageWidth - (margin * 2), 7, 'F');
        }

        doc.setFontSize(8);
        doc.text(format(new Date(contrib.created_at), 'MMM d, yyyy'), margin + 3, yPos + 5);
        
        const typeLabel = contrib.contribution_type === 'rent_payment' ? 'Deposit' :
                          contrib.contribution_type === 'interest' ? 'Interest' : 
                          contrib.contribution_type;
        doc.text(typeLabel, margin + 45, yPos + 5);
        
        doc.setTextColor(22, 163, 74); // Green for positive
        doc.text(`+${formatUGX(contrib.amount)}`, margin + 95, yPos + 5);
        
        doc.setTextColor(0, 0, 0);
        yPos += 7;
      });

      if (contributions.length > 15) {
        yPos += 5;
        doc.setFontSize(8);
        doc.setTextColor(107, 114, 128);
        doc.text(`... and ${contributions.length - 15} more transactions`, margin, yPos);
      }

      // Footer
      yPos = 280;
      doc.setDrawColor(200, 200, 200);
      doc.line(margin, yPos, pageWidth - margin, yPos);
      
      doc.setFontSize(8);
      doc.setTextColor(107, 114, 128);
      centerText('This statement is auto-generated by Welile Homes. For inquiries, contact support.', yPos + 8, 8);
      centerText(`Statement ID: WH-${Date.now().toString(36).toUpperCase()}`, yPos + 14, 8);

      // Save PDF
      const fileName = `welile-homes-statement-${format(new Date(), 'yyyy-MM-dd')}.pdf`;
      doc.save(fileName);
      
      toast.success('Statement downloaded successfully!');
      setOpen(false);
    } catch (error) {
      console.error('Error generating PDF:', error);
      toast.error('Failed to generate statement');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" className="gap-2 border-purple-300 text-purple-700 hover:bg-purple-50">
            <Download className="h-4 w-4" />
            Download Statement
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-purple-600" />
            Download Savings Statement
          </DialogTitle>
          <DialogDescription>
            Generate a PDF statement of your Welile Homes savings history
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {/* Preview Card */}
          <div className="p-4 rounded-xl bg-gradient-to-br from-purple-50 to-amber-50 border border-purple-200">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-purple-800">Statement Preview</span>
              <Badge className="bg-purple-100 text-purple-700">PDF</Badge>
            </div>
            
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <Calendar className="h-4 w-4 text-purple-600" />
                <span className="text-muted-foreground">Period:</span>
                <span className="font-medium">
                  {format(new Date(createdAt), 'MMM yyyy')} - {format(new Date(), 'MMM yyyy')}
                </span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Wallet className="h-4 w-4 text-emerald-600" />
                <span className="text-muted-foreground">Current Balance:</span>
                <span className="font-bold text-emerald-600">{formatUGX(totalSavings)}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Percent className="h-4 w-4 text-purple-600" />
                <span className="text-muted-foreground">Interest Earned:</span>
                <span className="font-medium text-purple-700">{formatUGX(totalInterest)}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <TrendingUp className="h-4 w-4 text-blue-600" />
                <span className="text-muted-foreground">Transactions:</span>
                <span className="font-medium">{contributions.length} entries</span>
              </div>
            </div>
          </div>

          {/* What's Included */}
          <div className="p-3 rounded-lg bg-muted/50 border">
            <p className="text-xs font-medium mb-2">Statement includes:</p>
            <ul className="text-xs text-muted-foreground space-y-1">
              <li>• Account summary and current balance</li>
              <li>• Contribution history with dates</li>
              <li>• Interest earned breakdown</li>
              <li>• Future savings projections</li>
            </ul>
          </div>

          {/* Download Button */}
          <Button
            onClick={generatePDF}
            disabled={generating}
            className="w-full h-12 gap-2 bg-purple-600 hover:bg-purple-700"
          >
            {generating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating PDF...
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                Download PDF Statement
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
