/**
 * The Agents side panel.
 *
 *   header      "Agents" + new subagent
 *   General     the explorer, helper models and how subagents run
 *   Subagents   a folder with one row per profile (its access on the right), and the draft while one is new
 *
 * Rows only select; editing happens on the page.
 */
import { Show, type JSX } from 'solid-js';
import { Icon, IconButton, TreeFolder, TreeItem } from '../../components';
import { AnimatedList } from '../../motion';
import { viewState } from '../../store';
import { select, selection, setSubagentsOpen, subagentsOpen } from './selection';

/** The draft's row key. Profile names never contain a NUL, so it cannot clash with one. */
const draftRow = '\u0000new';

export function AgentsPanel(): JSX.Element {
  const profiles = () => viewState.subagentProfiles;
  const isSelected = (name: string) => {
    const current = selection();
    return current.kind === 'profile' && current.name === name;
  };
  const drafting = () => selection().kind === 'new';
  const rows = () => [...profiles().map(profile => profile.name), ...(drafting() ? [draftRow] : [])];
  const startNew = () => {
    setSubagentsOpen(true);
    select({ kind: 'new' });
  };
  return (
    <aside class="side-panel agents-panel" aria-label="Agents">
      <header class="agents-panel-header">
        <h2 class="type-heading">Agents</h2>
        <IconButton icon="plus" label="New subagent" class="ag-icon-28" onClick={startNew} />
      </header>
      <div class="agents-panel-list">
        <TreeItem
          class="ag-general-row"
          leading={<Icon name="settings" size={16} />}
          label="General"
          selected={selection().kind === 'general'}
          onClick={() => select({ kind: 'general' })}
        />
        <TreeFolder
          label="Subagents"
          icon="folder"
          trailing={String(profiles().length)}
          open={subagentsOpen()}
          onToggle={setSubagentsOpen}
        >
          {/* The draft rides in the same list, so it reveals and folds away like a profile row. */}
          <AnimatedList each={rows()} key={row => row}>
            {row => (
              <Show
                when={row() !== draftRow && profiles().find(profile => profile.name === row())}
                fallback={<TreeItem leading={<Icon name="plus" size={16} />} label="New subagent" tone="muted" selected />}
              >
                {profile => (
                  <TreeItem
                    leading={<Icon name="bot" size={16} />}
                    label={profile().name}
                    trailing={profile().mode === 'edit' ? 'Can edit' : 'Read-only'}
                    selected={isSelected(profile().name)}
                    onClick={() => select({ kind: 'profile', name: profile().name })}
                  />
                )}
              </Show>
            )}
          </AnimatedList>
          <Show when={!profiles().length && !drafting()}>
            <p class="ag-panel-empty type-caption">No subagents yet</p>
          </Show>
        </TreeFolder>
      </div>
    </aside>
  );
}
