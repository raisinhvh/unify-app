/**
 * Soft chime when an agent needs the user (approval or question request), behind the
 * 'notifications.sound' feature. The sound is synthesized with WebAudio — no asset files —
 * so it can start the moment a request arrives without anything being loaded.
 */
import { onHostMessage } from './index';
import { feature } from './features';

/** Only one chime per this window, so a burst of requests does not stack into noise. */
const CHIME_INTERVAL_MS = 1500;

let audioContext: AudioContext | undefined;
let lastChimeAt = 0;

/** Lazily create the shared AudioContext on first use (browsers require a user gesture first). */
function context(): AudioContext | undefined {
  if (!audioContext) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return undefined;
    audioContext = new Ctor();
  }
  if (audioContext.state === 'suspended') void audioContext.resume();
  return audioContext;
}

/** One short sine tone with a gentle attack/release envelope so the chime stays soft. */
function tone(audio: AudioContext, startAt: number, frequency: number): void {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  const duration = 0.12;

  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(0.08, startAt + 0.02);
  gain.gain.linearRampToValueAtTime(0, startAt + duration);

  oscillator.connect(gain).connect(audio.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration);
}

/** Play the two-tone chime (A5 then E6-ish), unless one played very recently. */
function chime(): void {
  const now = Date.now();
  if (now - lastChimeAt < CHIME_INTERVAL_MS) return;
  lastChimeAt = now;

  const audio = context();
  if (!audio) return;
  tone(audio, audio.currentTime, 660);
  tone(audio, audio.currentTime + 0.12, 880);
}

/**
 * Listen for host messages and chime when a NEW request needs the user. Returns the
 * unsubscribe function.
 */
export function startNotifySound(): () => void {
  return onHostMessage(message => {
    if (message.type !== 'approvalRequest' && message.type !== 'questionRequest') return;
    if (!feature<boolean>('notifications.sound')) return;
    chime();
  });
}
