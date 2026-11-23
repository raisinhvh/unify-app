/**
 * Settings (Figma 25 Settings 306:4645, 25b Themes 306:12078), extended to every option that exists.
 *
 *   nav         "Settings", a search field (Ctrl F) and one row per section; the highlight slides between rows
 *   page        one section at a time: title, lede, then flat rows with hairlines (file-system look, no pills)
 *   search      while the field has text, a results page lists matching rows from every section, plus links to
 *               hand-drawn sections whose keywords match ("walnut" → Appearance)
 *
 * Rows are generated from catalog.ts (featureDefinitions plus the engine's own settings); Appearance, Accounts,
 * Sync and About add hand-drawn parts. Every change is posted at once and shows as soon as the engine echoes it.
 *
 * Two ways to mount it:
 *   <SettingsScreen />               nav inside the content card (default)
 *   <SettingsPanel /> + <SettingsScreen nav={false} />   nav in the Shell's side-panel slot, as in Figma
 * Both share the section and query signals below.
 */
import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { post } from '../../bridge';
import { Button, Icon, IconButton, Toggle } from '../../components';
import { Collapse, createSpring, pressable } from '../../motion';
import { readPersisted, writePersisted } from '../../persist';
import { navigate } from '../../router';
import { viewState } from '../../store';
import { providerColor, providerNames } from '../../store/providers';
import { relativeAge } from '../chats/projects';
import { appInfo, checkForUpdates, installUpdate, requestAppInfo } from './adapters';
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
            leading={<span class="account-swatch" style={{ background: providerColor(account.provider) }} />}
            label={account.label}
            caption={[providerNames[account.provider] ?? account.provider, account.email, account.isDefault ? 'default' : '']
              .filter(Boolean)
              .join(' · ')}
          >
            <Show when={signedOut(account.id)} fallback={<span class="settings-status type-caption">Signed in</span>}>
              <span class="settings-status warn type-caption">Signed out</span>
              <Button variant="text" onClick={() => post({ type: 'reauthAccount', accountId: account.id })}>Sign in</Button>
            </Show>
          </InfoRow>
        )}
      </For>
      <InfoRow
        leading={<span class="account-swatch" style={{ background: providerColor('cursor-acp') }} />}
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
      <SectionHead title="GitHub" />
      <InfoRow
        label={sync()?.connected ? sync()!.account ?? 'Connected' : 'GitHub'}
        caption={sync()?.connected ? sync()!.repo ?? status() : 'Connect to create a private dsh-sync repository.'}
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
      return `Up to date · checked ${relativeAge(update.checkedAt)}`;
    case 'available':
      return `Version ${update.version} is available.`;
    case 'downloading':
      return `Downloading ${update.version} · ${Math.round(update.progress * 100)}%`;
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
            <Button variant="text" icon="refresh" disabled={update()?.state === 'checking' || update()?.state === 'downloading'} onClick={checkForUpdates}>
              Check now
            </Button>
          }
        >
          <Button variant="text" onClick={installUpdate}>{update()?.state === 'ready' ? 'Restart' : 'Install'}</Button>
        </Show>
      </InfoRow>
      <SettingRows rows={rowsIn('about')} />
      <InfoRow label="Data folder" caption="Settings, rules and memory. Shared with DSH.">
        <span class="settings-value type-mono" title={appInfo()?.dataFolder}>{appInfo()?.dataFolder ?? '~/.dsh'}</span>
      </InfoRow>
      <div class="settings-gap" />
      <SectionHead title="Setup" />
      <InfoRow label="Run setup again" caption="Providers, project folder, tools and extras. Nothing is lost.">
        <Button variant="text" onClick={() => navigate('setup')}>Open setup</Button>
      </InfoRow>
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
