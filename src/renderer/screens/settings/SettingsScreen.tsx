/**
 * Settings (Figma 25 Settings 306:4645, 25b Themes 306:12078), extended to every option that exists.
 *
 *   nav         "Settings", a search field (Ctrl F) and one row per section; the highlight slides between rows
 *   page        one section at a time: title, lede, then flat rows with hairlines (file-system look, no pills)
 *   search      while the field has text, a results page lists matching rows from every section, plus links to
 *               hand-drawn sections whose keywords match ("walnut" → Appearance)
 *
 * Rows are generated from catalog.ts (featureDefinitions plus the engine's own settings); Appearance, Agents,
 * Power, Accounts, Sync and About add hand-drawn parts. Every change is posted at once and shows as soon as the engine echoes it.
 *
 * Two ways to mount it:
 *   <SettingsScreen />               nav inside the content card (default)
 *   <SettingsPanel /> + <SettingsScreen nav={false} />   nav in the Shell's side-panel slot, as in Figma
 * Both share the section and query signals below.
 */
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { post } from '../../bridge';
import { Button, Icon, IconButton, ProviderGlyph, Toggle } from '../../components';
import { Collapse, createSpring, pressable } from '../../motion';
import { readPersisted, writePersisted } from '../../persist';
import { navigate } from '../../router';
import { viewState } from '../../store';
import { providerNames } from '../../store/providers';
import { relativeAge } from '../chats/projects';
import { appInfo, canCheckForUpdates, checkForUpdates, installUpdate, requestAppInfo } from './adapters';
import { rowMatches, rowsIn, sectionById, sectionMatches, sections, settingRows, type SectionId } from './catalog';
import { PageStack } from './PageStack';
import { SettingRows } from './SettingControls';
import { ThemeList } from './ThemePicker';
import './settings.css';

/* Shared state (nav and page may live in different parents). */

const sectionIds = sections.map(section => section.id);

function validSection(value: unknown): SectionId {
  return sectionIds.includes(value as SectionId) ? (value as SectionId) : 'appearance';
}

const [activeSection, setActiveSectionSignal] = createSignal<SectionId>(validSection(readPersisted('settingsSection', 'appearance')));
const [query, setQuery] = createSignal('');

export { activeSection };

export function openSettingsSection(id: SectionId): void {
  setQuery('');
  setActiveSectionSignal(id);
  writePersisted('settingsSection', id);
}

const searching = () => query().trim().length > 0;

function matchingRows() {
  return searching() ? settingRows.filter(row => rowMatches(row, query())) : [];
}

/** Hand-drawn sections whose title or keywords match (shown as links on the results page). */
function matchingSections() {
  if (!searching()) return [];
  const rows = matchingRows();
  return sections.filter(section => sectionMatches(section, query()) && !rows.some(row => row.section === section.id));
}

function sectionHasMatch(id: SectionId): boolean {
  return matchingRows().some(row => row.section === id) || matchingSections().some(section => section.id === id);
}

const searchInputs = new Set<HTMLInputElement>();

function focusSearch(): void {
  const input = [...searchInputs].find(item => item.offsetParent !== null) ?? [...searchInputs][0];
  input?.focus();
  input?.select();
}

/* Nav */

const navRowPitch = 34;

function SettingsNav(): JSX.Element {
  const index = () => sectionIds.indexOf(activeSection());
  const highlightTop = createSpring(() => index() * navRowPitch, 'indicator', { precision: 100 });
  const highlightOpacity = createSpring(() => (searching() ? 0 : 1), 'panel', { fadeOnly: true });

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        focusSearch();
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  return (
    <nav class="settings-nav" aria-label="Settings sections">
      <header class="settings-nav-header">
        <h2 class="type-heading">Settings</h2>
      </header>
      <label class="settings-search">
        <Icon name="search" size={14} />
        <input
          ref={element => {
            searchInputs.add(element);
            onCleanup(() => searchInputs.delete(element));
          }}
          type="search"
          placeholder="Search settings"
          value={query()}
          onInput={event => setQuery(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              setQuery('');
              event.currentTarget.blur();
            }
          }}
        />
        <Show when={searching()} fallback={<kbd class="type-caption">Ctrl F</kbd>}>
          <IconButton icon="close" label="Clear search" size="small" onClick={() => setQuery('')} />
        </Show>
      </label>
      <div class="settings-nav-list">
        <div
          class="settings-nav-highlight"
          style={{
            transform: `translate3d(0, ${highlightTop()}px, 0)`,
            opacity: Math.max(0, Math.min(1, highlightOpacity())),
          }}
        />
        <For each={sections}>
          {section => (
            <button
              type="button"
              class="settings-nav-row"
              classList={{
                active: !searching() && activeSection() === section.id,
                dim: searching() && !sectionHasMatch(section.id),
              }}
              aria-current={!searching() && activeSection() === section.id ? 'page' : undefined}
              ref={element => pressable(element, 0.98)}
              onClick={() => openSettingsSection(section.id)}
            >
              {section.title}
            </button>
          )}
        </For>
      </div>
    </nav>
  );
}

/** The nav as the Shell's side panel (Figma 25 puts it there). */
export function SettingsPanel(): JSX.Element {
  return (
    <aside class="side-panel settings-panel" aria-label="Settings">
      <SettingsNav />
    </aside>
  );
}

/* Pages */

function PageHeader(props: { title: string; lede: string }): JSX.Element {
  return (
    <header class="settings-page-header">
      <h1 class="type-title">{props.title}</h1>
      <p class="settings-lede">{props.lede}</p>
    </header>
  );
}

function SectionHead(props: { title: string; children?: JSX.Element }): JSX.Element {
  return (
    <div class="settings-section-head">
      <h2 class="type-heading">{props.title}</h2>
      <Show when={props.children}>
        <div class="settings-section-actions">{props.children}</div>
      </Show>
    </div>
  );
}

/** A flat info row (label + caption on the left, anything on the right), same rhythm as setting rows. */
function InfoRow(props: { label: JSX.Element; caption?: JSX.Element; leading?: JSX.Element; children?: JSX.Element }): JSX.Element {
  return (
    <div class="setting-row">
      <Show when={props.leading}>
        <div class="setting-row-leading">{props.leading}</div>
      </Show>
      <div class="setting-row-text">
        <div class="setting-row-label">{props.label}</div>
        <Show when={props.caption}>
          <div class="setting-row-description type-caption">{props.caption}</div>
        </Show>
      </div>
      <div class="setting-row-control">{props.children}</div>
    </div>
  );
}

function AppearancePage(): JSX.Element {
  return (
    <>
      <SectionHead title="Theme" />
      <ThemeList />
      <div class="settings-gap" />
      <SettingRows rows={rowsIn('appearance')} />
      <p class="settings-note type-caption">The interface font is Space Mono everywhere; code uses the editor font.</p>
    </>
  );
}

function AccountsPage(): JSX.Element {
  const accounts = () => viewState.accounts ?? [];
  const signedOut = (accountId: string) => {
    const usage = viewState.usage[accountId];
    return usage?.status === 'error' && usage.fix === 'signin';
  };
  return (
    <>
      <SectionHead title="Accounts">
        <Button variant="text" icon="refresh" onClick={() => post({ type: 'refreshAccounts' })}>Refresh</Button>
        <Button variant="text" onClick={() => navigate('providers')}>Open Providers</Button>
      </SectionHead>
      <For each={accounts()} fallback={<p class="settings-empty type-caption">No accounts yet. Add one in Providers.</p>}>
        {account => (
          <InfoRow
            leading={<ProviderGlyph provider={account.provider} size={16} />}
            label={account.label}
            caption={
              <span class="setting-caption-parts">
                <span>{providerNames[account.provider] ?? account.provider}</span>
                <Show when={account.email}>
                  <span class="setting-caption-muted">{account.email}</span>
                </Show>
                <Show when={account.isDefault}>
                  <span class="setting-caption-muted">Default</span>
                </Show>
              </span>
            }
          >
            <Show when={signedOut(account.id)} fallback={<span class="settings-status type-caption">Signed in</span>}>
              <span class="settings-status warn type-caption">Signed out</span>
              <Button variant="text" onClick={() => post({ type: 'reauthAccount', accountId: account.id })}>Sign in</Button>
            </Show>
          </InfoRow>
        )}
      </For>
      <InfoRow
        leading={<ProviderGlyph provider="cursor-acp" size={16} />}
        label="Cursor"
        caption={viewState.cursor?.label || 'Not connected'}
      >
        <Show when={!viewState.cursor?.connected} fallback={<span class="settings-status type-caption">Connected</span>}>
          <Button variant="text" disabled={!!viewState.cursor?.busy} onClick={() => post({ type: 'cursorLogin' })}>Sign in</Button>
        </Show>
      </InfoRow>
      <p class="settings-note type-caption">Add, remove and set default accounts in Providers.</p>
    </>
  );
}

/** GitHub sign-in (viewState.github): the GitHub CLI's login, or a pasted personal access token. */
function GitHubAccount(): JSX.Element {
  const github = () => viewState.github;
  const signedIn = () => !!github()?.signedIn;
  const [token, setToken] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [checking, setChecking] = createSignal(false);
  // Any new state from the engine ends a save or a CLI check.
  createEffect(on(() => [github()?.signedIn, github()?.login, github()?.error, github()?.source], () => {
    setSaving(false);
    setChecking(false);
  }, { defer: true }));
  const saveToken = () => {
    const value = token().trim();
    if (!value || saving()) return;
    setSaving(true);
    post({ type: 'githubSetToken', token: value });
    setToken('');
  };
  const sourceCaption = () => (github()?.source === 'token' ? 'From a pasted token' : 'From the GitHub CLI');
  return (
    <>
      <SectionHead title="GitHub account" />
      <InfoRow
        label={signedIn() ? <>Signed in as <span class="settings-strong">{github()?.login ?? 'GitHub'}</span></> : 'Not signed in'}
        caption={signedIn() ? sourceCaption() : 'Sign in with the GitHub CLI, or paste a personal access token.'}
      >
        <Show
          when={signedIn()}
          fallback={
            <Button
              variant="text"
              icon="refresh"
              disabled={checking()}
              onClick={() => {
                setChecking(true);
                post({ type: 'githubRefresh' });
              }}
            >
              {checking() ? 'Checking…' : 'Check GitHub CLI again'}
            </Button>
          }
        >
          <Show when={github()?.source === 'token'}>
            <Button variant="text" onClick={() => post({ type: 'githubSignOut' })}>Sign out</Button>
          </Show>
        </Show>
      </InfoRow>
      <Collapse open={!signedIn()}>
        <div class="setting-row github-token-row">
          <div class="setting-row-text">
            <label class="settings-field">
              <input
                type="password"
                placeholder="Paste a personal access token"
                autocomplete="off"
                spellcheck={false}
                value={token()}
                onInput={event => setToken(event.currentTarget.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') saveToken();
                }}
              />
            </label>
            <div class="setting-row-description type-caption">Create a classic token with the repo and read:user scopes.</div>
          </div>
          <div class="setting-row-control">
            <Button variant="secondary" disabled={!token().trim() || saving()} onClick={saveToken}>
              {saving() ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </Collapse>
      <Collapse open={!!github()?.error}>
        <p class="settings-calm-error type-caption">{github()?.error}</p>
      </Collapse>
    </>
  );
}

function SyncPage(): JSX.Element {
  const sync = () => viewState.sync;
  const busyLabel: Record<string, string> = {
    connecting: 'Connecting…',
    uploading: 'Uploading…',
    downloading: 'Downloading…',
    checking: 'Checking…',
  };
  const status = () => {
    const current = sync();
    if (!current?.connected) return 'Not connected';
    if (current.busy) return busyLabel[current.busy];
    return current.lastSync ? `Last synced ${relativeAge(current.lastSync)}` : 'Not synced yet';
  };
  return (
    <>
      <GitHubAccount />
      <div class="settings-gap" />
      <SectionHead title="Backup" />
      <InfoRow
        label={sync()?.connected ? sync()!.account ?? 'Connected' : 'Backup repository'}
        caption={sync()?.connected ? sync()!.repo ?? status() : 'Connect to create a private backup repository on GitHub.'}
      >
        <Show
          when={sync()?.connected}
          fallback={
            <Button variant="text" disabled={!!sync()?.busy} onClick={() => post({ type: 'syncAction', action: 'connect' })}>Connect</Button>
          }
        >
          <Button variant="text" onClick={() => post({ type: 'syncAction', action: 'openRepo' })}>Open</Button>
          <Button variant="text" onClick={() => post({ type: 'syncAction', action: 'disconnect' })}>Disconnect</Button>
        </Show>
      </InfoRow>
      <Collapse open={!!sync()?.connected}>
        <InfoRow label="Sync now" caption={status()}>
          <Button variant="text" icon="upload" disabled={!!sync()?.busy} onClick={() => post({ type: 'syncAction', action: 'upload' })}>Upload</Button>
          <Button variant="text" disabled={!!sync()?.busy} onClick={() => post({ type: 'syncAction', action: 'download' })}>Download</Button>
        </InfoRow>
        <InfoRow label="Sync automatically" caption="Uploads after changes and downloads when Unify starts.">
          <Toggle checked={!!sync()?.auto} label="Sync automatically" onChange={enabled => post({ type: 'setSyncAuto', enabled })} />
        </InfoRow>
      </Collapse>
      <Collapse open={!!sync()?.conflict}>
        <InfoRow
          label={<span class="warn">Changed in both places</span>}
          caption={sync()?.conflict?.length ? sync()!.conflict!.join(', ') : 'Your whole configuration'}
        >
          <Button variant="text" onClick={() => post({ type: 'syncAction', action: 'keepRemote' })}>Keep GitHub's</Button>
          <Button variant="text" onClick={() => post({ type: 'syncAction', action: 'keepLocal' })}>Keep this PC's</Button>
        </InfoRow>
      </Collapse>
      <Collapse open={!!sync()?.error}>
        <p class="settings-error type-caption">{sync()?.error}</p>
      </Collapse>
    </>
  );
}

function updateCaption(): string {
  const update = appInfo()?.update;
  if (!update) return 'Unknown until the engine reports it.';
  switch (update.state) {
    case 'idle':
      return 'Not checked yet.';
    case 'checking':
      return 'Checking…';
    case 'current':
      return `Up to date, checked ${relativeAge(update.checkedAt)}`;
    case 'available':
      return `Version ${update.version} is available.`;
    case 'downloading':
      return `Downloading ${update.version}, ${Math.round(update.progress * 100)}%`;
    case 'ready':
      return `Version ${update.version} is ready. Restart to install.`;
    case 'error':
      return update.message;
  }
}

function AboutPage(): JSX.Element {
  onMount(requestAppInfo);
  const update = () => appInfo()?.update;
  return (
    <>
      <SectionHead title="Unify" />
      <InfoRow label="Version" caption={appInfo() ? `${appInfo()!.channel} channel` : 'Waiting for the engine'}>
        <span class="settings-value type-mono">{appInfo()?.version ?? '—'}</span>
      </InfoRow>
      <InfoRow label="Updates" caption={updateCaption()}>
        <Show
          when={update()?.state === 'available' || update()?.state === 'ready'}
          fallback={
            <Show when={canCheckForUpdates()}>
              <Button variant="text" icon="refresh" disabled={update()?.state === 'checking' || update()?.state === 'downloading'} onClick={checkForUpdates}>
                Check for updates
              </Button>
            </Show>
          }
        >
          <Button variant="text" onClick={installUpdate}>{update()?.state === 'ready' ? 'Restart' : 'Install'}</Button>
        </Show>
      </InfoRow>
      <SettingRows rows={rowsIn('about')} />
      <InfoRow label="Data folder" caption="Settings, rules and memory.">
        <span class="settings-value type-mono" title={appInfo()?.dataFolder}>~/.unify</span>
      </InfoRow>
      <div class="settings-gap" />
      <SectionHead title="Setup" />
      <InfoRow label="Run setup again" caption="Providers, project folder, tools and extras. Nothing is lost.">
        <Button variant="text" onClick={() => navigate('setup')}>Open setup</Button>
      </InfoRow>
    </>
  );
}

/* Agents: what is left here is how chat agents run; everything about subagents and helper models is on the Agents screen. */

function AgentsPage(): JSX.Element {
  return (
    <>
      <SettingRows rows={rowsIn('agents')} />
      <button
        type="button"
        class="setting-row setting-link"
        ref={element => pressable(element, 0.99)}
        onClick={() => navigate('agents')}
      >
        <div class="setting-row-text">
          <div class="setting-row-label">Subagents and helper models</div>
          <div class="setting-row-description type-caption">Profiles, the explorer, chat names, review, summaries, Smart Auto and agent messaging.</div>
        </div>
        <Icon name="chevronRight" class="setting-link-icon" />
      </button>
    </>
  );
}

interface ShutdownStatus {
  label: string;
  caption: string;
  warn?: boolean;
}

function shutdownStatus(): ShutdownStatus | undefined {
  const shutdown = viewState.shutdown;
  if (!shutdown) return undefined;
  // The store writes 'armed' / 'idle' / 'failed'; a reload starts from the engine's own phases
  // ('waiting', 'settling', 'shuttingDown', 'disarmed'), so anything armed that is not counting down is waiting.
  switch (shutdown.phase) {
    case 'countdown':
      return { label: `Shutting down in ${shutdown.secondsLeft ?? 0} s`, caption: 'Every chat and subagent is idle.', warn: true };
    case 'shuttingDown':
      return { label: 'Shutting down', caption: 'Saving chats, then turning the PC off.', warn: true };
    case 'failed':
      return { label: 'The shutdown did not go through', caption: 'The system refused it. Turn the switch on again to retry.', warn: true };
    default:
      return shutdown.armed ? { label: 'Armed', caption: 'Waiting for every chat and subagent to finish.' } : undefined;
  }
}

function PowerPage(): JSX.Element {
  // While it only waits, the switch above disarms; a countdown gets its own Cancel.
  const cancellable = () => viewState.shutdown?.phase === 'countdown';
  return (
    <>
      <SettingRows rows={rowsIn('power')} />
      <Collapse open={!!shutdownStatus()}>
        <InfoRow label={<span classList={{ warn: !!shutdownStatus()?.warn }}>{shutdownStatus()?.label}</span>} caption={shutdownStatus()?.caption}>
          <Show when={cancellable()}>
            <Button variant="text" onClick={() => post({ type: 'cancelShutdown' })}>Cancel shutdown</Button>
          </Show>
        </InfoRow>
      </Collapse>
    </>
  );
}

function GeneratedPage(props: { id: SectionId }): JSX.Element {
  return <SettingRows rows={rowsIn(props.id)} />;
}

function SectionPage(props: { id: SectionId }): JSX.Element {
  const info = sectionById[props.id];
  const body = (): JSX.Element => {
    switch (props.id) {
      case 'appearance':
        return <AppearancePage />;
      case 'agents':
        return <AgentsPage />;
      case 'power':
        return <PowerPage />;
      case 'accounts':
        return <AccountsPage />;
      case 'sync':
        return <SyncPage />;
      case 'about':
        return <AboutPage />;
      default:
        return <GeneratedPage id={props.id} />;
    }
  };
  return (
    <div class="settings-page-column">
      <PageHeader title={info.title} lede={info.lede} />
      {body()}
    </div>
  );
}

function SearchPage(): JSX.Element {
  const groups = createMemo(() =>
    sections
      .map(section => ({ section, rows: matchingRows().filter(row => row.section === section.id) }))
      .filter(group => group.rows.length > 0),
  );
  const total = () => matchingRows().length + matchingSections().length;
  return (
    <div class="settings-page-column">
      <PageHeader
        title="Search"
        lede={total() ? `${total()} ${total() === 1 ? 'match' : 'matches'} for “${query().trim()}”` : `Nothing matches “${query().trim()}”.`}
      />
      <For each={groups()}>
        {group => (
          <section class="settings-search-group">
            <SectionHead title={group.section.title}>
              <Button variant="text" trailingIcon="chevronRight" onClick={() => openSettingsSection(group.section.id)}>Open</Button>
            </SectionHead>
            <SettingRows rows={group.rows} />
          </section>
        )}
      </For>
      <Show when={matchingSections().length > 0}>
        <section class="settings-search-group">
          <SectionHead title="Sections" />
          <For each={matchingSections()}>
            {section => (
              <button
                type="button"
                class="setting-row setting-link"
                ref={element => pressable(element, 0.99)}
                onClick={() => openSettingsSection(section.id)}
              >
                <div class="setting-row-text">
                  <div class="setting-row-label">{section.title}</div>
                  <div class="setting-row-description type-caption">{section.lede}</div>
                </div>
                <Icon name="chevronRight" class="setting-link-icon" />
              </button>
            )}
          </For>
        </section>
      </Show>
    </div>
  );
}

type PageKey = SectionId | 'search';

const pageKeys: PageKey[] = ['search', ...sectionIds];

export function SettingsScreen(props: { nav?: boolean }): JSX.Element {
  const showNav = () => props.nav ?? true;
  const activePage = (): PageKey => (searching() ? 'search' : activeSection());
  return (
    <div class="settings-screen" classList={{ 'with-nav': showNav() }}>
      <Show when={showNav()}>
        <SettingsNav />
      </Show>
      <PageStack
        class="settings-pages"
        pageClass="settings-page"
        active={activePage()}
        pages={pageKeys}
        axis="y"
        distance={24}
        render={key => (key === 'search' ? <SearchPage /> : <SectionPage id={key} />)}
      />
    </div>
  );
}
