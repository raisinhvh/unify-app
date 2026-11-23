/**
 * Hub › install script consent. Shown when the engine answers `hubInstall` with `needsScriptConsent`: the pack's
 * install script in full, then Cancel or "Run script and install" (resends with `allowScript: true`).
 *
 * Same frame as Providers › Add provider: a centered dialog over a 72% scrim, Presence pop from 0.96.
 */
import { createEffect, onCleanup, type JSX } from 'solid-js';
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
                This pack runs an install script
              </h2>
              <IconButton icon="close" label="Close" class="hub-dialog-close" onClick={cancelScriptConsent} />
            </header>
            <div class="hub-dialog-body">
              <p id="hub-script-lede" class="hub-script-lede">
                Installing <strong>{packName()}</strong> runs <span class="hub-script-name type-mono">{shown()?.scriptName}</span> on{' '}
                {shown()?.target === 'all' ? 'each of your devices' : 'this device'}. Read it before you continue.
              </p>
              <pre class="hub-script type-mono" tabindex="0" aria-label={`${shown()?.scriptName ?? 'Install script'} contents`}>
                {shown()?.scriptText}
              </pre>
            </div>
            <footer class="hub-dialog-footer">
              <Button variant="secondary" onClick={cancelScriptConsent}>
                Cancel
              </Button>
              <Button variant="primary" onClick={runScriptAndInstall}>
                Run script and install
              </Button>
            </footer>
          </div>
        </div>
      </Presence>
    </Portal>
  );
}
