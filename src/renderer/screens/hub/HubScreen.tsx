/**
 * Toolpack Hub (Figma 23 · Toolpack Hub 306:3998). Reached from the Toolpacks side panel (Hub folder → category).
 *
 *   top        breadcrumb + Upload toolpack (GitHub sign-in gated), title, subtitle, search
 *   Featured   three cards (All, no search)
 *   list       "All toolpacks" + Sort (Popular / New / Name); one row per pack with its install state
 *   detail     the picked pack: description, Install (+ inline confirmation), Version / Updated, Tools
 *   dialog     a pack that ships an install script shows it before anything runs (ScriptConsentDialog)
 *
 * Exports `HubContent` for the content card (the Shell draws `ToolpacksPanel` beside it), `HubScreen` as the
 * composite, and `hubEnabled()` (feature `toolpacks.hub`) for whoever links here.
 */
import { createEffect, createMemo, createSignal, For, Match, onMount, Show, Switch, type JSX } from 'solid-js';
import { Button, Icon } from '../../components';
import { AnimatedList, Collapse, createSpring, prefersReducedMotion, pressable } from '../../motion';
import { RollingNumber } from '../../motion/organic';
import { navigate } from '../../router';
import { viewState } from '../../store';
import { ConfirmBar } from '../toolpacks/ConfirmBar';
import { installedPacks } from '../toolpacks/adapter';
import { GlyphTile } from '../toolpacks/glyphs';
import { hubCategory, selectPack, setHubCategory } from '../toolpacks/selection';
import { SetupChecklist } from '../toolpacks/SetupChecklist';
import { requestSetup, setupFor } from '../toolpacks/setup';
import { ToolpacksPanel } from '../toolpacks/ToolpacksPanel';
import {
  browseHub,
  dismissPublishStatus,
  formatAge,
  hubEnabled,
  hubState,
  installFromHub,
  installs,
  publishStatus,
  publishToHub,
  type HubPack,
} from './hubAdapter';
import { ScriptConsentDialog } from './ScriptConsentDialog';
import { Segmented } from './Segmented';
import './hub.css';

export { hubEnabled } from './hubAdapter';

type Sort = 'popular' | 'new' | 'name';

// Screen state lives at module scope so leaving and coming back keeps the search, sort and picked pack.
const [query, setQuery] = createSignal('');
const [sort, setSort] = createSignal<Sort>('popular');
const [pickedId, setPickedId] = createSignal<string>();
const [confirmId, setConfirmId] = createSignal<string>();

// A pack that needs installing on this PC is not installed here, so Install shows again.
const isInstalled = (id: string) => installedPacks().some(pack => pack.id === id && !pack.needsInstall);

function categoryLabel(id: string): string {
  if (id === 'all') return 'All';
  return hubState()?.categories.find(category => category.id === id)?.label ?? id;
}

function askInstall(pack: HubPack): void {
  setPickedId(pack.id);
  setConfirmId(pack.id);
}

// ---------------------------------------------------------------------------------------------------------------
// Pieces

function Meta(props: { pack: HubPack; author?: boolean }): JSX.Element {
  return (
    <span class="hub-meta type-caption">
      <Show when={props.author !== false}>
        <span>{props.pack.author}</span>
      </Show>
      <span>{props.pack.tools.length} tools</span>
    </span>
  );
}

/** Install button, "Installed", or "Installing 62%" with a thin progress line (Panel spring on the width). */
function InstallState(props: { pack: HubPack; compact?: boolean }): JSX.Element {
  const progress = () => installs()[props.pack.id];
  const fill = createSpring(() => (progress()?.percent ?? 0) / 100, 'panel', { precision: 1 });
  return (
    <Switch
      fallback={
        <Button variant="secondary" class="hub-install" onClick={() => askInstall(props.pack)}>
          Install
        </Button>
      }
    >
      <Match when={isInstalled(props.pack.id)}>
        <span class="hub-installed type-label">
          <Icon name="check" size={14} />
          Installed
        </span>
      </Match>
      <Match when={progress()?.state === 'error'}>
        <span class="hub-failed type-label" title={progress()?.error}>
          Failed
          <Button variant="text" class="hub-retry" onClick={() => installFromHub(props.pack.id)}>Retry</Button>
        </span>
      </Match>
      <Match when={progress()}>
        <span class="hub-installing type-label">
          Installing{' '}
          <span class="hub-percent">
            <RollingNumber value={`${Math.round(progress()!.percent)}%`} data-motion="hub-install-percent" />
          </span>
          <span class="hub-progress" aria-hidden="true">
            <span class="hub-progress-fill" style={{ transform: `scaleX(${fill()})` }} />
          </span>
        </span>
      </Match>
    </Switch>
  );
}

function FeaturedCard(props: { pack: HubPack }): JSX.Element {
  return (
    <div class="hub-card" classList={{ picked: pickedId() === props.pack.id }}>
      <button type="button" class="hub-card-main" ref={element => pressable(element, 0.99)} onClick={() => setPickedId(props.pack.id)}>
        <GlyphTile name={props.pack.icon} size={40} />
        <span class="hub-card-text">
          <span class="hub-card-name type-heading">{props.pack.name}</span>
          <span class="hub-card-description">{props.pack.description}</span>
          <Meta pack={props.pack} />
        </span>
      </button>
      <div class="hub-card-action">
        <InstallState pack={props.pack} />
      </div>
    </div>
  );
}

function PackRow(props: { pack: HubPack }): JSX.Element {
  return (
    <div class="hub-row" classList={{ picked: pickedId() === props.pack.id }}>
      <button type="button" class="hub-row-main" ref={element => pressable(element, 0.995)} onClick={() => setPickedId(props.pack.id)}>
        <GlyphTile name={props.pack.icon} size={32} />
        <span class="hub-row-text">
          <span class="hub-row-title">
            <span class="hub-row-name">{props.pack.name}</span>
            <Meta pack={props.pack} />
          </span>
          <span class="hub-row-description" title={props.pack.description}>{props.pack.description}</span>
        </span>
      </button>
      <div class="hub-row-action">
        <InstallState pack={props.pack} />
      </div>
    </div>
  );
}

function Detail(props: { pack: HubPack }): JSX.Element {
  const [allTools, setAllTools] = createSignal(false);
  const shownTools = () => (allTools() ? props.pack.tools : props.pack.tools.slice(0, 5));
  const category = () => categoryLabel(props.pack.category);
  const installed = () => isInstalled(props.pack.id);
  const busy = () => !!installs()[props.pack.id] && installs()[props.pack.id].state !== 'error';
  // Picking another pack swaps the column; the new one settles in instead of snapping.
  const [shown, setShown] = createSignal(0);
  onMount(() => setShown(1));
  const enter = createSpring(shown, 'reveal', { fadeOnly: true });
  // An installed pack's checklist: arrives with the install result, or is asked for when the detail opens.
  createEffect(() => {
    if (installed() && !setupFor(props.pack.id)) requestSetup(props.pack.id);
  });
  return (
    <div
      class="hub-detail-body"
      style={{
        opacity: enter(),
        transform: enter() < 1 && !prefersReducedMotion() ? `translateY(${(1 - enter()) * 6}px)` : undefined,
      }}
    >
      <div class="hub-detail-head">
        <GlyphTile name={props.pack.icon} size={40} />
        <div class="hub-detail-heading">
          <h2 class="type-title hub-detail-title">{props.pack.name}</h2>
          <span class="hub-meta type-caption">
            <span>{props.pack.author}</span>
            <span>{category()}</span>
          </span>
        </div>
      </div>
      <p class="hub-detail-description">{props.pack.description}</p>

      <Switch>
        <Match when={installed()}>
          <Button
            variant="secondary"
            class="hub-detail-install"
            icon="toolpacks"
            onClick={() => {
              selectPack(props.pack.id);
              navigate('toolpacks');
            }}
          >
            Open in Toolpacks
          </Button>
        </Match>
        <Match when={busy()}>
          <div class="hub-detail-progress">
            <InstallState pack={props.pack} />
          </div>
        </Match>
        <Match when={true}>
          <Button
            variant="primary"
            class="hub-detail-install"
            disabled={confirmId() === props.pack.id}
            onClick={() => setConfirmId(props.pack.id)}
          >
            Install
          </Button>
        </Match>
      </Switch>
      <ConfirmBar
        open={confirmId() === props.pack.id && !installed()}
        message={<>Install <strong>{props.pack.name}</strong> on this device?</>}
        action="Install"
        onCancel={() => setConfirmId(undefined)}
        onConfirm={() => {
          setConfirmId(undefined);
          installFromHub(props.pack.id);
        }}
      />
      <Show when={installed()}>
        <SetupChecklist id={props.pack.id} />
      </Show>

      <div class="hub-facts">
        <div class="hub-fact"><span>Version</span><span>{props.pack.version}</span></div>
        <div class="hub-fact"><span>Updated</span><span>{formatAge(props.pack.updatedAt)}</span></div>
      </div>

      <div class="hub-tools">
        <h3 class="hub-tools-title type-label">
          Tools <span class="hub-count">{props.pack.tools.length}</span>
        </h3>
        <For each={shownTools()}>{tool => <span class="hub-tool type-mono" title={tool}>{tool}</span>}</For>
        <Show when={props.pack.tools.length > 5}>
          <button type="button" class="hub-more type-caption" ref={element => pressable(element, 0.96)} onClick={() => setAllTools(!allTools())}>
            {allTools() ? 'Fewer' : `${props.pack.tools.length - 5} more`}
          </button>
        </Show>
      </div>
    </div>
  );
}

/** Upload toolpack: needs GitHub. Publishing answers show here, calmly, never as a Hub error. */
function PublishArea(): JSX.Element {
  const github = () => viewState.github;
  return (
    <div class="hub-publish">
      <Show
        when={github()?.signedIn}
        fallback={
          <button type="button" class="hub-signin type-label" ref={element => pressable(element, 0.97)} onClick={() => navigate('settings')}>
            Sign in to GitHub in Settings to publish
          </button>
        }
      >
        <Show when={publishStatus().message}>
          <span class="hub-publish-message type-label" classList={{ ok: !!publishStatus().ok }}>
            {publishStatus().message}
          </span>
          <Show when={publishStatus().url}>
            <a class="hub-publish-link type-label" href={publishStatus().url} target="_blank" rel="noreferrer">View</a>
          </Show>
        </Show>
        <Button
          variant="secondary"
          icon="upload"
          class="hub-upload"
          disabled={publishStatus().pending}
          title={github()?.login ? `Publish as ${github()!.login}` : undefined}
          onClick={() => {
            dismissPublishStatus();
            publishToHub();
          }}
        >
          {publishStatus().pending ? 'Checking…' : 'Upload toolpack'}
        </Button>
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Screen

function Hub(): JSX.Element {
  const hub = () => hubState();
  const text = () => query().trim().toLowerCase();

  const visible = createMemo(() => {
    const current = hub();
    if (!current) return [];
    const category = hubCategory();
    const search = text();
    const list = current.packs.filter(pack => {
      if (category !== 'all' && pack.category !== category) return false;
      if (!search) return true;
      return [pack.name, pack.author, pack.description, ...pack.tools].some(part => part.toLowerCase().includes(search));
    });
    const order = sort();
    return [...list].sort((a, b) =>
      order === 'name' ? a.name.localeCompare(b.name) : order === 'new' ? b.publishedAt - a.publishedAt : b.installs - a.installs,
    );
  });

  const featured = createMemo(() => {
    const current = hub();
    if (!current) return [];
    return current.featured.map(id => current.packs.find(pack => pack.id === id)).filter((pack): pack is HubPack => !!pack);
  });
  const showFeatured = () => hubCategory() === 'all' && !text() && featured().length > 0;

  const picked = createMemo(() => {
    const current = hub();
    if (!current) return undefined;
    return current.packs.find(pack => pack.id === pickedId()) ?? visible()[0];
  });

  // A category with nothing left picked moves the detail to its first pack.
  createEffect(() => {
    const list = visible();
    if (list.length && !list.some(pack => pack.id === pickedId()) && !featured().some(pack => pack.id === pickedId())) {
      setPickedId(list[0].id);
    }
  });

  return (
    <div class="hub">
      <header class="hub-top">
        <div class="hub-crumbs-row">
          <nav class="hub-crumbs type-label" aria-label="Location">
            <button type="button" class="hub-crumb-link" onClick={() => navigate('toolpacks')}>Toolpacks</button>
            <span class="hub-crumb-sep">/</span>
            <button type="button" class="hub-crumb-link" onClick={() => setHubCategory('all')}>Toolpack Hub</button>
            <span class="hub-crumb-sep">/</span>
            <span class="hub-crumb-current">{categoryLabel(hubCategory())}</span>
          </nav>
          <PublishArea />
        </div>
        <h1 class="type-title hub-title">Toolpack Hub</h1>
        <p class="hub-subtitle">
          Tool bundles that let agents work in other apps.
          <Show when={hub()}>
            {' '}{hub()!.packs.length} packs from {hub()!.authors} authors.
          </Show>
        </p>
        <div class="hub-search-row">
          <label class="hub-search">
            <Icon name="search" size={14} />
            <input
              type="search"
              placeholder={hub() ? `Search ${hub()!.packs.length} toolpacks` : 'Search toolpacks'}
              value={query()}
              onInput={event => setQuery(event.currentTarget.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') setQuery('');
              }}
            />
          </label>
        </div>
        <Collapse open={showFeatured()}>
          <div class="hub-featured">
            <h2 class="hub-section-label type-label">Featured</h2>
            <div class="hub-cards">
              <For each={featured()}>{pack => <FeaturedCard pack={pack} />}</For>
            </div>
          </div>
        </Collapse>
      </header>

      <div class="hub-split">
        <section class="hub-list" aria-label="Toolpacks">
          <div class="hub-list-header">
            <h2 class="type-heading hub-list-title">
              {hubCategory() === 'all' ? 'All toolpacks' : categoryLabel(hubCategory())}
            </h2>
            <span class="hub-count type-caption">
              <RollingNumber value={visible().length} data-motion="hub-count" />
            </span>
            <span class="hub-spacer" />
            <span class="hub-sort-label type-label">Sort</span>
            <Segmented<Sort>
              label="Sort"
              class="hub-sort"
              value={sort()}
              onChange={setSort}
              options={[
                { value: 'popular', label: 'Popular' },
                { value: 'new', label: 'New' },
                { value: 'name', label: 'Name' },
              ]}
            />
          </div>
          <AnimatedList each={visible()} key={pack => pack.id} class="hub-rows">
            {pack => <PackRow pack={pack()} />}
          </AnimatedList>
          <Show when={!visible().length}>
            <p class="hub-empty-list type-label">{text() ? `Nothing matches “${query().trim()}”.` : 'No toolpacks in this category yet.'}</p>
          </Show>
        </section>
        <aside class="hub-detail" aria-label="Toolpack details">
          <Show when={picked()?.id} keyed>
            {(_id: string) => <Detail pack={picked()!} />}
          </Show>
        </aside>
      </div>
    </div>
  );
}

/** The content card: the Hub, or a calm state while it loads or cannot be reached. */
export function HubContent(): JSX.Element {
  const [waited, setWaited] = createSignal(false);
  onMount(() => {
    if (hubEnabled()) browseHub();
    window.setTimeout(() => setWaited(true), 6000);
  });
  return (
    <main class="hub-main">
      <Switch>
        <Match when={!hubEnabled()}>
          <div class="hub-state">
            <h1 class="type-title">The Hub is off</h1>
            <p class="hub-subtitle">Turn on Toolpack Hub in Settings to browse and install shared toolpacks.</p>
            <div class="hub-state-actions">
              <Button variant="secondary" onClick={() => navigate('settings')}>Open Settings</Button>
            </div>
          </div>
        </Match>
        <Match when={hubState()?.error && !hubState()?.packs.length}>
          <div class="hub-state">
            <h1 class="type-title">Hub unavailable</h1>
            <p class="hub-subtitle">{hubState()!.error}</p>
            <div class="hub-state-actions">
              <Button variant="secondary" icon="refresh" onClick={() => browseHub(true)}>Try again</Button>
            </div>
          </div>
        </Match>
        <Match when={hubState()}>
          <Hub />
        </Match>
        <Match when={!hubState()}>
          <div class="hub-state">
            <h1 class="type-title">{waited() ? 'Hub unavailable' : 'Loading the Hub…'}</h1>
            <p class="hub-subtitle">
              {waited() ? 'The Hub did not answer. Check your connection and try again.' : 'Fetching the catalogue.'}
            </p>
            <Show when={waited()}>
              <div class="hub-state-actions">
                <Button variant="secondary" icon="refresh" onClick={() => browseHub(true)}>Try again</Button>
              </div>
            </Show>
          </div>
        </Match>
      </Switch>
      <ScriptConsentDialog />
    </main>
  );
}

export function HubScreen(): JSX.Element {
  return (
    <div class="hub-screen">
      <div class="hub-screen-panel">
        <ToolpacksPanel />
      </div>
      <HubContent />
    </div>
  );
}
