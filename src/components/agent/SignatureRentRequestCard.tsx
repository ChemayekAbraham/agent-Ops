import { useState } from 'react';
import { ArrowUpRight, Asterisk, CalendarCheck2, Percent, Wallet } from 'lucide-react';
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
        <button
          type="button"
          className="signature-rent-open"
          aria-label="Open rent request form"
          tabIndex={-1}
          onClick={onPostRequest}
        />
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
            <p className="signature-rent-subtle mt-0.5 text-[11px] font-bold leading-snug">in commissions</p>
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
        <DialogContent className="signature-earnings w-[min(340px,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden rounded-[22px] p-0 sm:rounded-[22px]">
          <div className="signature-earnings-hero">
            <p className="signature-earnings-eyebrow">Welile agent commissions</p>
            <DialogTitle className="mt-1 text-[22px] font-black leading-tight">How you earn</DialogTitle>
            <DialogDescription className="mt-1.5 text-xs leading-snug opacity-85">
              Eligible earnings at each stage of a Rent Plan.
            </DialogDescription>
          </div>
          <div className="signature-earnings-list">
            {[
              { Icon: Wallet, amount: formatUGX(5000), description: 'For an eligible posted rent request' },
              { Icon: Percent, amount: '1%', description: 'Of a qualifying landlord payout' },
              { Icon: CalendarCheck2, amount: '10%', description: 'On qualifying rent repayments' },
            ].map(({ Icon, amount, description }, index) => (
              <div key={amount} className="signature-earnings-row">
                <span className="signature-earnings-icon" aria-hidden="true">
                  <Icon className="!h-[18px] !w-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-extrabold leading-tight">{amount}</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{description}</p>
                </div>
                <span className="signature-earnings-step">0{index + 1}</span>
              </div>
            ))}
          </div>
          <div className="signature-earnings-note">
            <Asterisk className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            <p>
              {formatUGX(40000)} is an illustrative promotional estimate, not a verified maximum or a guarantee.
              Actual earnings vary with the Rent Plan and commission rules.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}