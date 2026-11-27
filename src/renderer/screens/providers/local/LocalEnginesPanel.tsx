/**
 * Local provider page sections: the Engines list (one row per engine with its install and Install / Browse /
 * Detect) and the "One model at a time" switch. `EngineStatusLine` is the compact one-engine version the Add
 * provider form shows under its preset picker.
 *
 * Install progress also arrives as progressNotice messages, which the app's notice row shows; here the row only
 * says "Installing…" with the small spinner while engine.installing is true.
 */
import { For, Show, type JSX } from 'solid-js';
import { Button, Toggle } from '../../../components';
import type { LocalEngineInfo } from '../../../../engine/local/types';
import { FadeText, MiddlePath } from './FieldControl';
import {
  browseEnginePath,
  detectEngines,
  engineInstallText,
  installEngine,
  localState,
  setLocalExclusive,
} from './localStore';

/** Install / Browse… / Detect for one engine. */
function EngineActions(props: { engine: LocalEngineInfo; detect?: boolean }): JSX.Element {
  return (
    <span class="pv-local-engine-actions">
      <Show when={props.engine.installable && !props.engine.install}>
        <Button variant="secondary" class="pv-local-small" disabled={props.engine.installing} onClick={() => installEngine(props.engine.kind)}>
          Install
        </Button>
      </Show>
      <Show when={props.engine.pathKind !== 'none'}>
        <Button variant="text" class="pv-local-small" disabled={props.engine.installing} onClick={() => void browseEnginePath(props.engine)}>
          Browse…
        </Button>
      </Show>
      <Show when={props.detect !== false && props.engine.pathKind !== 'none'}>
        <Button variant="text" class="pv-local-small" disabled={props.engine.installing} onClick={detectEngines}>
          Detect
        </Button>
      </Show>
    </span>
  );
}

function InstallState(props: { engine: LocalEngineInfo }): JSX.Element {
  return (
    <span class="pv-local-install-state" classList={{ missing: !props.engine.install && props.engine.pathKind !== 'none' }}>
      <Show when={props.engine.installing}>
        <span class="pv-spinner" aria-hidden="true" />
      </Show>
      <FadeText text={engineInstallText(props.engine)} />
    </span>
  );
}

/** "llama.cpp   Installed b6123   [Browse…] [Detect]" under the Add form's preset picker. */
export function EngineStatusLine(props: { engine: LocalEngineInfo }): JSX.Element {
  return (
    <div class="pv-field pv-local-engine-line">
      <span class="pv-field-label">Engine</span>
      <span class="pv-local-engine-line-value">
        <span class="pv-local-engine-name">{props.engine.label}</span>
        <InstallState engine={props.engine} />
      </span>
      <EngineActions engine={props.engine} />
      <Show when={props.engine.install?.path}>
        {path => (
          <span class="pv-local-engine-line-path">
            <MiddlePath path={path()} />
          </span>
        )}
      </Show>
      <Show when={!props.engine.install && props.engine.detected}>
        {detected => (
          <span class="pv-local-engine-line-path">
            Found <MiddlePath path={detected().path} />
          </span>
        )}
      </Show>
    </div>
  );
}

function EngineRow(props: { engine: LocalEngineInfo }): JSX.Element {
  return (
    <div class="pv-local-engine-row">
      <div class="pv-local-engine-head">
        <span class="pv-local-engine-name">{props.engine.label}</span>
        <InstallState engine={props.engine} />
        <EngineActions engine={props.engine} />
      </div>
      <p class="pv-local-engine-description">{props.engine.description}</p>
      <Show when={props.engine.pathKind !== 'none'}>
        <p class="pv-local-engine-path">
          <span class="pv-local-engine-path-label">{props.engine.pathLabel}</span>
          <Show
            when={props.engine.install?.path}
            fallback={
              <Show when={props.engine.detected} fallback={<span class="pv-local-muted">Not set</span>}>
                {detected => (
                  <>
                    <span class="pv-local-muted">Found</span>
                    <MiddlePath path={detected().path} />
                  </>
                )}
              </Show>
            }
          >
            {path => <MiddlePath path={path()} />}
          </Show>
        </p>
      </Show>
    </div>
  );
}

export function LocalEnginesSection(): JSX.Element {
  return (
    <>
      <section class="pv-section">
        <h2 class="pv-section-heading">Engines</h2>
        <div class="pv-local-engines">
          <For each={localState.engines}>{engine => <EngineRow engine={engine} />}</For>
          <Show when={!localState.engines.length}>
            <p class="pv-section-note type-body">Loading engines…</p>
          </Show>
        </div>
      </section>

      <div class="pv-section-divider" />

      <section class="pv-section">
        <h2 class="pv-section-heading">Running</h2>
        <div class="pv-rows">
          <div class="pv-setting-row">
            <span class="pv-setting-label">One model at a time</span>
            <span class="pv-setting-value pv-local-muted-value">Starting a server stops the others. They share the GPU.</span>
            <Toggle checked={localState.exclusive} label="One model at a time" onChange={setLocalExclusive} />
          </div>
        </div>
      </section>
    </>
  );
}
