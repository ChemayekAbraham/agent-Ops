import { ArrowLeft, Users, Award, BookOpen, Download, ImageIcon, Share2, DollarSign, Star, Printer, Zap, MapPin, Bike, Wallet, HandCoins, Building2, UserPlus, TrendingUp, CheckCircle2, Home, FileText, ChevronDown, FileDown, Link2, MessageCircle } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import WelileLogo from '@/assets/welile-logo.jpeg';
import WelileServiceCentrePoster from '@/assets/welile-service-centre-poster.jpeg';
import { toast } from 'sonner';
import { ServiceCentreSubmissionForm } from '@/components/agent/ServiceCentreSubmissionForm';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { sharePdfViaWhatsApp } from '@/lib/whatsappShare';
import { generateAgentEarningsPdf, EARNINGS_SHARE_CAPTION, EARNINGS_SHARE_URL } from '@/lib/agentEarningsPdf';
import { formatUGX } from '@/lib/rentCalculations';

const AgentCommissionBenefits = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedSetupAmount = Number(searchParams.get('setup_amount') || 0);
  const requestNote = searchParams.get('sc_note') || '';
  const [generatingPdf, setGeneratingPdf] = useState(false);

  const handleShareWhatsApp = () => {
    const shareText = `💰 *How You Earn Money as a Welile Agent*

🏠 *Every Time Your Tenant Pays Rent — You Get 10%*

Example: If a tenant pays back UGX 100,000...
✅ You get UGX 10,000 automatically!

Here's how it works:
• The agent who REGISTERED the tenant gets *2%* (UGX 2,000)
• The agent MANAGING the tenant gets *8%* (UGX 8,000)
• If you registered AND manage the tenant — you keep the full *10%*!

👥 *Bonus for Recruiting Other Agents*
If you brought another agent to Welile, you get *2%* from every tenant THEY manage. It's free money!

💼 *Earn from Funders You Bring*
Bring an investor who funds rent → earn *2%* of their investment (1% on Angel Pool)!

🎁 *Extra Cash Bonuses*
• Help a tenant apply for rent → *UGX 5,000*
• List an empty house (paid after verification) → *UGX 2,000*
• A tenant moves into a house you listed → *UGX 5,000*
• Landlord on your rent request verified → *UGX 4,000*
• Sub-agent's house/landlord/LC1 verified → *UGX 1,000*
• Rent request posted & listed → *UGX 1,000*
• Replace a tenant in a house → *UGX 20,000*
• Register a new agent under you → *UGX 10,000*
• Set up a Welile Service Centre → *UGX 25,000*

💵 All your earnings go straight to your Welile Wallet.

👉 Join Welile as an Agent: https://welileapp.com/join`;

    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareText)}`;

    if (navigator.share) {
      navigator.share({
        title: 'How You Earn Money as a Welile Agent',
        text: shareText,
      }).catch(() => {
        window.open(whatsappUrl, '_blank');
      });
    } else {
      window.open(whatsappUrl, '_blank');
    }
    
    toast.success('Sharing commission benefits');
  };

  const handleSharePdf = async () => {
    if (generatingPdf) return;
    setGeneratingPdf(true);
    const t = toast.loading('Preparing your PDF…');
    try {
      const blob = await generateAgentEarningsPdf();
      const result = await sharePdfViaWhatsApp(blob, {
        filename: 'Welile-How-You-Earn.pdf',
        caption: EARNINGS_SHARE_CAPTION,
      });
      toast.dismiss(t);
      if (result === 'shared') toast.success('Opening WhatsApp with your PDF');
      else if (result === 'deeplink') toast.success('PDF saved — attach it in WhatsApp');
      else toast.dismiss(t);
    } catch (e) {
      toast.dismiss(t);
      toast.error('Could not create the PDF. Please try again.');
    } finally {
      setGeneratingPdf(false);
    }
  };

  const handleShareLink = async () => {
    const text = `${EARNINGS_SHARE_CAPTION}\n\n${EARNINGS_SHARE_URL}`;
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.share) {
      try {
        await nav.share({ title: 'How You Earn with Welile', text: EARNINGS_SHARE_CAPTION, url: EARNINGS_SHARE_URL });
        return;
      } catch {
        /* fall through to WhatsApp / copy */
      }
    }
    try {
      await navigator.clipboard.writeText(`${EARNINGS_SHARE_CAPTION}\n\n${EARNINGS_SHARE_URL}`);
      toast.success('Link copied — paste it in WhatsApp');
    } catch {
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-primary shadow-sm">
        <div className="px-3 py-2.5 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="text-primary-foreground hover:bg-white/10 rounded-xl h-10 w-10">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <img
            src={WelileLogo}
            alt="Welile"
            className="h-9 w-9 rounded-lg object-cover bg-card p-0.5 shrink-0"
          />
          <h1 className="text-lg font-bold text-primary-foreground flex-1 leading-tight">How You Earn 💰</h1>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="text-primary-foreground hover:bg-white/10 rounded-xl h-10 w-10">
                <Share2 className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={handleSharePdf} disabled={generatingPdf}>
                <FileDown className="h-4 w-4 mr-2 text-primary" />
                Share as PDF
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleShareLink}>
                <Link2 className="h-4 w-4 mr-2 text-primary" />
                Share as Link
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleShareWhatsApp}>
                <MessageCircle className="h-4 w-4 mr-2 text-primary" />
                Share text on WhatsApp
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="p-4 space-y-5 max-w-2xl mx-auto pb-8">

        {/* ========== PRIORITY: REGISTER A LANDLORD ========== */}
        <Card className="border-2 border-primary bg-primary/5 shadow-lg shadow-primary/10 overflow-hidden">
          <div className="bg-primary px-4 py-2 flex items-center gap-2">
            <Star className="h-5 w-5 text-primary-foreground fill-current" />
            <span className="text-sm font-extrabold text-primary-foreground uppercase tracking-wide">Your #1 Priority</span>
          </div>
          <CardContent className="p-4 space-y-4">
            <div className="flex items-start gap-3">
              <div className="p-3 rounded-2xl bg-primary/15 shrink-0">
                <Building2 className="h-8 w-8 text-primary" />
              </div>
              <div className="flex-1">
                <h2 className="text-xl font-extrabold text-foreground leading-tight">Register a Landlord</h2>
                <p className="text-base text-muted-foreground mt-1">This is the most important thing you can do. More landlords = more rent = more money for you. 🏆</p>
              </div>
            </div>

            <div className="rounded-2xl bg-primary text-primary-foreground p-4 text-center">
              <p className="text-sm font-semibold opacity-90">You earn when your landlord is verified</p>
              <p className="text-3xl font-extrabold mt-1">UGX 4,000</p>
              <p className="text-sm opacity-90 mt-1">…and then 10% of every rent payment forever!</p>
            </div>

            <div className="space-y-2.5">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-6 w-6 text-primary shrink-0" />
                <p className="text-base text-foreground">Find a landlord with houses to rent</p>
              </div>
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-6 w-6 text-primary shrink-0" />
                <p className="text-base text-foreground">Register them on the app</p>
              </div>
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-6 w-6 text-primary shrink-0" />
                <p className="text-base text-foreground">Get paid + start earning rent commission</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ========== ALL EARNING OPPORTUNITIES AT A GLANCE ========== */}
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="h-5 w-5 text-primary" />
              All Ways You Can Earn 💰
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-0">
            <p className="text-xs text-muted-foreground mb-3">Here is every opportunity to make money as a Welile Agent — all in one place:</p>
            <div className="rounded-xl border border-primary/20 overflow-hidden">
              <div className="bg-primary/10 px-3 py-2 text-xs font-bold text-foreground uppercase tracking-wide">
                📊 Your Earning Opportunities
              </div>
              <div className="divide-y divide-border/40">
                {/* Recurring */}
                <div className="px-3 py-2.5 flex items-start gap-2.5">
                  <DollarSign className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex justify-between items-start">
                      <p className="text-sm font-semibold text-foreground">Rent Repayment Commission</p>
                      <span className="text-xs font-bold text-primary whitespace-nowrap">10%</span>
                    </div>
                    <p className="text-sm text-muted-foreground">Every time your tenant pays rent — you earn 10% automatically, forever!</p>
                  </div>
                </div>

                <div className="px-3 py-2.5 flex items-start gap-2.5">
                  <Users className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex justify-between items-start">
                      <p className="text-sm font-semibold text-foreground">Recruiter Override</p>
                      <span className="text-xs font-bold text-primary whitespace-nowrap">2%</span>
                    </div>
                    <p className="text-sm text-muted-foreground">Earn 2% from every tenant managed by agents YOU recruited</p>
                  </div>
                </div>

                <div className="px-3 py-2.5 flex items-start gap-2.5">
                  <HandCoins className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex justify-between items-start">
                      <p className="text-sm font-semibold text-foreground">Collect Rent from Tenants</p>
                      <span className="text-xs font-bold text-muted-foreground whitespace-nowrap">Float</span>
                    </div>
                    <p className="text-sm text-muted-foreground">Go out and collect rent directly — record it in the app and build your collection streaks</p>
                  </div>
                </div>

                <div className="px-3 py-2.5 flex items-start gap-2.5">
                  <TrendingUp className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex justify-between items-start">
                      <p className="text-sm font-semibold text-foreground">Investment / Funder Commission</p>
                      <span className="text-xs font-bold text-primary whitespace-nowrap">2%</span>
                    </div>
                    <p className="text-sm text-muted-foreground">Bring a funder who invests — earn 2% on their investment (plus 1% on Angel Pool investments)</p>
                  </div>
                </div>

                {/* One-time bonuses */}
                <div className="bg-muted/30 px-3 py-1.5">
                  <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">One-Time Cash Bonuses</p>
                </div>

                <div className="px-3 py-2.5 flex items-start gap-2.5">
                  <Building2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex justify-between items-start">
                      <p className="text-sm font-semibold text-foreground">Set Up a Service Centre</p>
                      <span className="text-xs font-bold text-primary whitespace-nowrap">UGX 25,000</span>
                    </div>
                    <p className="text-sm text-muted-foreground">Print poster, mount it, submit photo + GPS — get paid after verification!</p>
                  </div>
                </div>

                <div className="px-3 py-2.5 flex items-start gap-2.5">
                  <Award className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex justify-between items-start">
                      <p className="text-sm font-semibold text-foreground">Replace a Tenant</p>
                      <span className="text-xs font-bold text-primary whitespace-nowrap">UGX 20,000</span>
                    </div>
                    <p className="text-sm text-muted-foreground">Find a new tenant for a vacated house</p>
                  </div>
                </div>

                <div className="px-3 py-2.5 flex items-start gap-2.5">
                  <UserPlus className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex justify-between items-start">
                      <p className="text-sm font-semibold text-foreground">Register a New Agent</p>
                      <span className="text-xs font-bold text-primary whitespace-nowrap">UGX 10,000</span>
                    </div>
                    <p className="text-sm text-muted-foreground">Bring someone new to join as a Welile agent under you</p>
                  </div>
                </div>

                <div className="px-3 py-2.5 flex items-start gap-2.5">
                  <BookOpen className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex justify-between items-start">
                      <p className="text-sm font-semibold text-foreground">Help a Tenant Apply for Rent</p>
                      <span className="text-xs font-bold text-primary whitespace-nowrap">UGX 5,000</span>
                    </div>
                    <p className="text-sm text-muted-foreground">Help post a rent request for a tenant who needs help</p>
                  </div>
                </div>

                <div className="px-3 py-2.5 flex items-start gap-2.5">
                  <MapPin className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex justify-between items-start">
                      <p className="text-sm font-semibold text-foreground">List an Empty House</p>
                      <span className="text-xs font-bold text-primary whitespace-nowrap">UGX 2,000</span>
                    </div>
                    <p className="text-sm text-muted-foreground">Find and list a vacant house — paid only after Landlord Ops verifies the listing</p>
                  </div>
                </div>

                <div className="px-3 py-2.5 flex items-start gap-2.5">
                  <Home className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex justify-between items-start">
                      <p className="text-sm font-semibold text-foreground">Tenant Placed in Your Listed House</p>
                      <span className="text-xs font-bold text-primary whitespace-nowrap">UGX 5,000</span>
                    </div>
                    <p className="text-sm text-muted-foreground">When an empty house you listed gets its first tenant — automatic bonus to you</p>
                  </div>
                </div>

                <div className="px-3 py-3 flex items-start gap-2.5 bg-primary/10 border-l-4 border-primary">
                  <Building2 className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex justify-between items-start">
                      <p className="text-base font-bold text-foreground">⭐ Register a Landlord</p>
                      <span className="text-sm font-bold text-primary whitespace-nowrap">UGX 4,000</span>
                    </div>
                    <p className="text-sm text-muted-foreground">Your #1 priority — earn when your landlord is verified, then 10% of rent forever</p>
                  </div>
                </div>

                <div className="px-3 py-2.5 flex items-start gap-2.5">
                  <FileText className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex justify-between items-start">
                      <p className="text-sm font-semibold text-foreground">Rent Request Posted &amp; Listed</p>
                      <span className="text-xs font-bold text-primary whitespace-nowrap">UGX 1,000</span>
                    </div>
                    <p className="text-sm text-muted-foreground">A small bonus when your rent request is posted and listed</p>
                  </div>
                </div>

                <div className="px-3 py-2.5 flex items-start gap-2.5">
                  <Users className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex justify-between items-start">
                      <p className="text-sm font-semibold text-foreground">Sub-Agent Verification Override</p>
                      <span className="text-xs font-bold text-primary whitespace-nowrap">UGX 3,000</span>
                    </div>
                    <p className="text-sm text-muted-foreground">When a house, landlord or LC1 chairperson submitted by an agent you recruited is verified</p>
                  </div>
                </div>

                {/* Career growth */}
                <div className="bg-muted/30 px-3 py-1.5">
                  <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Career Growth Rewards</p>
                </div>

                <div className="px-3 py-2.5 flex items-start gap-2.5">
                  <Wallet className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex justify-between items-start">
                      <p className="text-sm font-semibold text-foreground">Cash Advance Access</p>
                      <span className="text-xs font-bold text-muted-foreground whitespace-nowrap">2+ agents</span>
                    </div>
                    <p className="text-sm text-muted-foreground">Recruit 2+ sub-agents and become a Team Leader — unlock cash advances from Welile</p>
                  </div>
                </div>

                <div className="px-3 py-2.5 flex items-start gap-2.5">
                  <Bike className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex justify-between items-start">
                      <p className="text-sm font-semibold text-foreground">Electric Bike Reward 🏍️</p>
                      <span className="text-xs font-bold text-muted-foreground whitespace-nowrap">50 tenants</span>
                    </div>
                    <p className="text-sm text-muted-foreground">Manage 50 active tenants and earn an electric bike to boost your fieldwork!</p>
                  </div>
                </div>

                <div className="px-3 py-2.5 flex items-start gap-2.5">
                  <Share2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="flex justify-between items-start">
                      <p className="text-sm font-semibold text-foreground">Invite a Funder</p>
                      <span className="text-xs font-bold text-muted-foreground whitespace-nowrap">Referral</span>
                    </div>
                    <p className="text-sm text-muted-foreground">Share your referral link to bring investors who fund rent — helping you and your tenants</p>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ========== COLLAPSIBLE DETAILED SECTIONS ========== */}
        <div className="space-y-3">

          {/* How the 10% is Shared */}
          <Collapsible>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="group pb-2 cursor-pointer hover:bg-muted/50 transition-colors rounded-t-xl flex-row items-center gap-2">
                  <CardTitle className="flex items-center gap-2 text-base flex-1">
                    <div className="p-1.5 rounded-lg bg-primary/10">
                      <DollarSign className="h-4 w-4 text-primary" />
                    </div>
                    How the 10% is Shared
                  </CardTitle>
                  <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <p>When a tenant pays back rent, <span className="font-semibold text-foreground">two agents can earn</span> from that payment:</p>

                  <div className="space-y-3">
                    <div className="rounded-xl bg-muted/40 p-3">
                      <p className="font-semibold text-foreground text-sm">1️⃣ The Agent Who Registered the Tenant</p>
                      <p className="text-xs mt-1">This is the person who first brought the tenant to Welile. You get <span className="font-bold text-primary">2%</span> of every repayment — forever!</p>
                    </div>
                    <div className="rounded-xl bg-muted/40 p-3">
                      <p className="font-semibold text-foreground text-sm">2️⃣ The Agent Managing the Tenant Now</p>
                      <p className="text-xs mt-1">This is the agent currently assigned to the tenant. You get <span className="font-bold text-primary">8%</span> of every repayment.</p>
                    </div>
                    <div className="rounded-xl bg-primary/10 border border-primary/20 p-3">
                      <p className="font-semibold text-foreground text-sm">⭐ If You Are Both?</p>
                      <p className="text-xs mt-1">If you registered the tenant AND you are managing them — you keep the <span className="font-bold text-primary">full 10%</span>! That's the best position to be in.</p>
                    </div>
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>

          {/* Real Money Example */}
          <Collapsible>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="group pb-2 cursor-pointer hover:bg-muted/50 transition-colors rounded-t-xl flex-row items-center gap-2">
                  <CardTitle className="flex items-center gap-2 text-base flex-1">
                    <div className="p-1.5 rounded-lg bg-primary/10">
                      <BookOpen className="h-4 w-4 text-primary" />
                    </div>
                    Real Money Example
                  </CardTitle>
                  <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="space-y-3 text-sm">
                  <p className="text-muted-foreground">Let's say a tenant pays back <span className="font-bold text-foreground">UGX 100,000</span>. Here's who gets paid:</p>

                  <div className="rounded-xl border border-border/60 overflow-hidden">
                    <div className="bg-muted/50 px-3 py-2 font-semibold text-foreground text-xs uppercase tracking-wide">
                      💰 Who Gets What
                    </div>
                    <div className="divide-y divide-border/40">
                      <div className="flex justify-between px-3 py-2.5">
                        <span className="text-muted-foreground">Agent who registered tenant (2%)</span>
                        <span className="font-bold text-foreground">UGX 2,000</span>
                      </div>
                      <div className="flex justify-between px-3 py-2.5">
                        <span className="text-muted-foreground">Agent managing tenant (8%)</span>
                        <span className="font-bold text-foreground">UGX 8,000</span>
                      </div>
                      <div className="flex justify-between px-3 py-2.5 bg-primary/5">
                        <span className="font-semibold text-foreground">Total Earned</span>
                        <span className="font-bold text-primary">UGX 10,000</span>
                      </div>
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground italic">💡 If you're both the registering agent and the manager, you take home the full UGX 10,000!</p>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>

          {/* Recruiter Bonus */}
          <Collapsible>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="group pb-2 cursor-pointer hover:bg-muted/50 transition-colors rounded-t-xl flex-row items-center gap-2">
                  <CardTitle className="flex items-center gap-2 text-base flex-1">
                    <div className="p-1.5 rounded-lg bg-accent/50">
                      <Users className="h-4 w-4 text-primary" />
                    </div>
                    Earn from Agents You Recruit
                  </CardTitle>
                  <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <p>Did you bring another agent to Welile? <span className="font-semibold text-foreground">You earn 2% from every tenant they manage!</span></p>

                  <div className="rounded-xl bg-muted/40 p-3 space-y-2">
                    <p className="text-xs font-semibold text-foreground">📖 Example:</p>
                    <p className="text-xs">You recruited Agent Mary. Mary manages a tenant who pays UGX 100,000.</p>
                    <div className="space-y-1 mt-2">
                      <div className="flex justify-between text-xs"><span>Agent who registered tenant</span><span className="font-medium text-foreground">UGX 2,000 (2%)</span></div>
                      <div className="flex justify-between text-xs"><span>Mary (managing agent)</span><span className="font-medium text-foreground">UGX 6,000 (6%)</span></div>
                      <div className="flex justify-between text-xs"><span>You (recruited Mary) 🎉</span><span className="font-medium text-foreground">UGX 2,000 (2%)</span></div>
                      <div className="flex justify-between text-xs border-t border-border/40 pt-1.5 font-semibold text-foreground"><span>Total</span><span>UGX 10,000 (10%)</span></div>
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground italic">💡 The more agents you recruit, the more you earn — without doing extra work!</p>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>

          {/* Extra Cash Bonuses — defaultOpen because landlord is priority */}
          <Collapsible defaultOpen>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="group pb-2 cursor-pointer hover:bg-muted/50 transition-colors rounded-t-xl flex-row items-center gap-2">
                  <CardTitle className="flex items-center gap-2 text-base flex-1">
                    <div className="p-1.5 rounded-lg bg-primary/10">
                      <Award className="h-4 w-4 text-primary" />
                    </div>
                    Extra Cash Bonuses 🎁
                  </CardTitle>
                  <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="space-y-1">
                  <p className="text-sm text-muted-foreground mb-3">You also earn bonus cash for helping Welile grow:</p>

                  <div className="rounded-xl border border-border/60 overflow-hidden">
                    <div className="divide-y divide-border/40">
                      <div className="flex justify-between items-center px-3 py-3 bg-primary/5">
                        <div>
                          <p className="text-sm font-medium text-foreground">🏪 Set up a Service Centre</p>
                          <p className="text-xs text-muted-foreground">Print poster, mount, submit photo + GPS</p>
                        </div>
                        <span className="font-bold text-primary whitespace-nowrap">UGX 25,000</span>
                      </div>
                      <div className="flex justify-between items-center px-3 py-3">
                        <div>
                          <p className="text-sm font-medium text-foreground">Replace a tenant</p>
                          <p className="text-xs text-muted-foreground">Find a new tenant for a vacated house</p>
                        </div>
                        <span className="font-bold text-primary whitespace-nowrap">UGX 20,000</span>
                      </div>
                      <div className="flex justify-between items-center px-3 py-3">
                        <div>
                          <p className="text-sm font-medium text-foreground">Register a new agent</p>
                          <p className="text-xs text-muted-foreground">Bring someone new to join as a Welile agent</p>
                        </div>
                        <span className="font-bold text-primary whitespace-nowrap">UGX 10,000</span>
                      </div>
                      <div className="flex justify-between items-center px-3 py-3">
                        <div>
                          <p className="text-sm font-medium text-foreground">Help a tenant apply for rent</p>
                          <p className="text-xs text-muted-foreground">When you help post a rent request</p>
                        </div>
                        <span className="font-bold text-primary whitespace-nowrap">UGX 5,000</span>
                      </div>
                      <div className="flex justify-between items-center px-3 py-3">
                        <div>
                          <p className="text-sm font-medium text-foreground">List an empty house</p>
                          <p className="text-xs text-muted-foreground">Paid only after Landlord Ops verifies the listing</p>
                        </div>
                        <span className="font-bold text-primary whitespace-nowrap">UGX 2,000</span>
                      </div>
                      <div className="flex justify-between items-center px-3 py-3">
                        <div>
                          <p className="text-sm font-medium text-foreground">Tenant placed in your listed house</p>
                          <p className="text-xs text-muted-foreground">When an empty house you listed gets its first tenant</p>
                        </div>
                        <span className="font-bold text-primary whitespace-nowrap">UGX 5,000</span>
                      </div>
                      <div className="flex justify-between items-center px-3 py-3 bg-primary/10 border-l-4 border-primary">
                        <div>
                          <p className="text-base font-bold text-foreground">⭐ Register a landlord</p>
                          <p className="text-sm text-muted-foreground">Your #1 priority — earn when your landlord is verified</p>
                        </div>
                        <span className="font-bold text-primary whitespace-nowrap">UGX 4,000</span>
                      </div>
                      <div className="flex justify-between items-center px-3 py-3">
                        <div>
                          <p className="text-sm font-medium text-foreground">Sub-agent verification override</p>
                          <p className="text-xs text-muted-foreground">A house, landlord or LC1 from an agent you recruited gets verified</p>
                        </div>
                        <span className="font-bold text-primary whitespace-nowrap">UGX 3,000</span>
                      </div>
                      <div className="flex justify-between items-center px-3 py-3">
                        <div>
                          <p className="text-sm font-medium text-foreground">Rent request posted &amp; listed</p>
                          <p className="text-xs text-muted-foreground">Small bonus when your rent request is posted and listed</p>
                        </div>
                        <span className="font-bold text-primary whitespace-nowrap">UGX 1,000</span>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>

          {/* Career Growth */}
          <Collapsible>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="group pb-2 cursor-pointer hover:bg-muted/50 transition-colors rounded-t-xl flex-row items-center gap-2">
                  <CardTitle className="flex items-center gap-2 text-base flex-1">
                    <div className="p-1.5 rounded-lg bg-primary/10">
                      <Zap className="h-4 w-4 text-primary" />
                    </div>
                    Career Growth & Rewards 🚀
                  </CardTitle>
                  <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <p>The harder you work, the more Welile rewards you. Here's what's ahead:</p>

                  <div className="space-y-3">
                    <div className="rounded-xl bg-muted/40 p-3">
                      <p className="font-semibold text-foreground text-sm">🎖️ Team Leader (2+ Sub-Agents)</p>
                      <p className="text-xs mt-1">Recruit at least 2 agents under you and become a <span className="font-bold text-foreground">Team Leader</span>. This unlocks <span className="font-bold text-primary">cash advances</span> from Welile — money you can use for your fieldwork and pay back over time.</p>
                    </div>
                    <div className="rounded-xl bg-muted/40 p-3">
                      <p className="font-semibold text-foreground text-sm">🏍️ Electric Bike (50 Active Tenants)</p>
                      <p className="text-xs mt-1">Manage <span className="font-bold text-foreground">50 active tenants</span> and earn a <span className="font-bold text-primary">free electric bike</span> from Welile! This helps you move faster and serve more tenants.</p>
                    </div>
                    <div className="rounded-xl bg-muted/40 p-3">
                      <p className="font-semibold text-foreground text-sm">🔗 Invite a Funder</p>
                      <p className="text-xs mt-1">Share your referral link with potential investors. When a funder you bring invests, you earn a <span className="font-bold text-primary">2% commission</span> on their investment (and <span className="font-bold text-primary">1%</span> on Angel Pool investments) — tenants get rent, you get paid, and the funder earns returns.</p>
                    </div>
                    <div className="rounded-xl bg-muted/40 p-3">
                      <p className="font-semibold text-foreground text-sm">📈 Collection Streaks</p>
                      <p className="text-xs mt-1">Collect rent consistently and build <span className="font-bold text-foreground">collection streaks</span>. Longer streaks earn you <span className="font-bold text-primary">streak multiplier badges</span> and increase your performance tier.</p>
                    </div>
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>

          {/* Where does the money go */}
          <Collapsible>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="group pb-2 cursor-pointer hover:bg-muted/50 transition-colors rounded-t-xl flex-row items-center gap-2">
                  <CardTitle className="flex items-center gap-2 text-base flex-1">
                    <div className="p-1.5 rounded-lg bg-muted">
                      <Star className="h-4 w-4 text-primary" />
                    </div>
                    Where Does My Money Go?
                  </CardTitle>
                  <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="text-sm text-muted-foreground space-y-2">
                  <p>All the money you earn goes straight into your <span className="font-semibold text-foreground">Welile Wallet</span>. You can see every earning clearly:</p>
                  <ul className="space-y-1.5">
                    <li className="flex gap-2">
                      <span className="text-primary">✅</span>
                      <span>How much you earned</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="text-primary">✅</span>
                      <span>Which tenant the money came from</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="text-primary">✅</span>
                      <span>Why you earned it (registration, managing, bonus, etc.)</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="text-primary">✅</span>
                      <span>You can withdraw anytime to Mobile Money</span>
                    </li>
                  </ul>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>

          {/* Service Centre Setup (grouped) */}
          <Collapsible>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="group pb-2 cursor-pointer hover:bg-muted/50 transition-colors rounded-t-xl flex-row items-center gap-2">
                  <CardTitle className="flex items-center gap-2 text-base flex-1">
                    <div className="p-1.5 rounded-lg bg-primary/10">
                      <ImageIcon className="h-4 w-4 text-primary" />
                    </div>
                    Service Centre Setup 🏪
                  </CardTitle>
                  <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="space-y-6">
                  <p className="text-sm text-muted-foreground">Download these images to print and set up your own Welile Service Centre.</p>

                  <div className="space-y-3">
                    <div className="rounded-xl border border-border/60 overflow-hidden bg-muted/30">
                      <img src={WelileLogo} alt="Welile Logo" className="w-full object-contain" />
                    </div>
                    <p className="text-sm font-semibold text-foreground text-center">Welile Logo</p>
                    <Button variant="outline" asChild className="w-full gap-2">
                      <a href={WelileLogo} download="WELILE_LOGO.jpeg">
                        <Download className="h-4 w-4" />
                        Download Welile Logo
                      </a>
                    </Button>
                  </div>

                  <div className="space-y-3">
                    <div className="rounded-xl border border-border/60 overflow-hidden bg-muted/30">
                      <img src={WelileServiceCentrePoster} alt="Welile Service Centre Poster" className="w-full object-contain" />
                    </div>
                    <p className="text-sm font-semibold text-foreground text-center">Welile Service Centre Poster</p>
                    <Button variant="outline" asChild className="w-full gap-2">
                      <a href={WelileServiceCentrePoster} download="WELILE_SERVICE_CENTRE_POSTER.jpeg">
                        <Download className="h-4 w-4" />
                        Download Service Centre Poster
                      </a>
                    </Button>
                  </div>

                  {/* Printing Instructions */}
                  <div className="space-y-4 text-sm text-muted-foreground pt-2 border-t border-border/40">
                    <p className="font-semibold text-foreground">How to Print & Set Up Your Service Centre 🖨️</p>
                    <div className="space-y-3">
                      <div className="rounded-xl bg-muted/40 p-3">
                        <p className="font-semibold text-foreground">Step 1: Download the Images ⬇️</p>
                        <p className="text-xs mt-1">Tap the download buttons above to save the <span className="font-medium text-foreground">Welile Logo</span> and the <span className="font-medium text-foreground">Service Centre Poster</span> to your phone.</p>
                      </div>

                      <div className="rounded-xl bg-muted/40 p-3">
                        <p className="font-semibold text-foreground">Step 2: Go to Any Print Shop 🖨️</p>
                        <p className="text-xs mt-1">Take your phone to any nearby print shop (cyber café, stationery shop). Show them the downloaded images and ask them to print:</p>
                        <ul className="text-xs mt-2 space-y-1 ml-3">
                          <li>• <span className="font-medium text-foreground">Poster:</span> Print on <span className="font-bold">A3</span> or <span className="font-bold">A2</span> paper (big size for walls)</li>
                          <li>• <span className="font-medium text-foreground">Logo:</span> Print on <span className="font-bold">A4</span> paper (normal size for windows/doors)</li>
                          <li>• Ask for <span className="font-medium text-foreground">colour printing</span> on thick/glossy paper</li>
                        </ul>
                      </div>

                      <div className="rounded-xl bg-muted/40 p-3">
                        <p className="font-semibold text-foreground">Step 3: Official Colour Codes 🎨</p>
                        <p className="text-xs mt-1">Tell the print shop to use these exact colours:</p>
                        <div className="flex gap-3 mt-2">
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-md border" style={{ backgroundColor: '#7214c9' }} />
                            <div>
                              <p className="text-xs font-bold text-foreground">Purple</p>
                              <p className="text-xs font-mono">#7214c9</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-md border bg-card" />
                            <div>
                              <p className="text-xs font-bold text-foreground">White</p>
                              <p className="text-xs font-mono">#FFFFFF</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-md border bg-black" />
                            <div>
                              <p className="text-xs font-bold text-foreground">Black</p>
                              <p className="text-xs font-mono">#000000</p>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-xl bg-muted/40 p-3">
                        <p className="font-semibold text-foreground">Step 4: Mount at Your Location 📌</p>
                        <p className="text-xs mt-1">Put up the poster and logo where people can easily see them:</p>
                        <ul className="text-xs mt-2 space-y-1 ml-3">
                          <li>• On a <span className="font-medium text-foreground">visible wall</span> facing the road or walkway</li>
                          <li>• On a <span className="font-medium text-foreground">window or glass door</span></li>
                          <li>• On a <span className="font-medium text-foreground">signboard</span> at the entrance</li>
                          <li>• Make sure it's <span className="font-medium text-foreground">not blocked</span> by anything</li>
                        </ul>
                      </div>

                      <div className="rounded-xl bg-primary/10 border border-primary/20 p-3">
                        <p className="font-semibold text-foreground">Step 5: Take a Photo & Submit Below 📸</p>
                        <p className="text-xs mt-1">After mounting, take a clear photo of your setup and submit it below. Once verified by Agent Ops and approved by the CFO, you will earn <span className="font-bold text-primary">UGX 25,000</span> straight to your wallet!</p>
                      </div>
                    </div>
                  </div>

                  {requestedSetupAmount > 0 && (
                    <div className="rounded-xl border border-primary/30 bg-primary/10 p-3 mb-3">
                      <p className="text-sm font-semibold text-foreground">Service centre requested for you</p>
                      <p className="text-xs mt-1">
                        Setup amount needed: <span className="font-bold text-primary">{formatUGX(requestedSetupAmount)}</span>
                      </p>
                      {requestNote && <p className="text-xs mt-1 text-muted-foreground">{requestNote}</p>}
                    </div>
                  )}
                  <ServiceCentreSubmissionForm />
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>

        </div>

        {/* Share CTA */}
        <div className="space-y-3">
          <p className="text-center text-sm font-semibold text-muted-foreground">Share this page with other agents 👇</p>
          <div className="grid grid-cols-2 gap-3">
            <Button
              onClick={handleSharePdf}
              disabled={generatingPdf}
              className="w-full gap-2 bg-[#25D366] hover:bg-[#1da851] text-white font-semibold py-6 rounded-xl text-base"
            >
              <FileDown className="h-5 w-5" />
              {generatingPdf ? 'Preparing…' : 'Send PDF'}
            </Button>
            <Button
              onClick={handleShareLink}
              variant="outline"
              className="w-full gap-2 border-2 border-primary text-primary font-semibold py-6 rounded-xl text-base"
            >
              <Link2 className="h-5 w-5" />
              Send Link
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AgentCommissionBenefits;
