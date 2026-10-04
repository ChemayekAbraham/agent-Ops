import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { 
  Target, Plus, Edit2, Trophy, TrendingUp, 
  Calendar, CheckCircle2, Clock, Flame, Sparkles, Rocket
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { SetGoalDialog } from './SetGoalDialog';
import { motion, AnimatePresence } from 'framer-motion';

export interface InvestmentGoal {
  id: string;
  name: string;
  targetAmount: number;
  currentAmount: number;
  deadline: string;
  createdAt: string;
  color: string;
}

interface InvestmentGoalsProps {
  goals: InvestmentGoal[];
  onAddGoal: (goal: Omit<InvestmentGoal, 'id' | 'currentAmount' | 'createdAt'>) => void;
  onUpdateGoal: (id: string, updates: Partial<InvestmentGoal>) => void;
  onDeleteGoal: (id: string) => void;
  totalEarnings: number;
  monthlyEarnings: number;
}

export function InvestmentGoals({ 
  goals, 
  onAddGoal, 
  onUpdateGoal,
  onDeleteGoal,
  totalEarnings,
  monthlyEarnings 
}: InvestmentGoalsProps) {
  const [showAddGoal, setShowAddGoal] = useState(false);
  const [editingGoal, setEditingGoal] = useState<InvestmentGoal | null>(null);

  const getProgressPercent = (goal: InvestmentGoal) => {
    return Math.min((goal.currentAmount / goal.targetAmount) * 100, 100);
  };

  const getDaysRemaining = (deadline: string) => {
    const now = new Date();
    const end = new Date(deadline);
    const diffDays = Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return diffDays;
  };

  const getGoalStatus = (goal: InvestmentGoal) => {
    const progress = getProgressPercent(goal);
    const daysRemaining = getDaysRemaining(goal.deadline);
    
    if (progress >= 100) return { label: 'Completed', color: 'bg-success/20 text-success border-success/30', icon: CheckCircle2 };
    if (daysRemaining < 0) return { label: 'Expired', color: 'bg-destructive/20 text-destructive border-destructive/30', icon: Clock };
    if (daysRemaining <= 7) return { label: 'Hot!', color: 'bg-warning/20 text-warning border-warning/30', icon: Flame };
    return { label: 'Active', color: 'bg-primary/20 text-primary border-primary/30', icon: Rocket };
  };

  const colorSchemes: Record<string, { gradient: string; iconBg: string; progressBg: string }> = {
    blue: { gradient: 'from-blue-600/15 via-cyan-500/10 to-blue-600/5', iconBg: 'from-blue-500 to-cyan-400', progressBg: 'bg-gradient-to-r from-blue-500 to-cyan-400' },
    green: { gradient: 'from-emerald-600/15 via-green-500/10 to-emerald-600/5', iconBg: 'from-emerald-500 to-green-400', progressBg: 'bg-gradient-to-r from-emerald-500 to-green-400' },
    purple: { gradient: 'from-purple-600/15 via-violet-500/10 to-purple-600/5', iconBg: 'from-purple-500 to-violet-400', progressBg: 'bg-gradient-to-r from-purple-500 to-violet-400' },
    orange: { gradient: 'from-orange-600/15 via-amber-500/10 to-orange-600/5', iconBg: 'from-orange-500 to-amber-400', progressBg: 'bg-gradient-to-r from-orange-500 to-amber-400' },
    pink: { gradient: 'from-pink-600/15 via-rose-500/10 to-pink-600/5', iconBg: 'from-pink-500 to-rose-400', progressBg: 'bg-gradient-to-r from-pink-500 to-rose-400' },
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.15 }}
      >
        <Card className="relative overflow-hidden border-0 bg-gradient-to-br from-primary/5 via-background to-violet-500/5 backdrop-blur-xl shadow-xl">
          {/* Decorative elements */}
          <div className="absolute top-0 left-0 w-48 h-48 bg-gradient-to-br from-primary/15 to-transparent rounded-full blur-3xl" />
          <div className="absolute -bottom-12 -right-12 w-32 h-32 bg-gradient-to-tl from-violet-500/10 to-transparent rounded-full blur-2xl" />
          
          <CardHeader className="relative pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <motion.div 
                  className="p-3 rounded-2xl bg-gradient-to-br from-primary via-violet-500 to-purple-600 shadow-lg shadow-primary/30"
                  whileHover={{ scale: 1.05, rotate: 5 }}
                >
                  <Target className="h-5 w-5 text-white" />
                </motion.div>
                <div>
                  <CardTitle className="text-xl font-black tracking-tight">Your Goals 🎯</CardTitle>
                  <p className="text-sm text-muted-foreground font-medium mt-0.5">Track your earning targets</p>
                </div>
              </div>
              <Button 
                size="sm" 
                onClick={() => setShowAddGoal(true)}
                className="gap-2 bg-gradient-to-r from-primary to-violet-500 hover:from-primary/90 hover:to-violet-500/90 shadow-lg shadow-primary/25"
              >
                <Plus className="h-4 w-4" />
                New Goal
              </Button>
            </div>
          </CardHeader>
          
          <CardContent className="relative space-y-5">
            {/* Monthly Earnings Summary */}
            <motion.div 
              className="relative p-5 rounded-2xl bg-gradient-to-br from-success/15 via-success/10 to-emerald-600/5 border border-success/20 overflow-hidden"
              whileHover={{ scale: 1.01 }}
            >
              <div className="absolute -top-12 -right-12 w-24 h-24 bg-success/20 rounded-full blur-2xl" />
              <div className="relative flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-success" />
                  <span className="text-sm font-bold text-foreground">Monthly Earning Power</span>
                </div>
                <Badge className="text-[10px] px-2.5 py-1 bg-success/20 text-success border-success/30 font-bold">
                  <Sparkles className="h-3 w-3 mr-1" />
                  15% ROI
                </Badge>
              </div>
              <p className="text-3xl font-black text-success tracking-tight">{formatUGX(monthlyEarnings)}</p>
              <p className="text-xs text-muted-foreground mt-2 font-medium">
                💰 Total earned: <span className="text-foreground font-bold">{formatUGX(totalEarnings)}</span>
              </p>
            </motion.div>

            {/* Goals List */}
            {goals.length === 0 ? (
              <div className="text-center py-12">
                <motion.div 
                  className="p-5 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 w-fit mx-auto mb-5"
                  animate={{ scale: [1, 1.05, 1], rotate: [0, 5, -5, 0] }}
                  transition={{ duration: 3, repeat: Infinity }}
                >
                  <Trophy className="h-10 w-10 text-primary/60" />
                </motion.div>
                <p className="text-foreground font-bold text-lg">No goals yet? Let's fix that! 🚀</p>
                <p className="text-sm text-muted-foreground mt-2 max-w-xs mx-auto">
                  Set a monthly earning target to stay motivated and track progress
                </p>
                <Button 
                  className="mt-5 gap-2 bg-gradient-to-r from-primary to-violet-500 shadow-lg shadow-primary/25"
                  onClick={() => setShowAddGoal(true)}
                >
                  <Sparkles className="h-4 w-4" />
                  Create Your First Goal
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <AnimatePresence>
                  {goals.map((goal, index) => {
                    const progress = getProgressPercent(goal);
                    const daysRemaining = getDaysRemaining(goal.deadline);
                    const status = getGoalStatus(goal);
                    const StatusIcon = status.icon;
                    const scheme = colorSchemes[goal.color] || colorSchemes.purple;

                    return (
                      <motion.div
                        key={goal.id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, x: -100 }}
                        transition={{ delay: index * 0.1 }}
                        whileHover={{ scale: 1.01, y: -2 }}
                        className={`relative p-5 rounded-2xl bg-gradient-to-br ${scheme.gradient} border border-white/10 hover:border-white/20 transition-all duration-300 overflow-hidden`}
                      >
                        {/* Decorative glow */}
                        <div className="absolute -top-8 -right-8 w-20 h-20 bg-white/5 rounded-full blur-2xl" />
                        
                        <div className="relative flex items-start justify-between mb-4">
                          <div className="flex items-center gap-3">
                            <div className={`p-2.5 rounded-xl bg-gradient-to-br ${scheme.iconBg} shadow-lg`}>
                              <Target className="h-4 w-4 text-white" />
                            </div>
                            <div>
                              <h4 className="font-bold text-foreground text-lg">{goal.name}</h4>
                              <p className="text-xs text-muted-foreground font-medium">Target: {formatUGX(goal.targetAmount)}/month</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge className={`text-[10px] px-2 py-1 gap-1 border ${status.color}`}>
                              <StatusIcon className="h-3 w-3" />
                              {status.label}
                            </Badge>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 hover:bg-white/10"
                              onClick={() => setEditingGoal(goal)}
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>

                        <div className="relative space-y-4">
                          {/* Target vs Current */}
                          <div className="flex items-end justify-between">
                            <div>
                              <p className="text-xs text-muted-foreground mb-1 font-semibold uppercase tracking-wider">Progress</p>
                              <p className="text-2xl font-black text-foreground">{formatUGX(goal.currentAmount)}</p>
                            </div>
                            <div className="text-right">
                              <p className="text-xs text-muted-foreground mb-1 font-semibold uppercase tracking-wider">Goal</p>
                              <p className="text-xl font-bold text-muted-foreground/60">
                                {formatUGX(goal.targetAmount)}
                              </p>
                            </div>
                          </div>

                          {/* Progress Bar */}
                          <div className="space-y-2">
                            <div className="h-3 bg-white/10 rounded-full overflow-hidden backdrop-blur">
                              <motion.div 
                                className={`h-full ${scheme.progressBg} rounded-full`}
                                initial={{ width: 0 }}
                                animate={{ width: `${progress}%` }}
                                transition={{ duration: 1, ease: "easeOut" }}
                              />
                            </div>
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-bold text-foreground">
                                {progress.toFixed(0)}% Complete {progress >= 100 && '🎉'}
                              </span>
                              <div className="flex items-center gap-1.5 text-muted-foreground font-medium">
                                <Calendar className="h-3 w-3" />
                                {daysRemaining > 0 ? (
                                  <span>{daysRemaining} days left</span>
                                ) : daysRemaining === 0 ? (
                                  <span className="text-warning font-bold">Due today!</span>
                                ) : (
                                  <span className="text-destructive font-bold">
                                    {Math.abs(daysRemaining)}d overdue
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Remaining Amount */}
                          {progress < 100 && (
                            <p className="text-xs text-muted-foreground">
                              💪 Just <span className="font-bold text-foreground">
                                {formatUGX(goal.targetAmount - goal.currentAmount)}
                              </span> more to crush this goal!
                            </p>
                          )}
                        </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      <SetGoalDialog
        open={showAddGoal}
        onOpenChange={setShowAddGoal}
        onSave={(goal) => {
          onAddGoal(goal);
          setShowAddGoal(false);
        }}
      />

      {editingGoal && (
        <SetGoalDialog
          open={!!editingGoal}
          onOpenChange={(open) => !open && setEditingGoal(null)}
          goal={editingGoal}
          onSave={(updates) => {
            onUpdateGoal(editingGoal.id, updates);
            setEditingGoal(null);
          }}
          onDelete={() => {
            onDeleteGoal(editingGoal.id);
            setEditingGoal(null);
          }}
        />
      )}
    </>
  );
}
