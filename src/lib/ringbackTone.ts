/**
 * Looping ringback tone for the Call Centre dialer, via the Web Audio API.
 *
 * Follows the same no-asset approach as `notificationSound.ts` — nothing to
 * download, nothing to bundle, and no CSP media host. Unlike the one-shot
 * notification sounds this has to keep ringing until the call is answered or
 * hung up, so it returns a stop handle instead of firing and forgetting.
 *
 * Cadence is the classic dual-tone ringback (440 Hz + 480 Hz) so it reads
 * instantly as "a phone is ringing", on a 2 s ring / 3 s silence cycle.
 */

const RING_HZ = [440, 480];
const RING_SECONDS = 2;
const SILENCE_SECONDS = 3;
const CYCLE_SECONDS = RING_SECONDS + SILENCE_SECONDS;
/** Per-oscillator gain. Two oscillators sum, so keep each modest. */
const PEAK_GAIN = 0.09;

export interface RingbackHandle {
  /** Stop ringing and release the audio nodes. Safe to call more than once. */
  stop: () => void;
}

/** A no-op handle, so callers never branch on null. */
const SILENT: RingbackHandle = { stop: () => {} };

let sharedContext: AudioContext | null = null;

function getContext(): AudioContext | null {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!sharedContext || sharedContext.state === 'closed') sharedContext = new Ctor();
    return sharedContext;
  } catch {
    return null;
  }
}

/**
 * Start ringing. Returns a handle whose `stop()` ends the tone.
 *
 * Scheduling is done up front for `maxSeconds` of cycles rather than with a
 * timer, so the cadence cannot drift or be starved by a busy main thread. If
 * audio is unavailable (unsupported, blocked, or no prior user gesture) this
 * returns the silent handle — the dialer must still work without sound.
 */
export function startRingback(maxSeconds = 60): RingbackHandle {
  const ctx = getContext();
  if (!ctx) return SILENT;

  try {
    // Autoplay policies suspend the context until a user gesture. The dialer is
    // opened by a click, so resuming here is allowed.
    if (ctx.state === 'suspended') void ctx.resume();

    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);

    const oscillators: OscillatorNode[] = [];
    const startAt = ctx.currentTime;
    const cycles = Math.max(1, Math.ceil(maxSeconds / CYCLE_SECONDS));

    for (const hz of RING_HZ) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      osc.connect(gain);
      gain.connect(master);

      // Gate the gain on/off so one oscillator produces the whole cadence.
      gain.gain.setValueAtTime(0, startAt);
      for (let c = 0; c < cycles; c += 1) {
        const ringStart = startAt + c * CYCLE_SECONDS;
        // Short ramps instead of hard steps — an instant gain jump clicks.
        gain.gain.setValueAtTime(0, ringStart);
        gain.gain.linearRampToValueAtTime(PEAK_GAIN, ringStart + 0.04);
        gain.gain.setValueAtTime(PEAK_GAIN, ringStart + RING_SECONDS - 0.04);
        gain.gain.linearRampToValueAtTime(0, ringStart + RING_SECONDS);
      }

      osc.start(startAt);
      osc.stop(startAt + cycles * CYCLE_SECONDS);
      oscillators.push(osc);
    }

    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        try {
          // Fade out over 60 ms rather than cutting, which would click.
          const now = ctx.currentTime;
          master.gain.cancelScheduledValues(now);
          master.gain.setValueAtTime(master.gain.value, now);
          master.gain.linearRampToValueAtTime(0, now + 0.06);
          oscillators.forEach((osc) => {
            try {
              osc.stop(now + 0.08);
            } catch {
              /* already stopped */
            }
          });
          window.setTimeout(() => {
            try {
              master.disconnect();
            } catch {
              /* already disconnected */
            }
          }, 120);
        } catch {
          /* nothing recoverable — the tone is ending either way */
        }
      },
    };
  } catch {
    return SILENT;
  }
}
