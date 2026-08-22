import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import config from '../../../resources/config/config';
import { trackCta } from '../../../services/onboarding/onboardingAnalytics';
import { useFooterVisibility } from '../../../utils/useFooterVisibility';
import { useAuthSession } from '../../../auth/AuthSessionProvider';
import { buildLoginRedirectPath } from '../../../auth/routePolicy';

// Types
export interface TimeSlot { startTime: string; endTime: string; available: boolean; }
export interface DayAvailability { date: string; slots: TimeSlot[]; }
export interface CalendarData { ceo: { name: string; email: string }; timezone: string; meetingDuration: number; availability: DayAvailability[]; }
export type PaymentState = 'loading' | 'not_paid' | 'paid' | 'booked';

export function useMeetCeoLogic() {
  const navigate = useNavigate();
  const { session, status, user } = useAuthSession();
  const [paymentState, setPaymentState] = useState<PaymentState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [hushhCoins, setHushhCoins] = useState(0);
  const isFooterVisible = useFooterVisibility();

  // Calendar state
  const [calendarData, setCalendarData] = useState<CalendarData | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot | null>(null);
  const [bookingInProgress, setBookingInProgress] = useState(false);

  useEffect(() => { window.scrollTo({ top: 0 }); }, []);

  /* ── Send Hushh Coins credit email (fire-and-forget) ── */
  const sendCoinsEmail = useCallback(async (email: string, name: string, coins: number) => {
    try {
      if (!session?.access_token) return;
      await fetch(`${config.GCP_API_BASE_URL}/functions/v1/coins-credit-notification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ recipientEmail: email, recipientName: name, coinsAwarded: coins }),
      });
    } catch (err) { console.error('Coins email failed (non-blocking):', err); }
  }, [session?.access_token]);

  /* ── Send Hushh Coins deduction email when meeting is booked (fire-and-forget) ── */
  const sendCoinsDeductionEmail = useCallback(async (email: string, name: string, coins: number, meetingDate: string, meetingTime: string) => {
    try {
      if (!session?.access_token) return;
      await fetch(`${config.GCP_API_BASE_URL}/functions/v1/coins-deduction-notification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ recipientEmail: email, recipientName: name, coinsDeducted: coins, meetingDate, meetingTime }),
      });
    } catch (err) { console.error('Deduction email failed (non-blocking):', err); }
  }, [session?.access_token]);

  /* ── Payment status ──
   * The single $1 is paid once, at step-9 (the fund commitment). Reaching this
   * page means InvestorAccessRoute already confirmed that fund payment, so the
   * Meet-CEO perk (300,000 Hushh Coins + the 1-on-1 unlock) is granted here for
   * FREE — there is NO second $1. The grant is idempotent on the user_id-unique
   * ceo_meeting_payments row, so a row already created by the Stripe webhook
   * backstop (or a legacy coupon/$1 row) is preserved and never double-granted.
   */
  const checkPaymentStatus = useCallback(async () => {
    if (status === 'booting') return;
    if (!config.gcpBackendClient) { setPaymentState('not_paid'); return; }
    try {
      if (status !== 'authenticated' || !user) {
        navigate(buildLoginRedirectPath('/onboarding/meet-ceo'), { replace: true });
        return;
      }
      const { data: payment } = await config.gcpBackendClient
        .from('ceo_meeting_payments').select('*').eq('user_id', user.id).maybeSingle();
      if (payment?.payment_status === 'completed') {
        setHushhCoins(payment.hushh_coins_awarded || 300000);
        setPaymentState(payment.calendly_booked ? 'booked' : 'paid');
        return;
      }
      // No perk row yet (webhook delayed / not run) — grant it now, free.
      const { error: grantErr } = await config.gcpBackendClient
        .from('ceo_meeting_payments')
        .upsert({
          user_id: user.id,
          payment_status: 'completed',
          payment_method: 'fund_step9',
          amount_cents: 0,
          hushh_coins_awarded: 300000,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });
      setHushhCoins(300000);
      setPaymentState('paid');
      if (!grantErr) {
        sendCoinsEmail(user.email || '', user.user_metadata?.full_name || 'Hushh User', 300000);
      }
    } catch { setPaymentState('not_paid'); }
  }, [navigate, status, user, sendCoinsEmail]);

  const fetchCalendarSlots = useCallback(async () => {
    setLoadingSlots(true);
    try {
      if (!session?.access_token) { setLoadingSlots(false); return; }
      const res = await fetch(`${config.GCP_API_BASE_URL}/functions/v1/ceo-calendar-booking?days=14`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (data.success) { setCalendarData(data); if (data.availability?.length) setSelectedDate(data.availability[0].date); }
    } catch (err) { console.error('Calendar fetch error:', err); }
    finally { setLoadingSlots(false); }
  }, [session?.access_token]);

  const handleBookMeeting = async () => {
    trackCta('book_meeting', 'meet-ceo');
    if (!selectedSlot) return;
    setBookingInProgress(true); setError(null);
    try {
      if (!session?.access_token || !user) throw new Error('Not authenticated');
      const res = await fetch(`${config.GCP_API_BASE_URL}/functions/v1/ceo-calendar-booking`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ startTime: selectedSlot.startTime, endTime: selectedSlot.endTime, attendeeName: user?.user_metadata?.full_name || 'Hushh User' }),
      });
      const result = await res.json();
      if (result.success) {
        setPaymentState('booked');
        // Send coins deduction email after successful booking
        const meetingDate = new Date(selectedSlot.startTime).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        const meetingTime = `${new Date(selectedSlot.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })} – ${new Date(selectedSlot.endTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
        sendCoinsDeductionEmail(user?.email || '', user?.user_metadata?.full_name || 'Hushh User', 300000, meetingDate, meetingTime);
      } else throw new Error(result.error || 'Booking failed');
    } catch (err: any) { setError(err.message); }
    finally { setBookingInProgress(false); }
  };

  useEffect(() => {
    void checkPaymentStatus();
  }, [checkPaymentStatus]);

  // Fetch calendar when paid
  useEffect(() => {
    if (paymentState === 'paid') {
      void fetchCalendarSlots();
    }
  }, [fetchCalendarSlots, paymentState]);

  const handleContinue = () => {
    trackCta('meet_ceo_to_profile', 'meet-ceo');
    navigate('/hushh-user-profile');
  };
  const handleBack = () => navigate('/onboarding/step-6');

  return {
    paymentState,
    error,
    hushhCoins,
    isFooterVisible,
    // Calendar
    calendarData,
    loadingSlots,
    selectedDate,
    setSelectedDate,
    selectedSlot,
    setSelectedSlot,
    bookingInProgress,
    // Handlers
    handleBookMeeting,
    handleContinue,
    handleBack,
  };
}
