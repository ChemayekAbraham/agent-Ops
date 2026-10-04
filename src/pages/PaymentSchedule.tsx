import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Calendar } from '@/components/ui/calendar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Calendar as CalendarIcon, AlertCircle, Clock, CheckCircle2 } from 'lucide-react';
import { format, isSameDay, isAfter, isBefore, startOfToday, differenceInDays } from 'date-fns';
import { cn } from '@/lib/utils';

interface Loan {
  id: string;
  amount: number;
  total_repayment: number;
  paid_amount: number;
  due_date: string;
  status: string;
  interest_rate: number;
  lender: {
    full_name: string;
  } | null;
}

interface PaymentEvent {
  date: Date;
  loan: Loan;
  type: 'due' | 'overdue' | 'upcoming';
}

export default function PaymentSchedule() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [loans, setLoans] = useState<Loan[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
  const [paymentEvents, setPaymentEvents] = useState<PaymentEvent[]>([]);

  useEffect(() => {
    if (user) {
      fetchLoans();
    }
  }, [user]);

  const fetchLoans = async () => {
    try {
      const { data, error } = await supabase
        .from('user_loans')
        .select('*')
        .eq('borrower_id', user?.id)
        .eq('status', 'active');

      if (error) throw error;

      // Fetch lender info
      const loansWithLenders = await Promise.all(
        (data || []).map(async (loan) => {
          const { data: profile } = await supabase
            .from('profiles')
            .select('full_name')
            .eq('id', loan.lender_id)
            .single();
          return { ...loan, lender: profile };
        })
      );

      setLoans(loansWithLenders);

      // Create payment events
      const events: PaymentEvent[] = loansWithLenders.map((loan) => {
        const dueDate = new Date(loan.due_date);
        const today = startOfToday();
        let type: 'due' | 'overdue' | 'upcoming' = 'upcoming';

        if (isSameDay(dueDate, today)) {
          type = 'due';
        } else if (isBefore(dueDate, today)) {
          type = 'overdue';
        }

        return { date: dueDate, loan, type };
      });

      setPaymentEvents(events);
    } catch (error) {
      console.error('Error fetching loans:', error);
    } finally {
      setLoading(false);
    }
  };

  const getEventsForDate = (date: Date) => {
    return paymentEvents.filter((event) => isSameDay(event.date, date));
  };

  const selectedDateEvents = selectedDate ? getEventsForDate(selectedDate) : [];

  const getDaysUntilDue = (dueDate: string) => {
    return differenceInDays(new Date(dueDate), startOfToday());
  };

  const getStatusBadge = (type: 'due' | 'overdue' | 'upcoming') => {
    switch (type) {
      case 'overdue':
        return <Badge variant="destructive">Overdue</Badge>;
      case 'due':
        return <Badge className="bg-amber-500">Due Today</Badge>;
      case 'upcoming':
        return <Badge variant="secondary">Upcoming</Badge>;
    }
  };

  const getStatusIcon = (type: 'due' | 'overdue' | 'upcoming') => {
    switch (type) {
      case 'overdue':
        return <AlertCircle className="h-5 w-5 text-destructive" />;
      case 'due':
        return <Clock className="h-5 w-5 text-amber-500" />;
      case 'upcoming':
        return <CalendarIcon className="h-5 w-5 text-muted-foreground" />;
    }
  };

  // Custom day content to show indicators
  const modifiers = {
    hasPayment: paymentEvents.map((e) => e.date),
    overdue: paymentEvents.filter((e) => e.type === 'overdue').map((e) => e.date),
    dueToday: paymentEvents.filter((e) => e.type === 'due').map((e) => e.date),
    upcoming: paymentEvents.filter((e) => e.type === 'upcoming').map((e) => e.date),
  };

  const modifiersStyles = {
    overdue: {
      backgroundColor: 'hsl(var(--destructive))',
      color: 'hsl(var(--destructive-foreground))',
      borderRadius: '50%',
    },
    dueToday: {
      backgroundColor: 'hsl(45 93% 47%)',
      color: 'hsl(0 0% 0%)',
      borderRadius: '50%',
    },
    upcoming: {
      backgroundColor: 'hsl(var(--primary))',
      color: 'hsl(var(--primary-foreground))',
      borderRadius: '50%',
    },
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b">
        <div className="container flex items-center h-14 max-w-screen-2xl px-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="ml-2 text-lg font-semibold">Payment Schedule</h1>
        </div>
      </header>

      <main className="container max-w-screen-2xl px-4 py-6 space-y-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-full bg-destructive/10">
                  <AlertCircle className="h-5 w-5 text-destructive" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Overdue</p>
                  <p className="text-2xl font-bold">
                    {paymentEvents.filter((e) => e.type === 'overdue').length}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-full bg-amber-500/10">
                  <Clock className="h-5 w-5 text-amber-500" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Due Today</p>
                  <p className="text-2xl font-bold">
                    {paymentEvents.filter((e) => e.type === 'due').length}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-full bg-primary/10">
                  <CalendarIcon className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Upcoming</p>
                  <p className="text-2xl font-bold">
                    {paymentEvents.filter((e) => e.type === 'upcoming').length}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Calendar */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarIcon className="h-5 w-5" />
                Payment Calendar
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={setSelectedDate}
                modifiers={modifiers}
                modifiersStyles={modifiersStyles}
                className="rounded-md border w-full pointer-events-auto"
              />
              <div className="mt-4 flex flex-wrap gap-4 text-sm">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-destructive" />
                  <span>Overdue</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-amber-500" />
                  <span>Due Today</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-primary" />
                  <span>Upcoming</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Selected Date Details */}
          <Card>
            <CardHeader>
              <CardTitle>
                {selectedDate ? format(selectedDate, 'MMMM d, yyyy') : 'Select a date'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {selectedDateEvents.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <CalendarIcon className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p>No payments scheduled for this date</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {selectedDateEvents.map((event) => (
                    <div
                      key={event.loan.id}
                      className="p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-2">
                          {getStatusIcon(event.type)}
                          <span className="font-medium">
                            Rent facilitation by {event.loan.lender?.full_name || 'Agent'}
                          </span>
                        </div>
                        {getStatusBadge(event.type)}
                      </div>
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Total Due</span>
                          <span className="font-medium">
                            UGX {(event.loan.total_repayment - event.loan.paid_amount).toLocaleString()}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Already Paid</span>
                          <span className="font-medium text-green-600">
                            UGX {event.loan.paid_amount.toLocaleString()}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Service Fee</span>
                          <span>{event.loan.interest_rate}%</span>
                        </div>
                      </div>
                      <Button
                        className="w-full mt-4"
                        size="sm"
                        onClick={() => navigate('/my-loans')}
                      >
                        Make Payment
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* All Upcoming Payments List */}
        <Card>
          <CardHeader>
            <CardTitle>All Scheduled Payments</CardTitle>
          </CardHeader>
          <CardContent>
            {loans.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <CheckCircle2 className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p>No active rent plans</p>
                <p className="text-sm">You're all caught up!</p>
              </div>
            ) : (
              <div className="space-y-3">
                {loans
                  .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime())
                  .map((loan) => {
                    const daysUntil = getDaysUntilDue(loan.due_date);
                    const isOverdue = daysUntil < 0;
                    const isDueToday = daysUntil === 0;

                    return (
                      <div
                        key={loan.id}
                        className={cn(
                          'p-4 rounded-lg border flex items-center justify-between',
                          isOverdue && 'border-destructive bg-destructive/5',
                          isDueToday && 'border-amber-500 bg-amber-500/5'
                        )}
                      >
                        <div className="flex items-center gap-4">
                          <div
                            className={cn(
                              'p-2 rounded-full',
                              isOverdue && 'bg-destructive/10',
                              isDueToday && 'bg-amber-500/10',
                              !isOverdue && !isDueToday && 'bg-primary/10'
                            )}
                          >
                            {isOverdue ? (
                              <AlertCircle className="h-5 w-5 text-destructive" />
                            ) : isDueToday ? (
                              <Clock className="h-5 w-5 text-amber-500" />
                            ) : (
                              <CalendarIcon className="h-5 w-5 text-primary" />
                            )}
                          </div>
                          <div>
                            <p className="font-medium">
                              UGX {(loan.total_repayment - loan.paid_amount).toLocaleString()}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              Due {format(new Date(loan.due_date), 'MMM d, yyyy')}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          {isOverdue ? (
                            <Badge variant="destructive">
                              {Math.abs(daysUntil)} day{Math.abs(daysUntil) !== 1 ? 's' : ''} overdue
                            </Badge>
                          ) : isDueToday ? (
                            <Badge className="bg-amber-500">Due Today</Badge>
                          ) : (
                            <Badge variant="secondary">
                              {daysUntil} day{daysUntil !== 1 ? 's' : ''} left
                            </Badge>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
