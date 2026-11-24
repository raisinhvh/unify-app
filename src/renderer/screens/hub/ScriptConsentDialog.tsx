/**
 * Hub › install script consent. Shown when the engine answers `hubInstall` with `needsScriptConsent`: the programs
 * the pack's setup installs (each with its exact winget/brew/pip command), the pack's install script in full and its
 * uninstall script (run when the pack is removed), then Cancel or "Run script and install" / "Install" (resends with `allowScript: true`).
 *
 * Same frame as Providers › Add provider: a centered dialog over a 72% scrim, Presence pop from 0.96.
 */
import { createEffect, For, onCleanup, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Button, IconButton } from '../../components';
import { Presence } from '../../motion';
import { cancelScriptConsent, hubState, runScriptAndInstall, scriptConsent } from './hubAdapter';

export function ScriptConsentDialog(): JSX.Element {
  // Kept through the exit animation, after the adapter has cleared the consent.
  let last = scriptConsent();
  const shown = () => {
    const current = scriptConsent();
    if (current) last = current;
    return last;
  };
  const hasScript = () => !!shown()?.scriptName;
  const hasUninstall = () => !!shown()?.uninstallScriptName;
  const packages = () => shown()?.packages ?? [];
  const itemCount = () => (hasScript() ? 1 : 0) + (hasUninstall() ? 1 : 0) + packages().length;
  const packName = () => hubState()?.packs.find(pack => pack.id === shown()?.id)?.name ?? shown()?.id;

  createEffect(() => {
    if (!scriptConsent()) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        cancelScriptConsent();
      }
    };
    window.addEventListener('keydown', onKey, true);
    onCleanup(() => window.removeEventListener('keydown', onKey, true));
  });

  return (
    <Portal>
      <Presence when={!!scriptConsent()} from={0.96} origin="center">
        <div
          class="hub-scrim"
          onClick={event => {
            if (event.target === event.currentTarget) cancelScriptConsent();
          }}
        >
          <div class="hub-dialog" role="dialog" aria-modal="true" aria-labelledby="hub-script-title" aria-describedby="hub-script-lede">
            <header class="hub-dialog-header">
              <h2 id="hub-script-title" class="hub-dialog-title type-heading">
                {hasScript() ? 'This pack runs an install script' : hasUninstall() ? 'This pack runs a script' : 'This pack installs programs'}
              </h2>
              <IconButton icon="close" label="Close" class="hub-dialog-close" onClick={cancelScriptConsent} />
            </header>
            <div class="hub-dialog-body">
              <p id="hub-script-lede" class="hub-script-lede">
                Installing <strong>{packName()}</strong>{' '}
                <Show when={hasScript()}>
                  runs <span class="hub-script-name type-mono">{shown()?.scriptName}</span>
                  {packages().length ? ' and ' : ' '}
                </Show>
                <Show when={packages().length}>
                  installs {packages().length === 1 ? 'this program' : 'these programs'}{' '}
                </Show>
                on this device
                <Show when={hasUninstall()}>
                  , and runs <span class="hub-script-name type-mono">{shown()?.uninstallScriptName}</span> when you remove it to clean up what it added
                </Show>
                . Read {itemCount() === 1 ? 'it' : 'them'} before you continue.
              </p>
              <Show when={packages().length}>
                <ul class="hub-packages" aria-label="Programs to install">
                  <For each={packages()}>
                    {item => (
                      <li class="hub-package">
                        <span class="hub-package-title">{item.title}</span>
                        <code class="hub-package-command type-mono">{item.command}</code>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={hasScript()}>
                <pre class="hub-script type-mono" tabindex="0" aria-label={`${shown()?.scriptName ?? 'Install script'} contents`}>
                  {shown()?.scriptText}
                </pre>
              </Show>
              <Show when={hasUninstall()}>
                <pre class="hub-script type-mono" tabindex="0" aria-label={`${shown()?.uninstallScriptName ?? 'Uninstall script'} contents`}>
                  {shown()?.uninstallScriptText}
                </pre>
              </Show>
            </div>
            <footer class="hub-dialog-footer">
              <Button variant="secondary" onClick={cancelScriptConsent}>
                Cancel
              </Button>
              <Button variant="primary" onClick={runScriptAndInstall}>
                {hasScript() ? 'Run script and install' : hasUninstall() ? 'Allow script and install' : 'Install'}
              </Button>
            </footer>
          </div>
        </div>
      </Presence>
    </Portal>
  );
}
