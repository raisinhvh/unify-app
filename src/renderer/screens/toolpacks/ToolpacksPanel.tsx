/**
 * The Toolpacks side panel (left of Figma 22 · Toolpacks and 23 · Toolpack Hub). Drawn for both the
 * toolpacks and hub routes.
 *
 *   header        "Toolpacks" + add a toolpack from a folder
 *   Toolpack Hub  opening it goes to the Hub; children are its categories with counts (hidden when the
 *                 `toolpacks.hub` feature is off)
 *   Installed     one row per pack: chevron (expands its tools), glyph, name, tool count, on/off switch.
 *                 Expanded packs list their tools in mono with the tool's group (read / write / run) or "off".
 *                 A pack whose setup checklist has pending steps says "Setup" (warn; tooltip: steps left) instead of
 *                 its tool count. "Setup needed" clipped names like "Roblox Studio" at the panel width.
 */
import { createMemo, For, Index, onMount, Show, type JSX } from 'solid-js';
import { Icon, IconButton, Toggle, TreeFolder, TreeItem } from '../../components';
import { AnimatedList, Collapse, createSpring, pressable } from '../../motion';
import { navigate, route } from '../../router';
import { feature } from '../../store/features';
import { browseHub, hubState } from '../hub/hubAdapter';
import { addLocalPack, installedPacks, setPackEnabled, toolIsOn, type InstalledPack } from './adapter';
import { Glyph } from './glyphs';
import { currentPack, hubCategory, isOpen, selectPack, setHubCategory, setOpen } from './selection';
import { pendingSetup, requestSetupList } from './setup';
import './setup.css';
import './toolpacks-panel.css';

function GlyphLabel(props: { glyph: string; text: string }): JSX.Element {
  return (
    <span class="tp-glyph-label">
      <Glyph name={props.glyph} class="tp-folder-glyph" />
      <span class="tp-glyph-text">{props.text}</span>
    </span>
  );
}

function PackRow(props: { pack: InstalledPack }): JSX.Element {
  const key = () => `pack:${props.pack.id}`;
  const expanded = () => isOpen(key());
  const rotation = createSpring(() => (expanded() ? 0 : -90), 'indicator', { precision: 100 });
  const selected = () => route() === 'toolpacks' && currentPack()?.id === props.pack.id;
  const setupNeeded = () => pendingSetup(props.pack.id) > 0;
  const open = () => {
    selectPack(props.pack.id);
    navigate('toolpacks');
  };
  return (
    <div class="tp-pack" classList={{ off: !props.pack.enabled }}>
      <div class="tree-row tp-pack-row" classList={{ selected: selected() }}>
        <button
          type="button"
          class="tp-pack-chevron"
          aria-label={expanded() ? `Hide ${props.pack.name} tools` : `Show ${props.pack.name} tools`}
          aria-expanded={expanded()}
          ref={element => pressable(element, 0.9)}
          onClick={() => setOpen(key(), !expanded())}
        >
          <Icon name="chevron" size={12} class="tree-chevron" style={{ rotate: `${rotation()}deg` }} />
        </button>
        <button type="button" class="tp-pack-main" ref={element => pressable(element, 0.98)} onClick={open}>
          <Glyph name={props.pack.glyph} class="tp-pack-glyph" />
          <span class="tree-label">{props.pack.name}</span>
          <span
            class="tree-trailing"
            classList={{ warn: props.pack.state === 'error', 'tp-setup-needed': props.pack.state !== 'error' && setupNeeded() }}
            title={setupNeeded() ? `Setup needed: ${pendingSetup(props.pack.id)} step${pendingSetup(props.pack.id) === 1 ? '' : 's'} to finish` : undefined}
          >
            {props.pack.state === 'error' ? 'error' : setupNeeded() ? 'Setup' : props.pack.enabled ? props.pack.tools.length : 'off'}
          </span>
        </button>
        <Toggle checked={props.pack.enabled} onChange={on => setPackEnabled(props.pack.id, on)} label={`${props.pack.name} enabled`} />
      </div>
      <Collapse open={expanded()} class="tp-pack-tools">
        <Index each={props.pack.tools}>
          {tool => {
            const on = () => props.pack.enabled && toolIsOn(props.pack, tool());
            return (
              <TreeItem
                class={on() ? 'tp-tool' : 'tp-tool off'}
                label={<span class="type-mono">{tool().name}</span>}
                trailing={on() ? tool().kind : 'off'}
                onClick={open}
              />
            );
          }}
        </Index>
      </Collapse>
    </div>
  );
}

export function ToolpacksPanel(): JSX.Element {
  const hubOn = () => feature('toolpacks.hub');
  const categories = createMemo(() => {
    const hub = hubState();
    if (!hub) return [];
    const counts = new Map<string, number>();
    for (const pack of hub.packs) counts.set(pack.category, (counts.get(pack.category) || 0) + 1);
    return [{ id: 'all', label: 'All', count: hub.packs.length }, ...hub.categories.map(category => ({ ...category, count: counts.get(category.id) || 0 }))];
  });

  onMount(() => {
    if (hubOn()) browseHub();
    requestSetupList();
  });

  const openCategory = (id: string) => {
    setHubCategory(id);
    navigate('hub');
  };

  return (
    <aside class="side-panel toolpacks-panel" aria-label="Toolpacks">
      <header class="tp-panel-header">
        <h2 class="type-heading">Toolpacks</h2>
        <IconButton icon="plus" label="Add toolpack from folder" onClick={addLocalPack} />
      </header>
      <div class="tp-panel-tree">
        <Show when={hubOn()}>
          <TreeFolder
            label={<GlyphLabel glyph="hub" text="Toolpack Hub" />}
            trailing={hubState() ? String(hubState()!.packs.length) : ''}
            open={isOpen('hub')}
            onToggle={open => {
              setOpen('hub', open);
              if (open) {
                browseHub();
                openCategory(hubCategory());
              }
            }}
          >
            <For each={categories()}>
              {category => (
                <TreeItem
                  class="tp-category"
                  label={category.label}
                  trailing={String(category.count)}
                  selected={route() === 'hub' && hubCategory() === category.id}
                  onClick={() => openCategory(category.id)}
                />
              )}
            </For>
          </TreeFolder>
        </Show>
        <TreeFolder
          icon="folder"
          label="Installed"
          trailing={String(installedPacks().length)}
          open={isOpen('installed')}
          onToggle={open => setOpen('installed', open)}
        >
          <AnimatedList each={installedPacks()} key={pack => pack.id}>
            {pack => <PackRow pack={pack()} />}
          </AnimatedList>
          <Show when={!installedPacks().length}>
            <div class="tp-panel-empty type-label">No toolpacks yet</div>
          </Show>
        </TreeFolder>
      </div>
    </aside>
  );
}
