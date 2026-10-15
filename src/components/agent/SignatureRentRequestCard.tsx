import { useState } from 'react';
import { ArrowUpRight, Asterisk } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import './SignatureRentRequestCard.css';

interface SignatureRentRequestCardProps {
  fullName?: string | null;
  onPostRequest: () => void;
}

export function SignatureRentRequestCard({ fullName, onPostRequest }: SignatureRentRequestCardProps) {
  const [earningsOpen, setEarningsOpen] = useState(false);
  const firstName = fullName?.trim().split(/\s+/)[0] || 'Agent';

  return (
    <>
      <section className="signature-rent-card" aria-labelledby="signature-rent-title">
        <div className="signature-rent-content">
          <p className="signature-rent-greeting">
            <span className="signature-rent-dot" aria-hidden="true" />
            <span className="min-w-0 truncate">Hi, {firstName}</span>
            <Asterisk className="signature-rent-accent h-[17px] w-[17px] shrink-0" aria-hidden="true" />
          </p>
          <h2 id="signature-rent-title" className="signature-rent-heading">
            <span>Post a</span>
            <span>rent request</span>
            <span className="signature-rent-accent">here.</span>
          </h2>
          <div className="signature-rent-earnings">
            <p className="signature-rent-subtle text-xs font-bold">Earn up to</p>
            <p className="mt-0.5 text-[28px] font-black leading-tight">{formatUGX(40000)}<sup className="ml-0.5 text-sm">*</sup></p>
            <Button variant="link" className="signature-rent-how" onClick={() => setEarningsOpen(true)}>
              How do I earn? <ArrowUpRight className="!h-3 !w-3" aria-hidden="true" />
            </Button>
          </div>
          <Button className="signature-rent-post" onClick={onPostRequest}>
            <span>Post rent request</span>
            <span className="signature-rent-arrow" aria-hidden="true"><ArrowUpRight className="!h-5 !w-5" /></span>
          </Button>
        </div>
      </section>
      <Dialog open={earningsOpen} onOpenChange={setEarningsOpen}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <p className="text-xs font-bold uppercase text-primary">Welile agent commissions</p>
            <DialogTitle>How you earn</DialogTitle>
            <DialogDescription>Eligible earnings at each stage of a Rent Plan.</DialogDescription>
          </DialogHeader>
          <div className="divide-y divide-border">
            {[
              [formatUGX(5000), 'For an eligible posted rent request'],
              ['1%', 'Of a qualifying landlord payout'],
              ['10%', 'On qualifying rent repayments'],
            ].map(([amount, description], index) => (
              <div key={amount} className="flex items-center justify-between gap-3 py-4">
                <div><p className="text-xl font-extrabold text-primary">{amount}</p><p className="mt-1 text-xs text-muted-foreground">{description}</p></div>
                <span className="text-xs font-bold text-muted-foreground">0{index + 1}</span>
              </div>
            ))}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">* {formatUGX(40000)} is an illustrative promotional estimate, not a verified maximum or a guarantee. Actual earnings vary with the Rent Plan and commission rules.</p>
        </DialogContent>
      </Dialog>
    </>
  );
}