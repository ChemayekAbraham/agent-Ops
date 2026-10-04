import React from 'react';
import { Helmet } from 'react-helmet-async';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Printer, Share2, Users, Building2, TrendingUp, Smartphone,
  Zap, Check, Coins, BarChart3, Clock, FileText, Database, Shield, Globe, Award,
  Phone, MapPin
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

export default function Brochure() {
  const navigate = useNavigate();

  const handlePrint = () => {
    window.print();
  };

  const handleShare = async () => {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Welile Technologies Limited — Official Tri-Fold Brochure',
          text: 'Turning Rent into an Asset — A smarter rental ecosystem for Africa.',
          url,
        });
      } catch {
        // User dismissed share dialog
      }
    } else {
      navigator.clipboard.writeText(url);
      toast.success('Brochure link copied to clipboard!');
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-900 selection:bg-purple-500/30">
      <Helmet>
        <title>Official Corporate Brochure | Welile Technologies Limited</title>
        <meta
          name="description"
          content="Welile Technologies Limited — Turning Rent into an Asset. A smarter rental ecosystem for Africa connecting tenants, landlords, partners and agents."
        />
        <link rel="canonical" href="https://welileapp.com/brochure" />
      </Helmet>

      {/* ── Screen Navigation Bar (Hidden in Print) ── */}
      <header className="sticky top-0 z-50 border-b border-white/10 bg-slate-900/90 backdrop-blur-md print:hidden text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate(-1)}
              className="h-9 px-2.5 gap-1.5 text-slate-300 hover:text-white hover:bg-white/10"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline text-xs font-semibold">Back</span>
            </Button>
            <div className="h-4 w-px bg-white/20 hidden sm:block" />
            <div className="flex items-center gap-2">
              <span className="font-extrabold text-sm tracking-wide text-white">
                WELILE TECHNOLOGIES LIMITED
              </span>
              <span className="hidden md:inline text-xs text-amber-400 font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-400/10 border border-amber-400/20">
                Official Tri-Fold Brochure
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleShare}
              className="h-9 px-3 gap-1.5 text-xs font-semibold bg-white/5 border-white/20 text-white hover:bg-white/15"
            >
              <Share2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Share</span>
            </Button>
            <Button
              size="sm"
              onClick={handlePrint}
              className="h-9 px-4 gap-1.5 text-xs font-bold bg-amber-500 hover:bg-amber-600 text-slate-950 shadow-md transition-transform active:scale-95"
            >
              <Printer className="h-3.5 w-3.5" />
              <span>Print Tri-Fold / Save PDF</span>
            </Button>
          </div>
        </div>
      </header>

      {/* ── Print Style Overrides ── */}
      <style>{`
        @media print {
          @page {
            size: A4 landscape;
            margin: 5mm;
          }
          *, *::before, *::after {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
            color-adjust: exact !important;
          }
          body, #root, main {
            background: #ffffff !important;
            padding: 0 !important;
            margin: 0 !important;
          }
        }
      `}</style>

      {/* ── Print Tip Instruction (Visible on Screen) ── */}
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 pt-4 print:hidden">
        <div className="bg-purple-950/90 border-2 border-amber-400 rounded-xl p-3.5 flex items-center gap-3 text-white text-xs shadow-md">
          <span className="bg-amber-400 text-slate-950 font-black text-[10px] px-2 py-0.5 rounded uppercase tracking-wider shrink-0">
            💡 Full Color Printing
          </span>
          <span>
            When printing: set <strong>Layout to Landscape</strong>, click <strong>More settings</strong>, and check <strong>☑ Background graphics</strong> so all rich colors, cards and photos print.
          </span>
        </div>
      </div>

      {/* ── Tri-Fold Brochure Canvas ── */}
      <main className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12 print:p-0 print:m-0 print:max-w-none">
        <div className="grid grid-cols-1 lg:grid-cols-3 bg-white rounded-3xl overflow-hidden shadow-2xl border border-white/20 print:border-none print:shadow-none print:rounded-none">

          {/* ══════════════════════════════════════════════════════════════════
              PANEL 1 (LEFT): COVER & THE CHALLENGE
          ══════════════════════════════════════════════════════════════════ */}
          <section className="p-7 sm:p-9 flex flex-col justify-between border-b lg:border-b-0 lg:border-r border-slate-200 bg-white print:p-5">
            <div>
              {/* Logo */}
              <div className="mb-6">
                <div className="font-extrabold text-4xl tracking-tight text-purple-900 leading-none" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                  welile
                </div>
                <div className="text-[10px] font-extrabold tracking-[0.18em] text-slate-500 uppercase mt-1">
                  TECHNOLOGIES LIMITED
                </div>
              </div>

              {/* Punchy Title */}
              <div className="mb-4">
                <span className="text-xl font-extrabold text-slate-900 tracking-tight block">TURNING</span>
                <span className="text-5xl sm:text-6xl font-black text-purple-800 tracking-tight block leading-[0.95]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                  RENT
                </span>
                <span className="text-xl font-extrabold text-slate-900 tracking-tight block">INTO AN</span>
                <span className="text-4xl sm:text-5xl font-black text-slate-950 tracking-tight block" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                  ASSET
                </span>
              </div>

              <p className="text-xs sm:text-[13px] text-slate-600 leading-relaxed font-medium mb-5">
                Welile Technologies is a technology company building a smarter rental ecosystem that connects tenants, landlords, partners and agents through one trusted platform.
              </p>

              {/* Hero Image & Quote Card */}
              <div className="relative rounded-2xl overflow-hidden mb-6 bg-slate-100 shadow-sm">
                <img
                  src="/welile_tenant_hero.jpg"
                  alt="Welile Tenant using phone"
                  className="w-full h-64 object-cover object-top"
                />
                <div className="absolute bottom-3 left-3 right-3 bg-purple-950/95 backdrop-blur-md text-white p-3.5 rounded-xl border-l-4 border-amber-400 shadow-lg">
                  <p className="text-[11.5px] font-semibold leading-snug">
                    <span className="text-amber-400 font-extrabold text-sm mr-1">“</span>
                    We help tenants access rent, landlords get paid on time, and partners grow their money – while building financial identity through everyday behaviour.
                    <span className="text-amber-400 font-extrabold text-sm ml-1">”</span>
                  </p>
                </div>
              </div>
            </div>

            {/* The Challenge Section */}
            <div>
              <div className="rounded-2xl bg-purple-950 text-white p-5 sm:p-6 space-y-3 shadow-inner">
                <div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-widest text-amber-400 pb-1 border-b border-white/15">
                  <span>THE CHALLENGE</span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Many people earn income daily, weekly or through irregular streams, yet rent is often demanded as a large lump sum.
                </p>

                <div className="flex items-center justify-between gap-3 bg-white/10 rounded-xl p-3 text-xs">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-lg bg-white/15 flex items-center justify-center shrink-0">
                      <Coins className="h-4 w-4 text-white" />
                    </div>
                    <span className="font-bold leading-tight">Income comes in small amounts</span>
                  </div>
                  <span className="text-amber-400 font-black text-sm">→</span>
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-lg bg-white/15 flex items-center justify-center shrink-0">
                      <Building2 className="h-4 w-4 text-white" />
                    </div>
                    <span className="font-bold leading-tight">Rent is demanded in large amounts</span>
                  </div>
                </div>

                <p className="text-[11px] text-slate-400 pt-2 border-t border-white/10 leading-normal">
                  This creates rent pressure for tenants, uncertainty for landlords and missed opportunities for the ecosystem.
                </p>
              </div>

              {/* Bottom KPI bar */}
              <div className="grid grid-cols-4 gap-2 bg-purple-900/90 text-white p-3 rounded-xl text-center mt-3">
                <div>
                  <Users className="h-4 w-4 text-amber-400 mx-auto mb-1" />
                  <span className="text-[9.5px] font-bold block leading-tight text-slate-200">Thriving Tenant Network</span>
                </div>
                <div>
                  <Building2 className="h-4 w-4 text-amber-400 mx-auto mb-1" />
                  <span className="text-[9.5px] font-bold block leading-tight text-slate-200">Thousands of Landlords</span>
                </div>
                <div>
                  <TrendingUp className="h-4 w-4 text-amber-400 mx-auto mb-1" />
                  <span className="text-[9.5px] font-bold block leading-tight text-slate-200">Active Partners</span>
                </div>
                <div>
                  <BarChart3 className="h-4 w-4 text-amber-400 mx-auto mb-1" />
                  <span className="text-[9.5px] font-bold block leading-tight text-slate-200">Financial Identity</span>
                </div>
              </div>
            </div>
          </section>

          {/* ══════════════════════════════════════════════════════════════════
              PANEL 2 (CENTER): HOW IT WORKS & ECOSYSTEM
          ══════════════════════════════════════════════════════════════════ */}
          <section className="p-7 sm:p-9 flex flex-col justify-between border-b lg:border-b-0 lg:border-r border-slate-200 bg-white print:p-5">
            <div>
              {/* Ribbon Title */}
              <div className="text-center relative mb-5">
                <span className="bg-white px-3 text-xs font-black tracking-widest text-purple-900 uppercase relative z-10" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                  HOW WELILE WORKS
                </span>
                <div className="absolute top-1/2 left-0 right-0 h-px bg-slate-200" />
              </div>

              {/* 5-Step Process Timeline */}
              <div className="space-y-3.5 relative mb-7">
                {[
                  {
                    num: '1',
                    title: 'TENANT APPLIES',
                    desc: 'Tenant applies for rent support through the Welile platform or a Welile service centre.',
                    icon: Users,
                  },
                  {
                    num: '2',
                    title: 'VERIFICATION',
                    desc: 'Welile verifies the tenant, landlord and rental information to ensure transparency and trust.',
                    icon: Shield,
                  },
                  {
                    num: '3',
                    title: 'RENT PAYMENT',
                    desc: 'Welile facilitates payment of the approved rent to the verified landlord.',
                    icon: Building2,
                  },
                  {
                    num: '4',
                    title: 'REPAYMENT',
                    desc: 'The tenant repays Welile in small, manageable instalments based on the agreed schedule.',
                    icon: Smartphone,
                  },
                  {
                    num: '5',
                    title: 'TRACKING & RECORDS',
                    desc: 'Payments are recorded digitally, creating a reliable rental behaviour history that builds financial identity.',
                    icon: BarChart3,
                  },
                ].map((step, i) => {
                  const StepIcon = step.icon;
                  return (
                    <div key={i} className="flex items-start gap-3">
                      <div className="h-5 w-5 rounded-full bg-purple-900 text-white font-extrabold text-[10px] flex items-center justify-center shrink-0 mt-1">
                        {step.num}
                      </div>
                      <div className="h-9 w-9 rounded-full bg-purple-100 border-2 border-purple-800 text-purple-900 flex items-center justify-center shrink-0">
                        <StepIcon className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wide leading-tight">
                          {step.title}
                        </h4>
                        <p className="text-[11px] text-slate-600 leading-snug mt-0.5">
                          {step.desc}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Ribbon Title */}
              <div className="text-center relative mb-4">
                <span className="bg-white px-3 text-xs font-black tracking-widest text-purple-900 uppercase relative z-10" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                  THE WELILE ECOSYSTEM
                </span>
                <div className="absolute top-1/2 left-0 right-0 h-px bg-slate-200" />
              </div>

              {/* Central Hub Diagram */}
              <div className="bg-purple-50/70 border border-purple-200 rounded-2xl p-4 mb-4">
                <div className="flex flex-col items-center gap-2.5">
                  {/* Top: Tenants */}
                  <div className="bg-purple-800 text-white text-[10.5px] font-bold px-3 py-1 rounded-md shadow-xs flex items-center gap-1.5">
                    <Users className="h-3 w-3" />
                    <span>TENANTS · Need rent access</span>
                  </div>

                  {/* Middle Row */}
                  <div className="flex items-center justify-between w-full gap-2">
                    {/* Left: Partners */}
                    <div className="bg-sky-600 text-white p-2 rounded-lg text-center flex-1">
                      <strong className="text-[10px] font-extrabold block">TENANT PARTNERS</strong>
                      <span className="text-[8.5px] opacity-90 block">Provide support for rent transactions</span>
                    </div>

                    {/* Center: Hub */}
                    <div className="h-24 w-24 rounded-full bg-purple-950 text-white flex flex-col items-center justify-center text-center p-2 shrink-0 ring-4 ring-purple-300">
                      <span className="font-black text-sm leading-none" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                        welile
                      </span>
                      <span className="text-[7.5px] font-bold text-amber-400 tracking-wider uppercase mt-0.5">
                        TECHNOLOGY
                      </span>
                      <span className="text-[6.5px] text-slate-300 leading-tight mt-1">
                        Verification • Payments<br />Data • Platform
                      </span>
                    </div>

                    {/* Right: Landlords */}
                    <div className="bg-emerald-700 text-white p-2 rounded-lg text-center flex-1">
                      <strong className="text-[10px] font-extrabold block">LANDLORDS</strong>
                      <span className="text-[8.5px] opacity-90 block">Receive timely rent payments</span>
                    </div>
                  </div>

                  {/* Bottom: Agents */}
                  <div className="bg-amber-600 text-white text-[10.5px] font-bold px-3 py-1 rounded-md shadow-xs">
                    AGENTS · Onboard, support and connect participants
                  </div>
                </div>
              </div>
            </div>

            {/* Our Tech Powers Strip */}
            <div className="rounded-xl bg-purple-950 text-white p-3.5 mt-auto">
              <span className="text-[10px] font-extrabold uppercase tracking-widest text-amber-400 text-center block mb-2.5">
                OUR TECHNOLOGY POWERS
              </span>
              <div className="grid grid-cols-6 gap-1 text-center">
                {[
                  { label: 'Tenant Mgt', icon: Users },
                  { label: 'Landlord Mgt', icon: Building2 },
                  { label: 'Partner Mgt', icon: TrendingUp },
                  { label: 'Agent Mgt', icon: Smartphone },
                  { label: 'Payments', icon: Coins },
                  { label: 'Analytics', icon: BarChart3 },
                ].map((item, idx) => {
                  const ItemIcon = item.icon;
                  return (
                    <div key={idx} className="space-y-1">
                      <ItemIcon className="h-4 w-4 text-white mx-auto" />
                      <span className="text-[8px] font-bold text-slate-300 block leading-tight">{item.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          {/* ══════════════════════════════════════════════════════════════════
              PANEL 3 (RIGHT): VALUE FOR EVERY STAKEHOLDER
          ══════════════════════════════════════════════════════════════════ */}
          <section className="p-7 sm:p-9 flex flex-col justify-between bg-white print:p-5">
            <div>
              {/* Ribbon Title */}
              <div className="text-center relative mb-5">
                <span className="bg-white px-3 text-xs font-black tracking-widest text-purple-900 uppercase relative z-10" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                  VALUE FOR EVERY STAKEHOLDER
                </span>
                <div className="absolute top-1/2 left-0 right-0 h-px bg-slate-200" />
              </div>

              {/* Stakeholders List */}
              <div className="space-y-3.5 mb-5">
                {/* For Tenants */}
                <div className="flex items-start gap-3">
                  <div className="h-9 w-9 rounded-full bg-purple-800 text-white flex items-center justify-center shrink-0 mt-0.5">
                    <Users className="h-4 w-4" />
                  </div>
                  <div className="space-y-0.5 flex-1">
                    <h4 className="text-xs font-bold text-purple-950 uppercase tracking-wide">FOR TENANTS</h4>
                    <ul className="text-[10.5px] text-slate-600 leading-snug space-y-0.5">
                      <li>• Access rent in a way that fits your income</li>
                      <li>• Make manageable daily/periodic repayments</li>
                      <li>• Build a consistent rental payment history</li>
                      <li>• Reduce the pressure of paying large lump sums</li>
                    </ul>
                  </div>
                </div>

                {/* For Landlords */}
                <div className="flex items-start gap-3">
                  <div className="h-9 w-9 rounded-full bg-emerald-700 text-white flex items-center justify-center shrink-0 mt-0.5">
                    <Building2 className="h-4 w-4" />
                  </div>
                  <div className="space-y-0.5 flex-1">
                    <h4 className="text-xs font-bold text-purple-950 uppercase tracking-wide">FOR LANDLORDS</h4>
                    <ul className="text-[10.5px] text-slate-600 leading-snug space-y-0.5">
                      <li>• Receive rent upfront and on time</li>
                      <li>• Reduce rent collection stress</li>
                      <li>• Better tenant verification and records</li>
                      <li>• Access to a growing tenant network</li>
                    </ul>
                  </div>
                </div>

                {/* For Tenant Partners */}
                <div className="flex items-start gap-3">
                  <div className="h-9 w-9 rounded-full bg-amber-600 text-white flex items-center justify-center shrink-0 mt-0.5">
                    <TrendingUp className="h-4 w-4" />
                  </div>
                  <div className="space-y-0.5 flex-1">
                    <h4 className="text-xs font-bold text-purple-950 uppercase tracking-wide">FOR TENANT PARTNERS</h4>
                    <ul className="text-[10.5px] text-slate-600 leading-snug space-y-0.5">
                      <li>• Support tenants and earn attractive platform rewards</li>
                      <li>• Transparent tracking of your partnership performance</li>
                      <li>• Your money working within a structured ecosystem</li>
                      <li>• Contribute to financial inclusion and impact</li>
                    </ul>
                  </div>
                </div>

                {/* For Agents */}
                <div className="flex items-start gap-3">
                  <div className="h-9 w-9 rounded-full bg-sky-600 text-white flex items-center justify-center shrink-0 mt-0.5">
                    <Smartphone className="h-4 w-4" />
                  </div>
                  <div className="space-y-0.5 flex-1">
                    <h4 className="text-xs font-bold text-purple-950 uppercase tracking-wide">FOR AGENTS</h4>
                    <ul className="text-[10.5px] text-slate-600 leading-snug space-y-0.5">
                      <li>• Earn commissions by onboarding tenants</li>
                      <li>• Build long-term relationships</li>
                      <li>• Real-time tools and support</li>
                      <li>• Grow with the Welile network</li>
                    </ul>
                  </div>
                </div>
              </div>

              {/* Partner With Welile Card */}
              <div className="rounded-2xl bg-purple-950 text-white p-4 space-y-2 mb-4">
                <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-white">
                  <Award className="h-4 w-4 text-amber-400" />
                  <span>PARTNER WITH WELILE</span>
                </div>
                <p className="text-[10.5px] text-slate-300 leading-snug">
                  Join a structured partnership that supports verified rental transactions and earns you platform rewards.
                </p>

                <div className="grid grid-cols-3 gap-1.5 pt-1">
                  <div className="bg-white text-slate-950 rounded-lg p-2 text-center">
                    <span className="text-[8px] font-bold text-slate-500 uppercase block">Minimum Support</span>
                    <strong className="text-[11px] font-extrabold text-purple-900 block">UGX 100,000</strong>
                  </div>
                  <div className="bg-white text-slate-950 rounded-lg p-2 text-center">
                    <span className="text-[8px] font-bold text-slate-500 uppercase block">Maximum Support</span>
                    <strong className="text-[12px] font-extrabold text-purple-900 block">∞ No Limit</strong>
                  </div>
                  <div className="bg-white text-slate-950 rounded-lg p-2 text-center">
                    <span className="text-[8px] font-bold text-slate-500 uppercase block">Standard Period</span>
                    <strong className="text-[11px] font-extrabold text-purple-900 block">12 MONTHS</strong>
                  </div>
                </div>

                <p className="text-[8.5px] text-slate-400 pt-1 leading-tight">
                  The standard partnership agreement with Welile is 12 months. All partnerships are governed by a formal Partnership Agreement and Welile's terms and conditions.
                </p>
              </div>
            </div>

            {/* Mission & Vision Footer */}
            <div className="rounded-xl bg-purple-950 text-white p-4 space-y-3 mt-auto">
              <div className="flex items-center justify-between gap-2.5">
                <div className="space-y-0.5 flex-1">
                  <span className="text-[8.5px] font-extrabold uppercase tracking-widest text-amber-400 block">OUR MISSION</span>
                  <p className="text-[8.5px] text-slate-300 leading-tight">
                    To build trusted financial identities by transforming everyday economic behaviour into meaningful financial opportunity.
                  </p>
                </div>
                <div className="h-8 w-8 rounded-full bg-white text-purple-950 font-black text-sm flex items-center justify-center shrink-0 ring-2 ring-amber-400">
                  w<span className="text-amber-500">.</span>
                </div>
                <div className="space-y-0.5 flex-1 text-right">
                  <span className="text-[8.5px] font-extrabold uppercase tracking-widest text-amber-400 block">OUR VISION</span>
                  <p className="text-[8.5px] text-slate-300 leading-tight">
                    A financially empowered Africa where people's economic behaviour can create greater access to opportunity.
                  </p>
                </div>
              </div>

              <div className="bg-amber-400 text-slate-950 font-black text-[10px] tracking-wider uppercase text-center py-1 rounded-md">
                LET'S BUILD A BETTER RENTAL FUTURE TOGETHER.
              </div>

              <div className="flex items-center justify-between text-[8px] font-medium text-slate-400 pt-1 border-t border-white/10">
                <div className="flex items-center gap-1">
                  <Phone className="h-2.5 w-2.5 text-amber-400" />
                  <span>+256 200 909 000</span>
                </div>
                <div className="flex items-center gap-1">
                  <Globe className="h-2.5 w-2.5 text-amber-400" />
                  <span>www.welile.com</span>
                </div>
                <div className="flex items-center gap-1">
                  <MapPin className="h-2.5 w-2.5 text-amber-400" />
                  <span>Kabale Entebbe Road, Uganda</span>
                </div>
              </div>
            </div>
          </section>

        </div>
      </main>
    </div>
  );
}
