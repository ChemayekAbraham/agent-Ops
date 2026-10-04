import { useRef, useState } from "react";
import { toPng } from "html-to-image";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Download, Share2, Users, TrendingUp, Trophy, Target, CheckCircle2, MessageCircle, Copy } from "lucide-react";
import { motion } from "framer-motion";
import { format } from "date-fns";
import { QRCodeSVG } from "qrcode.react";

interface PerformanceStats {
  total: number;
  activated: number;
  pending: number;
  tenants: number;
  landlords: number;
  conversionRate: number;
  thisWeek: number;
  weeklyGrowth: number;
}

interface ShareablePerformanceCardProps {
  stats: PerformanceStats;
  userName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leaderboardRank?: number;
}

export function ShareablePerformanceCard({
  stats,
  userName,
  open,
  onOpenChange,
  leaderboardRank,
}: ShareablePerformanceCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const generateImage = async (): Promise<string | null> => {
    if (!cardRef.current) return null;

    try {
      const dataUrl = await toPng(cardRef.current, {
        quality: 1,
        pixelRatio: 2,
        cacheBust: true,
        backgroundColor: '#0f172a',
      });
      return dataUrl;
    } catch (error) {
      console.error("Error generating image:", error);
      return null;
    }
  };

  const handleDownload = async () => {
    setIsGenerating(true);
    try {
      const dataUrl = await generateImage();
      if (dataUrl) {
        const link = document.createElement("a");
        link.download = `welile-agent-performance-${format(new Date(), 'yyyy-MM-dd')}.png`;
        link.href = dataUrl;
        link.click();
        toast.success("Performance card downloaded!");
      }
    } catch (error) {
      toast.error("Failed to generate image");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleShare = async () => {
    setIsGenerating(true);
    try {
      const dataUrl = await generateImage();
      if (!dataUrl) {
        toast.error("Failed to generate image");
        return;
      }

      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const file = new File([blob], `welile-agent-performance.png`, {
        type: "image/png",
      });

      const shareText = `🚀 My Welile Agent Performance:\n✅ ${stats.total} registrations\n📈 ${stats.conversionRate}% conversion rate\n🎯 ${stats.activated} activated users\n\nJoin me as an agent on Welile!`;

      if (navigator.share && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: "My Welile Agent Performance",
          text: shareText,
          files: [file],
        });
        toast.success("Shared successfully!");
      } else if (navigator.share) {
        await navigator.share({
          title: "My Welile Agent Performance",
          text: shareText,
          url: "https://welile.com",
        });
        toast.success("Shared successfully!");
      } else {
        await navigator.clipboard.writeText(shareText + "\n\nhttps://welile.com");
        toast.success("Copied to clipboard!");
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        toast.error("Failed to share");
      }
    } finally {
      setIsGenerating(false);
    }
  };

  const getWhatsAppMessage = () => {
    let message = `🚀 *My Welile Agent Performance*\n\n`;
    
    if (leaderboardRank) {
      if (leaderboardRank === 1) message += `🥇 *#1 Top Agent!*\n\n`;
      else if (leaderboardRank === 2) message += `🥈 *#2 Agent!*\n\n`;
      else if (leaderboardRank === 3) message += `🥉 *#3 Agent!*\n\n`;
      else if (leaderboardRank <= 10) message += `🏆 *Top 10 Agent!*\n\n`;
    }
    
    message += `📊 *Stats:*\n`;
    message += `✅ ${stats.total} total registrations\n`;
    message += `🎯 ${stats.activated} activated users\n`;
    message += `📈 ${stats.conversionRate}% conversion rate\n`;
    message += `👥 ${stats.tenants} tenants | 🏠 ${stats.landlords} landlords\n\n`;
    message += `💼 Want to become a Welile agent? Join me!\n`;
    message += `🔗 https://welile.com`;
    
    return message;
  };

  const handleWhatsAppShare = () => {
    const message = getWhatsAppMessage();
    const encodedMessage = encodeURIComponent(message);
    const whatsappUrl = `https://wa.me/?text=${encodedMessage}`;
    window.open(whatsappUrl, '_blank');
    toast.success("Opening WhatsApp...");
  };

  const getRankBadge = () => {
    if (!leaderboardRank) return null;
    if (leaderboardRank === 1) return { text: "🥇 #1", color: "from-yellow-400 to-amber-500" };
    if (leaderboardRank === 2) return { text: "🥈 #2", color: "from-gray-300 to-gray-400" };
    if (leaderboardRank === 3) return { text: "🥉 #3", color: "from-amber-600 to-orange-700" };
    if (leaderboardRank <= 10) return { text: `🏆 Top 10`, color: "from-purple-500 to-indigo-600" };
    return null;
  };

  const rankBadge = getRankBadge();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-0 overflow-hidden bg-transparent border-none shadow-none">
        <div className="bg-background rounded-2xl overflow-hidden">
          <DialogHeader className="p-4 pb-2">
            <DialogTitle className="text-lg">Share Performance</DialogTitle>
          </DialogHeader>

          {/* The shareable card */}
          <div className="px-4 pb-4">
            <div
              ref={cardRef}
              className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-primary/30 to-slate-900 p-6 text-white"
              style={{ aspectRatio: "4/5" }}
            >
              {/* Background decorations */}
              <div className="absolute inset-0 overflow-hidden">
                <div className="absolute -top-20 -right-20 w-64 h-64 rounded-full bg-primary/20 blur-3xl" />
                <div className="absolute -bottom-20 -left-20 w-64 h-64 rounded-full bg-success/20 blur-3xl" />
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 rounded-full bg-white/5 blur-3xl" />
              </div>

              {/* Content */}
              <div className="relative h-full flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between mb-4">
                  <div className="bg-white/10 backdrop-blur-sm rounded-full px-3 py-1">
                    <span className="text-xs font-semibold uppercase tracking-wider">
                      Agent Performance
                    </span>
                  </div>
                  {rankBadge && (
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className={`bg-gradient-to-r ${rankBadge.color} rounded-full px-3 py-1`}
                    >
                      <span className="text-xs font-bold">{rankBadge.text}</span>
                    </motion.div>
                  )}
                </div>

                {/* Main stats */}
                <div className="flex-1 flex flex-col items-center justify-center text-center">
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 200, damping: 15 }}
                    className="mb-2"
                  >
                    <Trophy className="h-10 w-10 text-yellow-400" />
                  </motion.div>

                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 }}
                    className="text-5xl font-bold mb-1 bg-gradient-to-r from-white to-white/80 bg-clip-text text-transparent"
                  >
                    {stats.total}
                  </motion.div>
                  <p className="text-white/70 text-sm mb-6">Total Registrations</p>

                  {/* Stats grid */}
                  <div className="grid grid-cols-2 gap-3 w-full max-w-[280px]">
                    <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3 text-center">
                      <div className="flex items-center justify-center gap-1 mb-1">
                        <CheckCircle2 className="h-4 w-4 text-success" />
                        <span className="text-xl font-bold">{stats.activated}</span>
                      </div>
                      <p className="text-white/60 text-xs">Activated</p>
                    </div>
                    <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3 text-center">
                      <div className="flex items-center justify-center gap-1 mb-1">
                        <TrendingUp className="h-4 w-4 text-primary" />
                        <span className="text-xl font-bold">{stats.conversionRate}%</span>
                      </div>
                      <p className="text-white/60 text-xs">Conversion</p>
                    </div>
                    <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3 text-center">
                      <div className="flex items-center justify-center gap-1 mb-1">
                        <Users className="h-4 w-4 text-blue-400" />
                        <span className="text-xl font-bold">{stats.tenants}</span>
                      </div>
                      <p className="text-white/60 text-xs">Tenants</p>
                    </div>
                    <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3 text-center">
                      <div className="flex items-center justify-center gap-1 mb-1">
                        <Target className="h-4 w-4 text-emerald-400" />
                        <span className="text-xl font-bold">{stats.landlords}</span>
                      </div>
                      <p className="text-white/60 text-xs">Landlords</p>
                    </div>
                  </div>
                </div>

                {/* Footer with QR Code */}
                <div className="mt-auto pt-4 border-t border-white/10">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <p className="text-white/60 text-xs">Agent</p>
                      <p className="font-semibold text-sm">{userName}</p>
                      <p className="text-white/60 text-xs mt-1">{format(new Date(), "MMM yyyy")}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="text-right mr-2">
                        <p className="text-white/60 text-[10px]">Scan to join</p>
                        <div className="bg-white/20 backdrop-blur-sm rounded-full px-2 py-0.5 mt-0.5">
                          <span className="text-[10px] font-medium">welile.com</span>
                        </div>
                      </div>
                      <div className="bg-white p-1.5 rounded-lg">
                        <QRCodeSVG 
                          value="https://welile.com/become-agent" 
                          size={48}
                          level="M"
                          bgColor="#ffffff"
                          fgColor="#0f172a"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="p-4 pt-0 space-y-2">
            {/* WhatsApp - Primary action */}
            <Button
              className="w-full bg-[#25D366] hover:bg-[#128C7E] text-white"
              onClick={handleWhatsAppShare}
            >
              <MessageCircle className="h-4 w-4 mr-2" />
              Share on WhatsApp
            </Button>
            
            {/* Secondary actions */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={handleDownload}
                disabled={isGenerating}
              >
                <Download className="h-4 w-4 mr-2" />
                {isGenerating ? '...' : 'Download'}
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                onClick={async () => {
                  const message = getWhatsAppMessage().replace(/\*/g, ''); // Remove markdown formatting
                  await navigator.clipboard.writeText(message);
                  toast.success("Copied to clipboard!");
                }}
              >
                <Copy className="h-4 w-4 mr-2" />
                Copy
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                onClick={handleShare}
                disabled={isGenerating}
              >
                <Share2 className="h-4 w-4 mr-2" />
                More
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}