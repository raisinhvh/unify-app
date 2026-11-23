/**
 * Toolpacks (Figma 22 · Toolpacks 306:3562): one installed pack, picked in the side panel (ToolpacksPanel).
 * Exports `ToolpacksPanel` (side-panel slot), `ToolpacksContent` (content card) and the composite `ToolpacksScreen`.
 *
 *   breadcrumb + more menu (reload, logs, remove)
 *   title row     glyph tile, name, description
 *   meta strip    version, source, synced devices            Enabled switch
 *   Tools         "22 of 24 enabled", filter; groups Read / Write / Run with a permission picker each,
 *                 one row per tool with its own switch
 *
 * Extra pack fields (version, source, kinds, per-tool switches, permissions) come through adapter.ts and fall
 * back when the engine does not send them yet.
 */
import { createMemo, createSignal, For, Index, Show, type JSX } from 'solid-js';
import { Button, Icon, IconButton, Menu, Select, Toggle } from '../../components';
import { Collapse, createSpring, pressable } from '../../motion';
import { RollingNumber } from '../../motion/organic';
import { navigate } from '../../router';
import { feature } from '../../store/features';
import {
  addLocalPack,
  packAction,
  setGroupPolicy,
  setPackEnabled,
  setToolEnabled,
  toolIsOn,
  toolKinds,
  type InstalledPack,
  type PackTool,
  type ToolKind,
  type ToolPolicy,
} from './adapter';
import { ConfirmBar } from './ConfirmBar';
import { ToolpacksPanel } from './ToolpacksPanel';
import { GlyphTile } from './glyphs';
import { currentPack, selectPack } from './selection';
import './toolpacks.css';

const kindLabels: Record<ToolKind, string> = { read: 'Read', write: 'Write', run: 'Run' };

const policyOptions: { value: ToolPolicy; label: string; hint: string }[] = [
  { value: 'always', label: 'Always allow', hint: 'no approval' },
  { value: 'ask', label: 'Ask first', hint: 'approve each call' },
  { value: 'off', label: 'Off', hint: 'agents never see them' },
];

function ToolRow(props: { pack: InstalledPack; tool: PackTool }): JSX.Element {
  const on = () => toolIsOn(props.pack, props.tool);
  return (
    <div class="tp-tool-row" classList={{ off: !on() }}>
      <span class="tp-tool-name type-mono" title={props.tool.name}>{props.tool.name}</span>
      <span class="tp-tool-description" title={props.tool.description}>{props.tool.description}</span>
      <Toggle
        checked={props.tool.enabled}
        disabled={props.pack.policies[props.tool.kind] === 'off'}
        onChange={enabled => setToolEnabled(props.pack.id, props.tool.name, enabled)}
        label={`${props.tool.name} enabled`}
      />
    </div>
  );
}

function ToolGroup(props: { pack: InstalledPack; kind: ToolKind; tools: PackTool[] }): JSX.Element {
  const [open, setOpen] = createSignal(true);
  const rotation = createSpring(() => (open() ? 0 : -90), 'indicator', { precision: 100 });
  return (
    <div class="tp-group">
      <div class="tp-group-row">
        <button
          type="button"
          class="tp-group-toggle"
          aria-expanded={open()}
          ref={element => pressable(element, 0.98)}
          onClick={() => setOpen(!open())}
        >
          <Icon name="chevron" size={12} class="tp-group-chevron" style={{ rotate: `${rotation()}deg` }} />
          <span class="tp-group-name">{kindLabels[props.kind]}</span>
          <span class="tp-group-count type-caption">
            <RollingNumber value={props.tools.length} />
          </span>
        </button>
        <span class="tp-group-permission type-caption">Permission</span>
        <Select
          value={props.pack.policies[props.kind]}
          options={policyOptions}
          placement="bottom-end"
          onChange={value => setGroupPolicy(props.pack.id, props.kind, value as ToolPolicy)}
        />
      </div>
      <Collapse open={open()}>
        {/* Index keeps each row (and its switch spring) when the pack list is recomputed. */}
        <Index each={props.tools}>{tool => <ToolRow pack={props.pack} tool={tool()} />}</Index>
      </Collapse>
    </div>
  );
}

function PackDetail(props: { pack: InstalledPack }): JSX.Element {
  const [query, setQuery] = createSignal('');
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuAnchor, setMenuAnchor] = createSignal<HTMLButtonElement>();
  const [logsOpen, setLogsOpen] = createSignal(false);
  const [confirmRemove, setConfirmRemove] = createSignal(false);

  const enabledCount = () => props.pack.tools.filter(tool => toolIsOn(props.pack, tool)).length;
  const filtered = createMemo(() => {
    const text = query().trim().toLowerCase();
    return text
      ? props.pack.tools.filter(tool => tool.name.toLowerCase().includes(text) || tool.description.toLowerCase().includes(text))
      : props.pack.tools;
  });
  const toolsByKind = createMemo(() => {
    const groups: Record<ToolKind, PackTool[]> = { read: [], write: [], run: [] };
    for (const tool of filtered()) groups[tool.kind].push(tool);
    return groups;
  });
  const groupTools = (kind: ToolKind): PackTool[] => toolsByKind()[kind];
  const hasTools = () => filtered().length > 0;

  const sourceLabel = () => (props.pack.source === 'hub' ? 'Toolpack Hub' : props.pack.source === 'local' ? 'a folder' : undefined);

  return (
    <div class="tp-column">
      <div class="tp-breadcrumb type-label">
        <span>Toolpacks</span>
        <span class="tp-crumb-sep">/</span>
        <span>Installed</span>
        <span class="tp-crumb-sep">/</span>
        <span class="tp-crumb-current">{props.pack.name}</span>
        <span class="tp-spacer" />
        <IconButton ref={setMenuAnchor} icon="more" label="More" active={menuOpen()} onClick={() => setMenuOpen(!menuOpen())} />
        <Menu
          anchor={menuAnchor()}
          open={menuOpen()}
          onClose={() => setMenuOpen(false)}
          placement="bottom-end"
          items={[
            { id: 'reload', label: 'Reload', icon: 'refresh' },
            { id: 'logs', label: logsOpen() ? 'Hide logs' : 'Show logs', icon: 'file' },
            { kind: 'separator' },
            { id: 'remove', label: 'Remove…', danger: true },
          ]}
          onSelect={id => {
            setMenuOpen(false);
            if (id === 'reload') packAction(props.pack.id, 'reload');
            if (id === 'logs') setLogsOpen(!logsOpen());
            if (id === 'remove') setConfirmRemove(true);
          }}
        />
      </div>

      <div class="tp-title-row">
        <GlyphTile name={props.pack.glyph} size={40} />
        <div class="tp-title-text">
          <h1 class="type-title tp-title">{props.pack.name}</h1>
          <p class="tp-description" title={props.pack.description}>{props.pack.description}</p>
        </div>
      </div>

      <ConfirmBar
        open={confirmRemove()}
        message={<>Remove <strong>{props.pack.name}</strong>? Agents lose its tools in every chat.</>}
        action="Remove"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          packAction(props.pack.id, 'remove');
          selectPack(undefined);
        }}
      />

      <div class="tp-meta">
        <span class="tp-meta-items">
          <Show when={props.pack.version}>
            <span class="tp-meta-item">Version <span class="tp-meta-value">{props.pack.version}</span></span>
          </Show>
          <Show when={sourceLabel()}>
            <span class="tp-meta-item">From <span class="tp-meta-value">{sourceLabel()}</span></span>
          </Show>
          <Show when={props.pack.syncedDevices}>
            <span class="tp-meta-item">
              <Icon name="cloud" size={14} />
              <span class="tp-meta-value">Synced to {props.pack.syncedDevices} device{props.pack.syncedDevices === 1 ? '' : 's'}</span>
            </span>
          </Show>
          <Show when={!props.pack.version && !sourceLabel() && !props.pack.syncedDevices}>
            <span class="tp-meta-item"><span class="tp-meta-value">{props.pack.status}</span></span>
          </Show>
        </span>
        <span class="tp-meta-enabled">Enabled</span>
        <Toggle checked={props.pack.enabled} onChange={on => setPackEnabled(props.pack.id, on)} label={`${props.pack.name} enabled`} />
      </div>

      <Show when={props.pack.state === 'error' || props.pack.state === 'starting'}>
        <div class="tp-notice" classList={{ error: props.pack.state === 'error' }}>
          <span class="tp-notice-text">{props.pack.error || props.pack.status}</span>
          <Show when={props.pack.state === 'error'}>
            <Button variant="text" icon="refresh" onClick={() => packAction(props.pack.id, 'reload')}>Reload</Button>
          </Show>
        </div>
      </Show>

      <div class="tp-tools-header">
        <h2 class="type-heading">Tools</h2>
        <span class="type-caption tp-tools-count">
          <RollingNumber value={enabledCount()} data-motion="toolpacks-enabled" /> of{' '}
          <RollingNumber value={props.pack.tools.length} /> enabled
        </span>
        <span class="tp-spacer" />
        <label class="tp-filter">
          <Icon name="search" size={14} />
          <input
            type="search"
            placeholder={`Filter ${props.pack.tools.length} tools`}
            value={query()}
            onInput={event => setQuery(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') setQuery('');
            }}
          />
        </label>
      </div>

      <div class="tp-groups">
        <For each={toolKinds}>
          {kind => (
            <Show when={groupTools(kind).length}>
              <ToolGroup pack={props.pack} kind={kind} tools={groupTools(kind)} />
            </Show>
          )}
        </For>
        <Show when={!hasTools()}>
          <div class="tp-empty-tools type-label">{query() ? 'No tools match.' : 'This pack has no tools.'}</div>
        </Show>
      </div>

      <Collapse open={logsOpen()}>
        <div class="tp-logs">
          <div class="tp-logs-header">
            <h2 class="type-heading">Logs</h2>
            <IconButton icon="close" label="Hide logs" size="small" onClick={() => setLogsOpen(false)} />
          </div>
          <pre class="tp-log type-mono">{props.pack.logs.length ? props.pack.logs.join('\n') : 'No output yet.'}</pre>
        </div>
      </Collapse>
    </div>
  );
}

export { ToolpacksPanel } from './ToolpacksPanel';

/** The content card: the selected installed pack, or the empty state. Scrolls itself. */
export function ToolpacksContent(): JSX.Element {
  return (
    <div class="tp-screen">
      <Show
        when={currentPack()?.id}
        keyed
        fallback={
          <div class="tp-empty">
            <h1 class="type-title">No toolpacks yet</h1>
            <p class="tp-description">Toolpacks give agents tools for other apps: Roblox Studio, Figma, Blender and more.</p>
            <div class="tp-empty-actions">
              <Show when={feature('toolpacks.hub')}>
                <Button variant="primary" onClick={() => navigate('hub')}>Browse the Hub</Button>
              </Show>
              <Button variant="secondary" icon="folder" onClick={addLocalPack}>Add from folder</Button>
            </div>
          </div>
        }
      >
        {/* Keyed by id: switching packs starts fresh (filter, menus); updates to the same pack flow in. */}
        {(_id: string) => <PackDetail pack={currentPack()!} />}
      </Show>
    </div>
  );
}

/** Composite: side panel + content, for when the screen owns both (like Providers). */
export function ToolpacksScreen(): JSX.Element {
  return (
    <div class="toolpacks-screen">
      <div class="toolpacks-screen-panel">
        <ToolpacksPanel />
      </div>
      <div class="toolpacks-screen-content">
        <ToolpacksContent />
      </div>
    </div>
  );
}
