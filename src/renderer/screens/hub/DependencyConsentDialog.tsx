/**
 * Hub › install dependencies. Shown when the engine answers `hubInstall` with `needsDependencyConsent` (after the
 * script consent, when there is one): one row per program the pack's setup installs, each with its exact
 * winget/brew/pip command. Required programs are ticked and locked; optional ones start unticked and the whole
 * row toggles them. The Python Unify adds (`PYTHON_DEPENDENCY_ID`) is required like the rest unless every pip
 * package needing it is optional; then it only appears (ticked and locked, "Needed for …") once one of those is
 * ticked. Skip cancels the whole install; Install resends with the ticked optional step ids.
 *
 * Same frame as the script consent: a centered dialog over a 72% scrim, Presence from 0.96 without overshoot.
 */
import { createEffect, createSignal, For, on, onCleanup, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { PYTHON_DEPENDENCY_ID } from '@engine/hub/types';
import { Button, IconButton } from '../../components';
import { Collapse, createSpring, Presence } from '../../motion';
import type { HubInstallPackage } from '../../protocol';
import { cancelDependencyConsent, dependencyConsent, hubState, installDependencies } from './hubAdapter';

export function DependencyConsentDialog(): JSX.Element {
  // Kept through the exit animation, after the adapter has cleared the consent.
  let last = dependencyConsent();
  const shown = () => {
    const current = dependencyConsent();
    if (current) last = current;
    return last;
  };
  const packages = () => shown()?.packages ?? [];
  const packName = () => hubState()?.packs.find(pack => pack.id === shown()?.id)?.name ?? shown()?.id;

  const [selectedOptional, setSelectedOptional] = createSignal<ReadonlySet<string>>(new Set());
  // A new consent starts with every optional program unticked.
  createEffect(on(dependencyConsent, consent => {
    if (consent) setSelectedOptional(new Set<string>());
  }));

  const isSelected = (stepId: string) => selectedOptional().has(stepId);
  const toggleOptional = (stepId: string) => {
    setSelectedOptional(current => {
      const next = new Set(current);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  };

  /** The Python Unify adds, only when every pip package needing it is optional (otherwise it is a required row). */
  const optionalPython = () => packages().find(item => item.stepId === PYTHON_DEPENDENCY_ID && item.optional);
  /** The first ticked optional program that needs that Python: while there is one, Python shows ticked. */
  const pythonNeededFor = () => {
    const python = optionalPython();
    if (!python) return undefined;
    return packages().find(item => item.optional && isSelected(item.stepId) && python.neededBy?.includes(item.stepId));
  };
  // Kept while the Python row collapses, so its tag does not change on the way out.
  let lastNeededForTitle = '';
  const pythonTag = () => {
    const neededFor = pythonNeededFor();
    // "rembg (background removal)" → "rembg": the tag sits beside the command and must stay short.
    if (neededFor) lastNeededForTitle = neededFor.title.replace(/\s*\(.*\)\s*$/, '');
    return `Needed for ${lastNeededForTitle}`;
  };

  /** The rows in order, with an optional Python moved to just above the first program that needs it. */
  const rows = () => {
    const python = optionalPython();
    const others = packages().filter(item => item !== python);
    if (!python) return others;
    const firstDependent = others.findIndex(item => python.neededBy?.includes(item.stepId));
    if (firstDependent < 0) return others;
    return [...others.slice(0, firstDependent), python, ...others.slice(firstDependent)];
  };
  const programCount = () => packages().filter(item => item !== optionalPython()).length;

  const install = () => {
    const selected = packages()
      .filter(item => item.optional && item.stepId !== PYTHON_DEPENDENCY_ID && isSelected(item.stepId))
      .map(item => item.stepId);
    if (pythonNeededFor()) selected.push(PYTHON_DEPENDENCY_ID);
    installDependencies(selected);
  };

  // Focus Install while the dialog is up, and hand focus back to whatever had it before.
  let returnFocus: HTMLElement | undefined;
  createEffect(on(() => !!dependencyConsent(), open => {
    if (open) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      return;
    }
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = undefined;
  }, { defer: true }));

  createEffect(() => {
    if (!dependencyConsent()) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        cancelDependencyConsent();
      }
    };
    window.addEventListener('keydown', onKey, true);
    onCleanup(() => window.removeEventListener('keydown', onKey, true));
  });

  return (
    <Portal>
      <Presence when={!!dependencyConsent()} from={0.96} origin="center" enter="panel">
        <div
          class="hub-scrim"
          onClick={event => {
            if (event.target === event.currentTarget) cancelDependencyConsent();
          }}
        >
          <div class="hub-dialog" role="dialog" aria-modal="true" aria-labelledby="hub-deps-title" aria-describedby="hub-deps-lede">
            <header class="hub-dialog-header">
              <h2 id="hub-deps-title" class="hub-dialog-title type-heading">
                Install dependencies
              </h2>
              <IconButton icon="close" label="Close" class="hub-dialog-close" onClick={cancelDependencyConsent} />
            </header>
            <div class="hub-dialog-body">
              <p id="hub-deps-lede" class="hub-script-lede">
                <strong>{packName()}</strong> needs {programCount() === 1 ? 'this program' : 'these programs'}.
                Unify installs {programCount() === 1 ? 'it' : 'them'} for you.
              </p>
              <ul class="hub-packages hub-deps" aria-label="Programs to install">
                <For each={rows()}>
                  {item => (
                    <Show
                      when={item === optionalPython()}
                      fallback={
                        <li class="hub-dep-item">
                          <DependencyRow
                            item={item}
                            checked={!item.optional || isSelected(item.stepId)}
                            locked={!item.optional}
                            tag={item.optional ? undefined : 'Required'}
                            onToggle={() => toggleOptional(item.stepId)}
                          />
                        </li>
                      }
                    >
                      <li class="hub-dep-slot">
                        <Collapse open={!!pythonNeededFor()}>
                          <div class="hub-dep-item">
                            <DependencyRow
                              item={item}
                              checked
                              locked
                              tag={pythonTag()}
                              onToggle={() => {}}
                            />
                          </div>
                        </Collapse>
                      </li>
                    </Show>
                  )}
                </For>
              </ul>
            </div>
            <footer class="hub-dialog-footer">
              <Button variant="secondary" onClick={cancelDependencyConsent}>
                Skip
              </Button>
              <Button
                variant="primary"
                ref={element => requestAnimationFrame(() => element.focus({ preventScroll: true }))}
                onClick={install}
              >
                Install
              </Button>
            </footer>
          </div>
        </div>
      </Presence>
    </Portal>
  );
}

interface DependencyRowProps {
  item: HubInstallPackage;
  checked: boolean;
  /** Ticked for the user: required, or the Python a ticked program needs. */
  locked: boolean;
  tag?: string;
  onToggle: () => void;
}

function DependencyRow(props: DependencyRowProps): JSX.Element {
  // The check springs in with a brief overshoot; the fill follows it, clamped.
  const tick = createSpring(() => (props.checked ? 1 : 0), 'accent');
  return (
    <label class="hub-package hub-dep" classList={{ locked: props.locked, checked: props.checked }}>
      <input
        type="checkbox"
        class="hub-dep-input"
        checked={props.checked}
        disabled={props.locked}
        onChange={() => props.onToggle()}
      />
      <span class="hub-dep-box" aria-hidden="true">
        <span class="hub-dep-fill" style={{ opacity: String(Math.max(0, Math.min(1, tick()))) }} />
        <svg class="hub-dep-check" viewBox="0 0 14 14" style={{ scale: String(Math.max(0, tick())) }}>
          <path d="M3.5 7.25 L5.9 9.5 L10.5 4.5" />
        </svg>
      </span>
      <span class="hub-dep-text">
        <span class="hub-package-title">{props.item.title}</span>
        <code class="hub-package-command type-mono">{props.item.command}</code>
      </span>
      <Show when={props.tag}>
        <span class="hub-dep-tag type-caption" title={props.tag}>
          {props.tag}
        </span>
      </Show>
    </label>
  );
}
