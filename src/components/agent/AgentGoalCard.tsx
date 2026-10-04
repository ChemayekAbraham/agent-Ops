import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { 
  Target, Trophy, TrendingUp, Edit2, Plus, Flame,
  CheckCircle2, Calendar, Sparkles
} from 'lucide-react';
import { format, startOfMonth, endOfMonth } from 'date-fns';


interface AgentGoal {
  id: string;
  agent_id: string;
  goal_month: string;
  target_registrations: number;
  target_activations: number | null;
  notes: string | null;
}

interface GoalProgress {
  registrations: number;
  activations: number;
}

export function AgentGoalCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [currentGoal, setCurrentGoal] = useState<AgentGoal | null>(null);
  const [progress, setProgress] = useState<GoalProgress>({ registrations: 0, activations: 0 });
  const [formData, setFormData] = useState({
    target_registrations: 10,
    target_activations: 5,
    notes: '',
  });

  const currentMonth = startOfMonth(new Date());
  const monthEnd = endOfMonth(new Date());

  useEffect(() => {
    if (user) {
      fetchGoalAndProgress();
    }
  }, [user]);

  const fetchGoalAndProgress = async () => {
    if (!user) return;
    setLoading(true);

    try {
      // Fetch current month's goal
      const { data: goalData } = await supabase
        .from('agent_goals')
        .select('*')
        .eq('agent_id', user.id)
        .eq('goal_month', format(currentMonth, 'yyyy-MM-dd'))
        .single();

      if (goalData) {
        setCurrentGoal(goalData);
        setFormData({
          target_registrations: goalData.target_registrations,
          target_activations: goalData.target_activations || 0,
          notes: goalData.notes || '',
        });
      }

      // Fetch progress (registrations & activations this month)
      const { data: invites } = await supabase
        .from('supporter_invites')
        .select('status, created_at, activated_at')
        .eq('created_by', user.id)
        .in('role', ['tenant', 'landlord'])
        .gte('created_at', currentMonth.toISOString())
        .lte('created_at', monthEnd.toISOString());

      if (invites) {
        const registrations = invites.length;
        const activations = invites.filter(i => i.status === 'activated').length;
        setProgress({ registrations, activations });
      }
    } catch (error) {
      console.error('Error fetching goal:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveGoal = async () => {
    if (!user) return;
    setSaving(true);

    try {
      const goalData = {
        agent_id: user.id,
        goal_month: format(currentMonth, 'yyyy-MM-dd'),
        target_registrations: formData.target_registrations,
        target_activations: formData.target_activations || null,
        notes: formData.notes || null,
      };

      if (currentGoal) {
        // Update existing goal
        const { error } = await supabase
          .from('agent_goals')
          .update(goalData)
          .eq('id', currentGoal.id);

        if (error) throw error;
      } else {
        // Create new goal
        const { error } = await supabase
          .from('agent_goals')
          .insert(goalData);

        if (error) throw error;
      }

      const action = currentGoal ? 'updated' : 'set';
      toast({
        title: `🎯 Monthly goal ${action}!`,
        description: `Target: ${formData.target_registrations} registrations${formData.target_activations > 0 ? `, ${formData.target_activations} activations` : ''} for ${format(currentMonth, 'MMMM yyyy')}.`,
      });
      setDialogOpen(false);
      fetchGoalAndProgress();
    } catch (error: any) {
      const isNetwork = !error.message || error.message.includes('network') || error.message.includes('fetch');
      toast({
        title: `Could not ${currentGoal ? 'update' : 'set'} goal`,
        description: isNetwork
          ? 'Please check your connection and try again.'
          : error.message || 'Something went wrong. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const registrationProgress = currentGoal 
    ? Math.min((progress.registrations / currentGoal.target_registrations) * 100, 100)
    : 0;

  const activationProgress = currentGoal?.target_activations
    ? Math.min((progress.activations / currentGoal.target_activations) * 100, 100)
    : 0;

  const isGoalMet = currentGoal && progress.registrations >= currentGoal.target_registrations;

  if (loading) {
    return <Skeleton className="h-48 w-full rounded-xl" />;
  }

  return (
    <>
      <Card className={`overflow-hidden ${isGoalMet ? 'ring-2 ring-success' : ''}`}>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Target className="h-4 w-4 text-primary" />
              {format(currentMonth, 'MMMM')} Goal
            </CardTitle>
            <Button 
              variant="ghost" 
              size="sm"
              onClick={() => setDialogOpen(true)}
            >
              {currentGoal ? (
                <><Edit2 className="h-3.5 w-3.5 mr-1" /> Edit</>
              ) : (
                <><Plus className="h-3.5 w-3.5 mr-1" /> Set Goal</>
              )}
            </Button>
          </div>
        </CardHeader>
        
        <CardContent className="space-y-4">
          {!currentGoal ? (
            <div className="text-center py-4">
              <Target className="h-10 w-10 mx-auto mb-2 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">No goal set for this month</p>
              <Button 
                variant="outline" 
                size="sm" 
                className="mt-3"
                onClick={() => setDialogOpen(true)}
              >
                <Plus className="h-4 w-4 mr-1" />
                Set Your Goal
              </Button>
            </div>
          ) : (
            <>
              {/* Registration Progress */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1.5">
                    <TrendingUp className="h-4 w-4 text-primary" />
                    Registrations
                  </span>
                  <span className="font-medium">
                    {progress.registrations} / {currentGoal.target_registrations}
                  </span>
                </div>
                <div className="relative">
                  <Progress value={registrationProgress} className="h-3" />
                  {isGoalMet && (
                    <div className="absolute -right-1 -top-1 animate-scale-in">
                      <div className="bg-success text-success-foreground rounded-full p-0.5">
                        <CheckCircle2 className="h-4 w-4" />
                      </div>
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {registrationProgress >= 100 
                    ? '🎉 Goal achieved!' 
                    : `${Math.round(registrationProgress)}% complete`}
                </p>
              </div>

              {/* Activation Progress (if set) */}
              {currentGoal.target_activations && currentGoal.target_activations > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-1.5">
                      <CheckCircle2 className="h-4 w-4 text-success" />
                      Activations
                    </span>
                    <span className="font-medium">
                      {progress.activations} / {currentGoal.target_activations}
                    </span>
                  </div>
                  <Progress value={activationProgress} className="h-2 [&>div]:bg-success" />
                </div>
              )}

              {/* Status Badge */}
              <div className="flex items-center gap-2 pt-1">
                {isGoalMet ? (
                  <Badge className="bg-success/10 text-success border-success/20 gap-1">
                    <Trophy className="h-3 w-3" />
                    Goal Achieved!
                  </Badge>
                ) : registrationProgress >= 75 ? (
                  <Badge className="bg-warning/10 text-warning border-warning/20 gap-1">
                    <Flame className="h-3 w-3" />
                    Almost There!
                  </Badge>
                ) : registrationProgress >= 50 ? (
                  <Badge variant="outline" className="gap-1">
                    <TrendingUp className="h-3 w-3" />
                    Good Progress
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1">
                    <Calendar className="h-3 w-3" />
                    Keep Going!
                  </Badge>
                )}
                
                {progress.registrations > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {currentGoal.target_registrations - progress.registrations > 0 
                      ? `${currentGoal.target_registrations - progress.registrations} more to go`
                      : `+${progress.registrations - currentGoal.target_registrations} extra!`}
                  </span>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Goal Setting Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Target className="h-5 w-5 text-primary" />
              {currentGoal ? 'Edit Goal' : 'Set Monthly Goal'}
            </DialogTitle>
            <DialogDescription>
              Set your registration targets for {format(currentMonth, 'MMMM yyyy')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="target_registrations">Registration Target *</Label>
              <Input
                id="target_registrations"
                type="number"
                min={1}
                max={1000}
                value={formData.target_registrations}
                onChange={(e) => setFormData(prev => ({ 
                  ...prev, 
                  target_registrations: parseInt(e.target.value) || 1 
                }))}
              />
              <p className="text-xs text-muted-foreground">
                How many users do you want to register this month?
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="target_activations">Activation Target (Optional)</Label>
              <Input
                id="target_activations"
                type="number"
                min={0}
                max={formData.target_registrations}
                value={formData.target_activations}
                onChange={(e) => setFormData(prev => ({ 
                  ...prev, 
                  target_activations: parseInt(e.target.value) || 0 
                }))}
              />
              <p className="text-xs text-muted-foreground">
                How many should activate their accounts?
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Notes (Optional)</Label>
              <Input
                id="notes"
                placeholder="e.g., Focus on landlords this month"
                value={formData.notes}
                onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
              />
            </div>

            {/* Motivation Preview */}
            <Card className="bg-gradient-to-br from-primary/5 to-success/5">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium">Your Goal</span>
                </div>
                <p className="text-lg font-bold">
                  {formData.target_registrations} registrations
                  {formData.target_activations > 0 && ` (${formData.target_activations} activations)`}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  That's about {Math.ceil(formData.target_registrations / 4)} per week!
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="flex gap-2">
            <Button 
              variant="outline" 
              className="flex-1"
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button 
              className="flex-1"
              onClick={handleSaveGoal}
              disabled={saving || formData.target_registrations < 1}
            >
              {saving ? 'Saving...' : 'Save Goal'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default AgentGoalCard;
