/**
 * Voice dictation for the composer: the mic button next to Send, the muted status line under the input, and the
 * session that talks to the engine (voiceStart / voiceStop out; voiceState, voiceHypothesis, voiceResult in).
 *
 *   const voice = createVoiceSession(parts => applyParts(parts));   // in Composer; parts go to the textarea
 *   <Show when={voice.enabled()}><VoiceButton voice={voice} /></Show>
 *   <VoiceHint voice={voice} />
 *
 * Only the composer that started dictation owns the results, so several composers on one page don't all type the
 * same words. The engine has one dictation at a time.
 */
import { createEffect, createSignal, on, onCleanup, Show, type JSX } from 'solid-js';
import type { VoicePart } from '../../../engine/voice/dictation';
import { post } from '../../bridge';
import { onHostMessage, viewState } from '../../store';
import './voice-button.css';

const errorMs = 6000;

export interface VoiceSession {
  /** Windows speech is available and the "Voice input" setting is on. */
  enabled: () => boolean;
  /** This composer started dictation and the engine hasn't reported it stopped yet. */
  owned: () => boolean;
  /** The engine is recording right now. */
  listening: () => boolean;
  /** Live placeholder from the engine ("…" while speech is heard, empty when idle). */
  hypothesis: () => string;
  /** A failure message from the engine, cleared after a few seconds. */
  error: () => string | undefined;
  toggle: () => void;
  stop: () => void;
}

export function createVoiceSession(onResult: (parts: VoicePart[]) => void): VoiceSession {
  const [owned, setOwned] = createSignal(false);
  const [listening, setListening] = createSignal(false);
  const [hypothesis, setHypothesis] = createSignal('');
  const [error, setError] = createSignal<string>();
  let errorTimer: number | undefined;
  const enabled = () => !!viewState.voiceAvailable && !!viewState.features.voice;

  const showError = (message: string) => {
    setError(message);
    window.clearTimeout(errorTimer);
    errorTimer = window.setTimeout(() => setError(undefined), errorMs);
  };

  function start(): void {
    if (owned()) return;
    setError(undefined);
    // Optimistic: the engine may first download Whisper, and its voiceState follows.
    setOwned(true);
    setListening(true);
    post({ type: 'voiceStart' });
  }

  function stop(): void {
    if (!owned()) return;
    // Results for phrases still being transcribed keep arriving until the engine reports voiceState false.
    setListening(false);
    post({ type: 'voiceStop' });
  }

  function toggle(): void {
    if (owned()) {
      if (listening()) stop();
    } else {
      start();
    }
  }

  const stopListening = onHostMessage(message => {
    if (!owned()) return;
    if (message.type === 'voiceState') {
      if (message.error) showError(message.error);
      if (!message.listening) {
        setOwned(false);
        setListening(false);
        setHypothesis('');
      } else {
        setListening(true);
      }
    } else if (message.type === 'voiceHypothesis') {
      setHypothesis(message.text);
    } else if (message.type === 'voiceResult') {
      setHypothesis('');
      onResult(message.parts);
    }
  });

  // Turning the setting off (or losing voice support) ends a running session.
  createEffect(on(enabled, isOn => {
    if (!isOn) stop();
  }, { defer: true }));

  onCleanup(() => {
    stopListening();
    window.clearTimeout(errorTimer);
    // Unmounting mid-dictation must not leave the microphone open.
    if (owned()) post({ type: 'voiceStop' });
    setOwned(false);
  });

  return { enabled, owned, listening, hypothesis, error, toggle, stop };
}

/** The mic button. A plain button: the shared IconButton only takes names from icons.ts, which has no mic glyph. */
export function VoiceButton(props: { voice: VoiceSession }): JSX.Element {
  return (
    <button
      type="button"
      class="icon-button icon-button-medium voice-button"
      classList={{ listening: props.voice.listening() }}
      aria-pressed={props.voice.listening()}
      aria-label={props.voice.listening() ? 'Stop voice input' : 'Start voice input'}
      title={props.voice.listening() ? 'Stop voice input (Ctrl+Shift+Space)' : 'Voice input (Ctrl+Shift+Space)'}
      onClick={() => props.voice.toggle()}
    >
      <svg class="voice-button-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
        <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
        <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V14.5M5.5 14.5h5" />
      </svg>
    </button>
  );
}

/** Muted status under the input: the live placeholder while listening, "Transcribing…" after stop, or an error. */
export function VoiceHint(props: { voice: VoiceSession }): JSX.Element {
  const text = () => {
    if (props.voice.error()) return props.voice.error();
    if (!props.voice.owned()) return undefined;
    if (!props.voice.listening()) return 'Transcribing…';
    const heard = props.voice.hypothesis();
    return heard && heard !== '…' ? heard : 'Listening…';
  };
  return (
    <Show when={text()}>
      <div class="voice-hint" classList={{ error: !!props.voice.error() }} role="status" aria-live="polite">{text()}</div>
    </Show>
  );
}
