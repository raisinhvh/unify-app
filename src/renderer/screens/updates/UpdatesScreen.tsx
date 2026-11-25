/**
 * Updates: a calm status page for the app updater (src/main/updater.ts).
 *
 *   header      the Unify mark and the installed version ("Unify V1.3")
 *   status      one view per updater state, each a plain sentence that says what is happening and what comes
 *               next, with at most one action; views crossfade and pop (Presence) in one stacked cell whose
 *               height springs, so the release notes below glide instead of jumping
 *   release     "What's new in X": date, the plain-text notes (line breaks kept, scrolls when long) and a link
 *               to the release on GitHub; reveals with Collapse when the updater knows a release
 *
 * All state comes from updateState.ts (`updateSnapshot()`); this screen never keeps a copy. Updates install only
 * from "Restart and install": Unify closes, the installer shows its progress and reopens Unify when it is done.
 */
import { createMemo, createRoot, createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js';
import type { AppUpdateRelease, AppUpdateStatus } from '../../bridge';
import { bridge } from '../../bridge';
import { LogoMark } from '../../backdrop/Backdrop';
import { actionLoader, Button, Icon, Loader } from '../../components';
import { Collapse, createSpring, driveSpring, Presence, useSpring } from '../../motion';
import { displayVersion } from '../../shell/NavRail';
import { relativeAge } from '../chats/projects';
import { checkForUpdates, installUpdate, updateSnapshot } from './updateState';
import './updates.css';

type UpdateState = AppUpdateStatus['state'];
type StatusOf<State extends UpdateState> = Extract<AppUpdateStatus, { state: State }>;
type LatestStatuses = { [State in UpdateState]?: StatusOf<State> };

/* Formatting */

/** "now" → "just now", "5m" → "5m ago", "Mon" → "on Mon", "12 Nov" → "on 12 Nov". */
function checkedAgo(at: number): string {
  const age = relativeAge(at);
  if (age === 'now') return 'just now';
  if (/^\d+[mhw]$/.test(age)) return `${age} ago`;
  return `on ${age}`;
}

/** Byte counts the way a download reads: "820 KB", "12.4 MB", "230 MB", "1.2 GB". */
function formatBytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(1)} GB`;
  if (megabytes >= 100) return `${Math.round(megabytes)} MB`;
  if (megabytes >= 1) return `${megabytes.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** An ISO date as "24 November 2026"; anything unparseable is shown as given. */
function formatReleaseDate(date: string): string {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, percent));
}

/* State helpers */

/**
 * Module-lifetime memos (the snapshot signal lives as long as the app), in their own root.
 *   latestStatuses   the last status seen for each state: a leaving view reads its own state's last status, so
 *                    its text stays put while it fades instead of switching to the next state's values
 *   shownRelease     the release the updater knows about, kept while the notes collapse away
 */
const { latestStatuses, shownRelease } = createRoot(() => ({
  latestStatuses: createMemo<LatestStatuses>(previous => {
    const status = updateSnapshot().status;
    return {
      ...previous,
      [status.state]: status,
    };
  }, {}),
  shownRelease: createMemo<AppUpdateRelease | undefined>(previous => updateSnapshot().release ?? previous),
}));

function statusOf<State extends UpdateState>(state: State): StatusOf<State> | undefined {
  return latestStatuses()[state] as StatusOf<State> | undefined;
}

const currentState = () => updateSnapshot().status.state;

/* Status views */

function StatusLine(props: { leading?: JSX.Element; children: JSX.Element }): JSX.Element {
  return (
    <h2 class="updates-status-line type-heading">
      <Show when={props.leading}>
        <span class="updates-status-leading">{props.leading}</span>
      </Show>
      <span>{props.children}</span>
    </h2>
  );
}

function CheckButton(): JSX.Element {
  return (
    <Button
      variant="text"
      icon="refresh"
      onClick={checkForUpdates}
    >
      Check for updates
    </Button>
  );
}

function IdleView(): JSX.Element {
  return (
    <div class="updates-status">
      <StatusLine>Not checked yet</StatusLine>
      <p class="updates-status-detail type-body">Check to see whether a newer version of Unify is out.</p>
      <div class="updates-actions">
        <CheckButton />
      </div>
    </div>
  );
}

function CheckingView(): JSX.Element {
  return (
    <div class="updates-status">
      <StatusLine leading={<Loader id={actionLoader.finding} size={14} />}>Checking for updates…</StatusLine>
      <p class="updates-status-detail type-body">This usually takes a few seconds.</p>
    </div>
  );
}

function CurrentView(): JSX.Element {
  const lastChecked = () => updateSnapshot().lastCheckedAt;
  return (
    <div class="updates-status">
      <StatusLine leading={<Icon name="check" class="updates-check" />}>Unify is up to date.</StatusLine>
      <Show when={lastChecked()}>
        {checkedAt => <p class="updates-status-detail type-body">Last checked {checkedAgo(checkedAt())}</p>}
      </Show>
      <div class="updates-actions">
        <CheckButton />
      </div>
    </div>
  );
}

function DownloadingView(): JSX.Element {
  const status = () => statusOf('downloading');
  const percent = () => clampPercent(status()?.percent ?? 0);
  const animatedPercent = createSpring(percent, 'panel', { precision: 100 });
  const transferLine = () => {
    const current = status();
    if (!current) return '';
    const parts = [`${formatBytes(current.transferred)} of ${formatBytes(current.total)}`];
    if (current.bytesPerSecond > 0) parts.push(`${formatBytes(current.bytesPerSecond)}/s`);
    return parts.join(' · ');
  };
  return (
    <div class="updates-status">
      <StatusLine>Downloading Unify {displayVersion(status()?.version ?? '')}…</StatusLine>
      <div class="updates-progress">
        <div
          class="updates-progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent())}
        >
          <div
            class="updates-progress-fill"
            style={{ width: `${clampPercent(animatedPercent())}%` }}
          />
        </div>
        <div class="updates-progress-meta type-caption">
          <span>{transferLine()}</span>
          <span class="updates-progress-percent">{Math.round(percent())}%</span>
        </div>
      </div>
      <p class="updates-status-detail type-body">
        It downloads in the background, so you can keep working. Nothing installs until you choose to.
      </p>
    </div>
  );
}

const installExplanation = 'Unify will close, the installer will show its progress, and Unify reopens when it\'s done. Your chats are saved.';

function ReadyView(): JSX.Element {
  const status = () => statusOf('ready');
  return (
    <div class="updates-status">
      <StatusLine>Unify {displayVersion(status()?.version ?? '')} is ready to install.</StatusLine>
      <p class="updates-status-detail type-body">{installExplanation}</p>
      <div class="updates-actions">
        <Button
          variant="primary"
          onClick={installUpdate}
        >
          Restart and install
        </Button>
      </div>
    </div>
  );
}

function InstallingView(): JSX.Element {
  const status = () => statusOf('installing');
  return (
    <div class="updates-status">
      <StatusLine leading={<Loader id={actionLoader.loading} size={14} />}>
        Closing Unify to install {displayVersion(status()?.version ?? '')}…
      </StatusLine>
      <p class="updates-status-detail type-body">The installer opens next and reopens Unify when it's done.</p>
      <div class="updates-actions">
        <Button
          variant="primary"
          disabled
        >
          Restart and install
        </Button>
      </div>
    </div>
  );
}

function ErrorView(): JSX.Element {
  const status = () => statusOf('error');
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  return (
    <div class="updates-status">
      <StatusLine>{status()?.message ?? 'Something went wrong.'}</StatusLine>
      <div class="updates-actions">
        <Button
          variant="secondary"
          onClick={checkForUpdates}
        >
          Try again
        </Button>
        <Show when={status()?.detail}>
          <Button
            variant="text"
            trailingIcon={detailsOpen() ? 'chevronUp' : 'chevron'}
            aria-expanded={detailsOpen()}
            onClick={() => setDetailsOpen(!detailsOpen())}
          >
            Details
          </Button>
        </Show>
      </div>
      <Collapse open={detailsOpen() && !!status()?.detail}>
        <div class="updates-error-details">
          <pre class="updates-error-detail type-mono">{status()?.detail}</pre>
        </div>
      </Collapse>
    </div>
  );
}

function UnavailableView(): JSX.Element {
  const status = () => statusOf('unavailable');
  return (
    <div class="updates-status">
      <StatusLine>{status()?.message ?? 'Updates are not available here.'}</StatusLine>
    </div>
  );
}

/**
 * Every view sits in the same grid cell, so a leaving view fades while the next one pops in over it. The frame's
 * height springs to the stack's measured height, so whatever sits below follows the change.
 */
function StatusStack(): JSX.Element {
  let stack!: HTMLDivElement;
  const heightSpring = useSpring(0, 'panel', 100);
  const [frameHeight, setFrameHeight] = createSignal<number | undefined>(undefined);
  const stopListening = heightSpring.onChange(value => setFrameHeight(value));
  onCleanup(stopListening);

  onMount(() => {
    heightSpring.jump(stack.offsetHeight);
    setFrameHeight(stack.offsetHeight);
    const observer = new ResizeObserver(() => driveSpring(heightSpring, stack.offsetHeight));
    observer.observe(stack);
    onCleanup(() => observer.disconnect());
  });

  const viewIn = (state: UpdateState, view: () => JSX.Element) => (
    <Presence
      when={currentState() === state}
      from={0.96}
      origin="center top"
    >
      {view()}
    </Presence>
  );

  return (
    <div
      class="updates-status-frame"
      style={{ height: frameHeight() === undefined ? undefined : `${frameHeight()}px` }}
    >
      <div ref={stack} class="updates-status-stack" aria-live="polite">
        {viewIn('idle', () => <IdleView />)}
        {viewIn('checking', () => <CheckingView />)}
        {viewIn('current', () => <CurrentView />)}
        {viewIn('downloading', () => <DownloadingView />)}
        {viewIn('ready', () => <ReadyView />)}
        {viewIn('installing', () => <InstallingView />)}
        {viewIn('error', () => <ErrorView />)}
        {viewIn('unavailable', () => <UnavailableView />)}
      </div>
    </div>
  );
}

/* Release notes */

function ReleaseNotes(): JSX.Element {
  const release = shownRelease;
  const notes = () => release()?.notes?.trim();
  return (
    <div class="updates-release">
      <div class="updates-release-head">
        <div class="updates-release-title">
          <h2 class="type-heading">What's new in {displayVersion(release()?.version ?? '')}</h2>
          <Show when={release()?.date}>
            {date => <span class="updates-release-date type-caption">{formatReleaseDate(date())}</span>}
          </Show>
        </div>
        <Show when={release()?.url}>
          {url => (
            <Button
              variant="text"
              onClick={() => bridge().openExternal(url())}
            >
              View on GitHub
            </Button>
          )}
        </Show>
      </div>
      <Show
        when={notes()}
        fallback={<p class="updates-release-empty type-caption">No release notes for this version.</p>}
      >
        {text => <div class="updates-notes type-body">{text()}</div>}
      </Show>
    </div>
  );
}

/* Screen */

export function UpdatesScreen(): JSX.Element {
  return (
    <div class="updates-screen">
      <div class="updates-column">
        <header class="updates-header">
          <LogoMark size={44} />
          <h1 class="updates-version type-title">Unify {displayVersion(updateSnapshot().currentVersion)}</h1>
        </header>
        <StatusStack />
        <Collapse open={!!updateSnapshot().release}>
          <ReleaseNotes />
        </Collapse>
      </div>
    </div>
  );
}
