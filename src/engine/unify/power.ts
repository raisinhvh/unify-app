/**
 * "Shut down when all tasks finish" (feature `power.shutdownWhenIdle`). Engine-side, so it keeps
 * working while the window is closed or minimised.
 *
 * Wiring guide (extension.ts owner):
 *   1. Once on activation, after chat state is restored:
 *        const shutdownController = createShutdownController({
 *          getActivity: () => ({ runningChats, runningSubagents, pendingApprovals, pendingQuestions, runningProcesses }),
 *          onActivityChange: (listener) => subscribe(listener),  // call listener whenever any count may have changed; return unsubscribe
 *          saveState: () => saveAllChatAndWindowState(),          // flush everything to disk; a rejection aborts the shutdown
 *          notify: (title, body) => showDesktopNotification(title, body),
 *          post: (message) => broadcastToEveryWebview(message),   // ShutdownMessage
 *        });
 *        context.subscriptions.push({ dispose: () => shutdownController.dispose() });
 *      Creating it clears a leftover armed value from the last run unless `power.rememberArmed` is on.
 *   2. Counts cover every chat and subagent in every pane. A tool process counts until it exits.
 *   3. UI → engine `{ type: 'cancelShutdown' }` → shutdownController.cancelShutdown().
 *   4. Arming/disarming needs no wiring: the UI already sends `setUnifyFeature` for
 *      `power.shutdownWhenIdle`, and the controller listens through onUnifyFeatureChange.
 *   5. For viewState (title-bar indicator on reload), read shutdownController.getStatus().
 */
import { execFile } from 'child_process';
import { getUnifyFeature, onUnifyFeatureChange, setUnifyFeature, type UnifyFeatureValue } from './settings';

export interface ShutdownActivity {
  runningChats: number;
  runningSubagents: number;
  pendingApprovals: number;
  pendingQuestions: number;
  runningProcesses: number;
}

export type ShutdownArmedMessage = { type: 'shutdownArmed'; armed: boolean };
export type ShutdownCountdownMessage = { type: 'shutdownCountdown'; secondsLeft: number };
/** The user cancelled; the switch is now off. */
export type ShutdownCancelledMessage = { type: 'shutdownCancelled' };
/** A countdown stopped because work resumed; still armed and waiting. Hide the overlay. */
export type ShutdownWaitingMessage = { type: 'shutdownWaiting' };
export type ShutdownFailedMessage = { type: 'shutdownFailed'; error: string };
export type ShutdownMessage =
  | ShutdownArmedMessage
  | ShutdownCountdownMessage
  | ShutdownCancelledMessage
  | ShutdownWaitingMessage
  | ShutdownFailedMessage;

/** UI → engine. */
export type CancelShutdownMessage = { type: 'cancelShutdown' };

export type ShutdownPhase = 'disarmed' | 'waiting' | 'settling' | 'countdown' | 'shuttingDown';

export interface ShutdownStatus {
  armed: boolean;
  phase: ShutdownPhase;
  /** Set only during the countdown. */
  secondsLeft?: number;
}

export type ShutdownExec = (file: string, args: string[]) => Promise<void>;

export interface ShutdownTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ShutdownSettings {
  get(id: 'power.shutdownWhenIdle' | 'power.rememberArmed'): boolean;
  set(id: 'power.shutdownWhenIdle', value: boolean): void;
  onChange(listener: (id: string, value: UnifyFeatureValue) => void): () => void;
}

export interface ShutdownControllerDependencies {
  getActivity(): ShutdownActivity;
  onActivityChange(listener: () => void): () => void;
  saveState(): Promise<void>;
  notify(title: string, body: string): void;
  post(message: ShutdownMessage): void;
  platform?: NodeJS.Platform;
  exec?: ShutdownExec;
  timers?: ShutdownTimers;
  settings?: ShutdownSettings;
  idleDebounceMilliseconds?: number;
  countdownSeconds?: number;
}

export interface ShutdownController {
  cancelShutdown(): void;
  getStatus(): ShutdownStatus;
  dispose(): void;
}

export interface ShutdownCommand {
  file: string;
  args: string[];
}

export const DEFAULT_IDLE_DEBOUNCE_MILLISECONDS = 5000;
export const DEFAULT_COUNTDOWN_SECONDS = 60;
const SHUTDOWN_FEATURE = 'power.shutdownWhenIdle';

/** Primary command first, then the fallback. */
export function shutdownCommandsFor(platform: NodeJS.Platform): ShutdownCommand[] {
  if (platform === 'win32') {
    return [
      { file: 'shutdown', args: ['/s', '/t', '0'] },
      { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Stop-Computer -Force'] },
    ];
  }
  if (platform === 'darwin') {
    return [
      { file: 'osascript', args: ['-e', 'tell app "System Events" to shut down'] },
      { file: 'shutdown', args: ['-h', 'now'] },
    ];
  }
  return [
    { file: 'systemctl', args: ['poweroff'] },
    { file: 'shutdown', args: ['-h', 'now'] },
  ];
}

export function isIdle(activity: ShutdownActivity): boolean {
  return activity.runningChats === 0
    && activity.runningSubagents === 0
    && activity.pendingApprovals === 0
    && activity.pendingQuestions === 0
    && activity.runningProcesses === 0;
}

function isWaitingOnUser(activity: ShutdownActivity): boolean {
  return activity.pendingApprovals > 0 || activity.pendingQuestions > 0;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const defaultExec: ShutdownExec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: 30_000 }, (error, _stdout, stderr) => {
    if (error) {
      const details = String(stderr ?? '').trim();
      reject(new Error(details ? `${error.message}: ${details}` : error.message));
      return;
    }
    resolve();
  });
});

const defaultTimers: ShutdownTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const defaultSettings: ShutdownSettings = {
  get: (id) => getUnifyFeature(id),
  set: (id, value) => setUnifyFeature(id, value),
  onChange: (listener) => onUnifyFeatureChange(listener),
};

export function createShutdownController(dependencies: ShutdownControllerDependencies): ShutdownController {
  const platform = dependencies.platform ?? process.platform;
  const exec = dependencies.exec ?? defaultExec;
  const timers = dependencies.timers ?? defaultTimers;
  const settings = dependencies.settings ?? defaultSettings;
  const idleDebounceMilliseconds = dependencies.idleDebounceMilliseconds ?? DEFAULT_IDLE_DEBOUNCE_MILLISECONDS;
  const countdownSeconds = dependencies.countdownSeconds ?? DEFAULT_COUNTDOWN_SECONDS;

  let phase: ShutdownPhase = 'disarmed';
  let secondsLeft = 0;
  let pendingTimer: unknown;
  let notifiedWaitingOnUser = false;
  let disposed = false;

  function clearPendingTimer(): void {
    if (pendingTimer === undefined) return;
    timers.clearTimeout(pendingTimer);
    pendingTimer = undefined;
  }

  function arm(): void {
    if (phase !== 'disarmed') return;
    phase = 'waiting';
    notifiedWaitingOnUser = false;
    dependencies.post({ type: 'shutdownArmed', armed: true });
    evaluate();
  }

  /** Stops everything locally. Callers decide whether the stored switch must also be turned off. */
  function disarm(): void {
    if (phase === 'disarmed') return;
    clearPendingTimer();
    phase = 'disarmed';
    dependencies.post({ type: 'shutdownArmed', armed: false });
  }

  /** One-shot: turning the stored switch off also disarms through the feature listener. */
  function turnSwitchOff(): void {
    if (settings.get(SHUTDOWN_FEATURE)) settings.set(SHUTDOWN_FEATURE, false);
    disarm();
  }

  function returnToWaiting(): void {
    const wasCountingDown = phase === 'countdown' || phase === 'shuttingDown';
    clearPendingTimer();
    phase = 'waiting';
    if (wasCountingDown) dependencies.post({ type: 'shutdownWaiting' });
  }

  function evaluate(): void {
    if (phase === 'disarmed' || phase === 'shuttingDown') return;
    const activity = dependencies.getActivity();

    if (isWaitingOnUser(activity)) {
      if (!notifiedWaitingOnUser) {
        notifiedWaitingOnUser = true;
        dependencies.notify(
          'Shutdown is waiting on you',
          'An approval or question needs an answer before Unify can shut down the PC.',
        );
      }
    } else {
      notifiedWaitingOnUser = false;
    }

    if (!isIdle(activity)) {
      if (phase !== 'waiting') returnToWaiting();
      return;
    }
    if (phase === 'waiting') {
      phase = 'settling';
      pendingTimer = timers.setTimeout(onSettled, idleDebounceMilliseconds);
    }
  }

  function onSettled(): void {
    pendingTimer = undefined;
    if (!isIdle(dependencies.getActivity())) {
      returnToWaiting();
      return;
    }
    phase = 'countdown';
    secondsLeft = countdownSeconds;
    dependencies.notify(
      `Shutting down in ${countdownSeconds} seconds`,
      'All tasks finished. Cancel in Unify to keep the PC on.',
    );
    dependencies.post({ type: 'shutdownCountdown', secondsLeft });
    pendingTimer = timers.setTimeout(onCountdownTick, 1000);
  }

  function onCountdownTick(): void {
    pendingTimer = undefined;
    secondsLeft -= 1;
    dependencies.post({ type: 'shutdownCountdown', secondsLeft });
    if (secondsLeft > 0) {
      pendingTimer = timers.setTimeout(onCountdownTick, 1000);
      return;
    }
    void fire();
  }

  function reportFailure(error: string): void {
    dependencies.post({ type: 'shutdownFailed', error });
    dependencies.notify('Shutdown failed', error);
  }

  async function fire(): Promise<void> {
    if (!isIdle(dependencies.getActivity())) {
      returnToWaiting();
      return;
    }
    phase = 'shuttingDown';

    try {
      await dependencies.saveState();
    } catch (error) {
      reportFailure(`Could not save state before shutting down: ${describeError(error)}`);
      turnSwitchOff();
      return;
    }
    if (disposed || phase !== 'shuttingDown') return;
    if (!isIdle(dependencies.getActivity())) {
      returnToWaiting();
      evaluate();
      return;
    }

    // Turned off before the OS command so a successful shutdown never boots back up armed.
    turnSwitchOff();

    const failures: string[] = [];
    for (const command of shutdownCommandsFor(platform)) {
      try {
        await exec(command.file, command.args);
        return;
      } catch (error) {
        failures.push(`${command.file}: ${describeError(error)}`);
      }
    }
    reportFailure(failures.join('; '));
  }

  function onFeatureChange(id: string, value: UnifyFeatureValue): void {
    if (disposed || id !== SHUTDOWN_FEATURE) return;
    if (value === true) {
      arm();
      return;
    }
    if (phase === 'shuttingDown') return;
    disarm();
  }

  if (settings.get(SHUTDOWN_FEATURE) && !settings.get('power.rememberArmed')) {
    settings.set(SHUTDOWN_FEATURE, false);
  }
  const unsubscribeFeature = settings.onChange(onFeatureChange);
  const unsubscribeActivity = dependencies.onActivityChange(evaluate);
  if (settings.get(SHUTDOWN_FEATURE)) arm();

  return {
    cancelShutdown(): void {
      if (phase === 'disarmed' || phase === 'shuttingDown') return;
      clearPendingTimer();
      dependencies.post({ type: 'shutdownCancelled' });
      turnSwitchOff();
    },
    getStatus(): ShutdownStatus {
      const armed = phase !== 'disarmed';
      return phase === 'countdown' ? { armed, phase, secondsLeft } : { armed, phase };
    },
    dispose(): void {
      disposed = true;
      clearPendingTimer();
      unsubscribeFeature();
      unsubscribeActivity();
    },
  };
}
