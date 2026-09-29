/**
 * Alert sound - a short synthesized beep for notifications.
 *
 * Uses the Web Audio API so there's no asset file to ship. The AudioContext is
 * created lazily and shared; browsers start it suspended until a user gesture,
 * so playAlertBeep() resumes it first (the page is interactive by the time any
 * alert fires). Everything is wrapped in try/catch — a missing/blocked audio
 * context should never break the caller.
 */

let audioCtx = null;

function getAudioContext() {
  if (audioCtx) return audioCtx;
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctor) return null;
  try {
    audioCtx = new Ctor();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

// Play a short two-tone-ish beep (~880Hz, ~180ms) with a gentle gain envelope
// so it doesn't click. No-op when Web Audio is unavailable.
export function playAlertBeep() {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    // Quick attack, short decay to avoid clicks.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  } catch {
    // Ignore — audio is a non-critical enhancement.
  }
}

export default { playAlertBeep };
