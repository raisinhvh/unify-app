/**
 * DEV ONLY preview of the top notice (components/Notice.tsx).
 *
 *   /dev-o4/o4-notice.html?notice=error|long|none&fixture=shell2x2&theme=walnutLight
 *       the real app (mock bridge) with the engine error notice under the title bar
 *   /dev-o4/o4-notice.html?view=tones&theme=walnutLight
 *       error / warning / info, with and without an action, stacked in a plain column
 *
 * From the console (and the motion audit's eval steps):
 *   __o4Notice.set('message')   show or replace the engine notice
 *   __o4Notice.clear()          dismiss it
 */
import type { ThemeId } from '../theme';

const params = new URLSearchParams(location.search);

const messages: Record<string, string> = {
  error: 'Claude stopped responding. The engine restarted; your draft is kept.',
  long:
    'Could not reach the Codex account service (ECONNRESET while refreshing the OAuth token). ' +
    'Requests fall back to the next account until it answers again.',
};

async function boot(): Promise<void> {
  const { installMockBridge } = await import('../dev/mockBridge');
  await installMockBridge();
  const theme = await import('../theme');
  const store = await import('../store');
  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing');
  (window as unknown as { __o4Notice: unknown }).__o4Notice = {
    set: (message: string) => store.setEngineError(message),
    clear: () => store.setEngineError(undefined),
  };

  if (params.get('view') === 'tones') {
    const [{ render }, { Notice }] = await Promise.all([import('solid-js/web'), import('../components/Notice')]);
    theme.installTheme();
    const themeName = params.get('theme');
    if (themeName) theme.setTheme(themeName as ThemeId);
    const examples = [
      { message: messages.error, tone: 'error' as const },
      { message: 'Codex is near its weekly limit (92%).', tone: 'warning' as const, action: { label: 'Switch account', run: () => undefined } },
      { message: 'A new version is ready.', tone: 'info' as const, action: { label: 'Restart', run: () => undefined } },
      { message: messages.long, tone: 'error' as const, action: { label: 'Retry', run: () => undefined } },
    ];
    render(
      () => (
        <div style={{ background: 'var(--bg)', height: '100%', padding: '16px 0', display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
          {examples.map(example => (
            <div style={{ position: 'relative', height: '40px', '--titlebar-height': '0px' }}>
              <Notice notice={example} onDismiss={() => undefined} />
            </div>
          ))}
        </div>
      ),
      root,
    );
    return;
  }

  const { startApp } = await import('../App');
  startApp(root);
  const themeName = params.get('theme');
  if (themeName) theme.setTheme(themeName as ThemeId);
  const notice = params.get('notice') ?? 'error';
  if (notice !== 'none') {
    window.setTimeout(() => store.setEngineError(messages[notice] ?? notice), 300);
  }
}

void boot();
