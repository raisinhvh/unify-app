/**
 * Providers › a Local account: the Unify-managed server behind it.
 *
 * Status (Stopped / Starting… / Running on 127.0.0.1:PORT / Error) with Start, Stop and Restart; problems that
 * block starting; the engine's settings rendered generically (advanced ones behind a collapsed "Advanced"); the
 * server options (port, auto start, idle stop); the command preview; the live log; and Save as preset.
 *
 * Edits are a local draft over the saved config. Save sends localServerSave and the draft clears when the
 * engine's state comes back with a newer updatedAt. Deleting is the account's Remove (the engine deletes the
 * server when its account goes), so this panel never sends localServerDelete.
 */
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { Button, Toggle } from '../../../components';
import { Collapse } from '../../../motion';
import type { LocalFieldSpec, LocalServerView, LocalValue, LocalValues } from '../../../../engine/local/types';
import { FadeText, FieldGroups } from './FieldControl';
import {
  localEngine,
  localLogs,
  requestServerLogs,
  restartServer,
  savePreset,
  saveServer,
  startServer,
  stopServer,
} from './localStore';
import './local.css';

/* ---------- status ---------- */

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** Ticks once a second while `active` is true. */
function useNow(active: () => boolean): () => number {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!active()) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  return now;
}

export function localStatusText(server: LocalServerView): string {
  const status = server.status;
  switch (status.state) {
    case 'starting':
      return 'Starting…';
    case 'running':
      return `Running on 127.0.0.1:${status.port}`;
    case 'stopping':
      return 'Stopping…';
    case 'error':
      return 'Error';
    default:
      return 'Stopped';
  }
}

/** The status words with a small loader while moving, cross-faded on change. */
export function LocalStatus(props: { server: LocalServerView; elapsed?: boolean }): JSX.Element {
  const state = () => props.server.status.state;
  const moving = () => state() === 'starting' || state() === 'stopping';
  const now = useNow(() => !!props.elapsed && state() === 'starting');
  const elapsed = () => {
    const startedAt = props.server.status.startedAt;
    return props.elapsed && state() === 'starting' && startedAt ? formatElapsed(now() - startedAt) : '';
  };
  return (
    <span class="pv-local-status" classList={{ running: state() === 'running', error: state() === 'error' }}>
      <Show when={moving()}>
        <span class="pv-spinner pv-local-status-spinner" aria-hidden="true" />
      </Show>
      <FadeText text={localStatusText(props.server)} />
      <Show when={elapsed()}>
        <span class="pv-local-status-elapsed type-mono">{elapsed()}</span>
      </Show>
    </span>
  );
}

/* ---------- draft ---------- */

interface ServerDraft {
  values: LocalValues;
  port?: number;
  autoStart?: boolean;
  idleStopMinutes?: number;
}

const sameValue = (first: LocalValue | undefined, second: LocalValue | undefined): boolean =>
  (first ?? '') === (second ?? '');

/* ---------- log ---------- */

function LogView(props: { serverId: string }): JSX.Element {
  let pre!: HTMLPreElement;
  const [following, setFollowing] = createSignal(true);
  const text = () => localLogs(props.serverId).join('\n');

  onMount(() => requestServerLogs(props.serverId));
  createEffect(on(() => props.serverId, id => requestServerLogs(id), { defer: true }));

  createEffect(
    on(text, () => {
      if (following()) queueMicrotask(() => (pre.scrollTop = pre.scrollHeight));
    }),
  );

  const onScroll = () => {
    const distance = pre.scrollHeight - pre.scrollTop - pre.clientHeight;
    setFollowing(distance < 8);
  };

  return (
    <div class="pv-local-log-wrap">
      <pre ref={pre} class="pv-local-mono-block pv-local-log type-mono" onScroll={onScroll} tabIndex={0} aria-label="Server log">
        <Show when={text()} fallback={<span class="pv-local-muted">No output yet.</span>}>
          {text()}
        </Show>
      </pre>
      <Show when={!following()}>
        <button
          type="button"
          class="pv-row-action pv-local-follow"
          onClick={() => {
            setFollowing(true);
            pre.scrollTop = pre.scrollHeight;
          }}
        >
          Follow
        </button>
      </Show>
    </div>
  );
}

/* ---------- panel ---------- */

export function LocalServerPanel(props: { server: LocalServerView }): JSX.Element {
  const server = () => props.server;
  const config = () => server().config;
  const status = () => server().status;
  const engine = () => localEngine(config().engine);
  const specs = (): LocalFieldSpec[] => engine()?.fields ?? [];
  const basicSpecs = () => specs().filter(spec => !spec.advanced);
  // Inside the Advanced section a group literally named "Advanced" would repeat the section title. Fields
  // without a heading come first, so they never read as part of the group above them.
  const advancedSpecs = () => {
    const advanced = specs()
      .filter(spec => spec.advanced)
      .map(spec => (spec.group === 'Advanced' ? { ...spec, group: undefined } : spec));
    return [...advanced.filter(spec => !spec.group), ...advanced.filter(spec => spec.group)];
  };

  const [draft, setDraft] = createSignal<ServerDraft>({ values: {} });
  const [advancedOpen, setAdvancedOpen] = createSignal(false);
  const [presetNaming, setPresetNaming] = createSignal(false);
  const [presetName, setPresetName] = createSignal('');
  const [copied, setCopied] = createSignal(false);

  // A new server, or the engine confirming a save, drops the draft.
  createEffect(on(() => [config().id, config().updatedAt], () => setDraft({ values: {} })));

  const values = createMemo<LocalValues>(() => ({ ...config().values, ...draft().values }));
  const port = () => draft().port ?? config().port;
  const autoStart = () => draft().autoStart ?? config().autoStart;
  const idleStopMinutes = () => draft().idleStopMinutes ?? config().idleStopMinutes;

  const changedValues = createMemo<LocalValues>(() => {
    const changed: LocalValues = {};
    for (const [id, value] of Object.entries(draft().values)) {
      if (!sameValue(value, config().values[id])) changed[id] = value;
    }
    return changed;
  });
  const dirty = () =>
    Object.keys(changedValues()).length > 0
    || (draft().port !== undefined && draft().port !== config().port)
    || (draft().autoStart !== undefined && draft().autoStart !== config().autoStart)
    || (draft().idleStopMinutes !== undefined && draft().idleStopMinutes !== config().idleStopMinutes);

  const setValue = (id: string, value: LocalValue) =>
    setDraft(current => ({ ...current, values: { ...current.values, [id]: value } }));

  const save = () => {
    if (!dirty()) return;
    const changes: Parameters<typeof saveServer>[1] = {};
    if (Object.keys(changedValues()).length) changes.values = values();
    if (draft().port !== undefined && draft().port !== config().port) changes.port = draft().port;
    if (draft().autoStart !== undefined && draft().autoStart !== config().autoStart) changes.autoStart = draft().autoStart;
    if (draft().idleStopMinutes !== undefined && draft().idleStopMinutes !== config().idleStopMinutes) {
      changes.idleStopMinutes = draft().idleStopMinutes;
    }
    saveServer(config().id, changes);
  };

  const running = () => status().state === 'running' || status().state === 'starting';
  const busy = () => status().state === 'starting' || status().state === 'stopping';
  const blocked = () => server().problems.length > 0;

  const copyCommand = async () => {
    const command = status().command || server().commandPreview;
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const commitPreset = () => {
    const name = presetName().trim();
    if (!name) return;
    savePreset(config().id, name);
    setPresetNaming(false);
    setPresetName('');
  };

  return (
    <div class="pv-local-panel">
      <section class="pv-section">
        <h2 class="pv-section-heading">Status</h2>
        <Show when={blocked()}>
          <ul class="pv-local-problems" aria-label="Problems">
            <For each={server().problems}>{problem => <li>{problem}</li>}</For>
          </ul>
        </Show>
        <div class="pv-rows">
          <div class="pv-setting-row pv-local-status-row">
            <span class="pv-setting-label">Server</span>
            <span class="pv-setting-value pv-local-status-value">
              <LocalStatus server={server()} elapsed />
            </span>
            <span class="pv-local-actions">
              <Show
                when={running() || status().state === 'stopping'}
                fallback={
                  <Button variant="secondary" class="pv-local-small" disabled={blocked()} onClick={() => startServer(config().id)}>
                    Start
                  </Button>
                }
              >
                <Button variant="secondary" class="pv-local-small" disabled={status().state === 'stopping'} onClick={() => stopServer(config().id)}>
                  Stop
                </Button>
              </Show>
              <Button variant="text" class="pv-local-small" disabled={blocked() || busy()} onClick={() => restartServer(config().id)}>
                Restart
              </Button>
            </span>
          </div>
          <Show when={status().state === 'error' && status().error}>
            <pre class="pv-local-mono-block pv-local-error type-mono" role="alert">{status().error}</pre>
          </Show>
          <Show when={status().restartRequired && running()}>
            <div class="pv-setting-row pv-local-restart-row">
              <span class="pv-setting-label" />
              <span class="pv-setting-value pv-local-muted-value">Restart to apply changes</span>
              <button type="button" class="pv-row-action" onClick={() => restartServer(config().id)}>
                Restart
              </button>
            </div>
          </Show>
        </div>
      </section>

      <div class="pv-section-divider" />

      <section class="pv-section">
        <h2 class="pv-section-heading">Settings</h2>
        <div class="pv-local-settings">
          <FieldGroups specs={basicSpecs()} values={values()} onChange={setValue} fallbackGroup="General" />

          <div class="pv-local-group">
            <h3 class="pv-local-group-heading">Server</h3>
            <div class="pv-local-field">
              <label class="pv-local-field-label" for="pv-local-port">Port</label>
              <div class="pv-local-field-value">
                <input
                  id="pv-local-port"
                  class="pv-text-input pv-local-number"
                  type="number"
                  inputmode="numeric"
                  min={1024}
                  max={65535}
                  value={port()}
                  onInput={event => {
                    const next = Number(event.currentTarget.value);
                    if (Number.isInteger(next) && next > 0) setDraft(current => ({ ...current, port: next }));
                  }}
                />
              </div>
            </div>
            <div class="pv-local-field">
              <span class="pv-local-field-label">Auto start</span>
              <div class="pv-local-field-value">
                <Toggle checked={autoStart()} label="Auto start" onChange={checked => setDraft(current => ({ ...current, autoStart: checked }))} />
                <span class="pv-local-help">Starts the server the first time a chat uses it.</span>
              </div>
            </div>
            <div class="pv-local-field">
              <label class="pv-local-field-label" for="pv-local-idle">Stop after idle</label>
              <div class="pv-local-field-value">
                <span class="pv-local-inline">
                  <input
                    id="pv-local-idle"
                    class="pv-text-input pv-local-number"
                    type="number"
                    inputmode="numeric"
                    min={0}
                    value={idleStopMinutes()}
                    onInput={event => {
                      const next = Number(event.currentTarget.value);
                      if (Number.isFinite(next) && next >= 0) setDraft(current => ({ ...current, idleStopMinutes: Math.round(next) }));
                    }}
                  />
                  <span class="pv-local-muted">minutes</span>
                </span>
                <span class="pv-local-help">0 keeps it running until you stop it or quit Unify.</span>
              </div>
            </div>
          </div>

          <Show when={advancedSpecs().length}>
            <div class="pv-local-advanced">
              <Button
                variant="text"
                class="pv-local-advanced-toggle"
                trailingIcon={advancedOpen() ? 'chevronUp' : 'chevron'}
                aria-expanded={advancedOpen()}
                onClick={() => setAdvancedOpen(!advancedOpen())}
              >
                Advanced
              </Button>
              <Collapse open={advancedOpen()}>
                <div class="pv-local-advanced-body">
                  <FieldGroups specs={advancedSpecs()} values={values()} onChange={setValue} fallbackGroup="" />
                </div>
              </Collapse>
            </div>
          </Show>

          <div class="pv-local-save-row">
            <Show when={dirty()}>
              <span class="pv-local-muted">Unsaved changes</span>
              <Button variant="text" class="pv-local-small" onClick={() => setDraft({ values: {} })}>
                Discard
              </Button>
            </Show>
            <Button variant="primary" class="pv-local-small" disabled={!dirty()} onClick={save}>
              Save
            </Button>
          </div>
        </div>
      </section>

      <div class="pv-section-divider" />

      <section class="pv-section">
        <div class="pv-local-section-head">
          <h2 class="pv-section-heading">Command</h2>
          <button type="button" class="pv-row-action" disabled={!(status().command || server().commandPreview)} onClick={() => void copyCommand()}>
            <FadeText text={copied() ? 'Copied' : 'Copy'} />
          </button>
        </div>
        <pre class="pv-local-mono-block pv-local-command type-mono">
          <Show when={status().command || server().commandPreview} fallback={<span class="pv-local-muted">Fix the problems above to build the command.</span>}>
            {status().command || server().commandPreview}
          </Show>
        </pre>
      </section>

      <section class="pv-section">
        <h2 class="pv-section-heading">Log</h2>
        <LogView serverId={config().id} />
      </section>

      <div class="pv-section-divider" />

      <section class="pv-section">
        <div class="pv-rows">
          <div class="pv-setting-row">
            <span class="pv-setting-label">Preset</span>
            <Show
              when={presetNaming()}
              fallback={
                <>
                  <span class="pv-setting-value pv-local-muted-value">Save these settings to reuse them for a new server.</span>
                  <button type="button" class="pv-row-action" onClick={() => setPresetNaming(true)}>
                    Save as preset…
                  </button>
                </>
              }
            >
              <form
                class="pv-local-inline pv-local-preset-form"
                onSubmit={event => {
                  event.preventDefault();
                  commitPreset();
                }}
              >
                <input
                  ref={element => queueMicrotask(() => element.focus())}
                  class="pv-text-input pv-local-wide"
                  placeholder="Preset name"
                  value={presetName()}
                  spellcheck={false}
                  autocomplete="off"
                  onInput={event => setPresetName(event.currentTarget.value)}
                  onKeyDown={event => {
                    if (event.key === 'Escape') setPresetNaming(false);
                  }}
                />
                <Button variant="text" class="pv-local-small" onClick={() => setPresetNaming(false)}>
                  Cancel
                </Button>
                <Button variant="primary" type="submit" class="pv-local-small" disabled={!presetName().trim()}>
                  Save
                </Button>
              </form>
            </Show>
          </div>
        </div>
      </section>
    </div>
  );
}
