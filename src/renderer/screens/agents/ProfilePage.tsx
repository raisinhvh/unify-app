/**
 * Agents › one subagent profile, and the draft for a new one.
 *
 *   header   the name (or "New subagent"), its access and model in muted cells, and a menu with Remove
 *   rows     Name, Description, Model with Effort and Speed under it, Access, Toolpack tools
 *
 * A saved profile posts `saveSubagent` on every change (text fields on blur or Enter) and shows the engine's
 * echo. A rename keeps the page open on the new name once the engine has it. A new profile stays a local draft
 * until "Add subagent"; the engine rejects a profile without a name or an available model.
 */
import { createEffect, createSignal, on, Show, type JSX } from 'solid-js';
import { post } from '../../bridge';
import { Button, IconButton, Menu, ModelPicker, Select, Toggle, type SelectOption } from '../../components';
import { engineError, viewState } from '../../store';
import { AgentRow, EffortSpeedRows, modelName, withModel } from './rows';
import { select, selection } from './selection';

export type SubagentProfile = (typeof viewState.subagentProfiles)[number];

const accessOptions: SelectOption[] = [
  { value: 'read-only', label: 'Read-only' },
  { value: 'edit', label: 'Can edit files' },
];

export function accessLabel(profile: SubagentProfile): string {
  return profile.mode === 'edit' ? 'Can edit files' : 'Read-only';
}

function findProfile(name: string | undefined): SubagentProfile | undefined {
  return name === undefined ? undefined : viewState.subagentProfiles.find(profile => profile.name === name);
}

/** A text input that commits on blur or Enter and reverts on Escape. */
function TextField(props: {
  id: string;
  value: string;
  placeholder: string;
  wide?: boolean;
  onCommit: (value: string) => void;
  /** Called on every keystroke (drafts track the text live). */
  onInput?: (value: string) => void;
}): JSX.Element {
  const [text, setText] = createSignal(props.value);
  createEffect(on(() => props.value, value => setText(value)));
  return (
    <input
      id={props.id}
      class="ag-text-input"
      classList={{ wide: !!props.wide }}
      value={text()}
      placeholder={props.placeholder}
      spellcheck={false}
      onInput={event => {
        setText(event.currentTarget.value);
        props.onInput?.(event.currentTarget.value);
      }}
      onBlur={() => props.onCommit(text())}
      onKeyDown={event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          setText(props.value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** The rows shared by a saved profile and the draft. `onChange` gets the whole profile with one field changed. */
function ProfileRows(props: {
  profile: SubagentProfile;
  onChange: (next: SubagentProfile) => void;
  onNameInput?: (name: string) => void;
  nameCaption: string;
}): JSX.Element {
  const profile = () => props.profile;
  return (
    <div class="ag-rows">
      <AgentRow label={<label for="ag-profile-name">Name</label>} caption={props.nameCaption}>
        <TextField
          id="ag-profile-name"
          value={profile().name}
          placeholder="reviewer"
          onInput={props.onNameInput}
          onCommit={name => props.onChange({ ...profile(), name: name.trim() })}
        />
      </AgentRow>
      <AgentRow
        label={<label for="ag-profile-description">Description</label>}
        caption="Tells the main agent when to pick this subagent."
      >
        <TextField
          id="ag-profile-description"
          wide
          value={profile().description ?? ''}
          placeholder="Reviews a diff for bugs"
          onCommit={description => props.onChange({ ...profile(), description: description.trim() || undefined })}
        />
      </AgentRow>
      <AgentRow
        label="Model"
        caption={profile().model ? 'Runs every task given to this subagent.' : 'Pick the model this subagent runs on.'}
      >
        <ModelPicker
          variant="regular"
          smartAuto={false}
          placement="bottom-end"
          value={profile().model}
          placeholder="Choose a model"
          title="Subagent model"
          onChange={model => props.onChange({ ...withModel(profile(), model), model })}
        />
      </AgentRow>
      <EffortSpeedRows
        model={profile().model || undefined}
        effort={profile().effort}
        speed={profile().speed}
        depth={1}
        onEffort={effort => props.onChange({ ...profile(), effort })}
        onSpeed={speed => props.onChange({ ...profile(), speed })}
      />
      <AgentRow
        label="Access"
        caption={profile().mode === 'edit' ? 'Can change files in the working copy.' : 'Reads and searches, but never changes files.'}
      >
        <Select
          value={profile().mode}
          options={accessOptions}
          placement="bottom-end"
          title="Access"
          onChange={mode => props.onChange({ ...profile(), mode: mode === 'edit' ? 'edit' : 'read-only' })}
        />
      </AgentRow>
      <AgentRow label="Toolpack tools" caption="Tools from your installed toolpacks, such as Blender or Roblox Studio.">
        <Toggle
          label="Toolpack tools"
          checked={profile().tools !== false}
          onChange={tools => props.onChange({ ...profile(), tools })}
        />
      </AgentRow>
    </div>
  );
}

function ProfileHeader(props: { title: string; profile: SubagentProfile; onRemove?: () => void }): JSX.Element {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();
  return (
    <header class="ag-page-header">
      <div class="ag-page-heading">
        <h1 class="ag-title">{props.title}</h1>
        <p class="ag-page-status">
          <span>{accessLabel(props.profile)}</span>
          <span class="ag-status-cell">{props.profile.model ? modelName(props.profile.model) : 'No model yet'}</span>
        </p>
      </div>
      <Show when={props.onRemove}>
        <IconButton
          ref={setAnchor}
          icon="more"
          label="Subagent actions"
          class="ag-icon-28"
          aria-expanded={menuOpen()}
          onClick={() => setMenuOpen(!menuOpen())}
        />
        <Menu
          anchor={anchor()}
          open={menuOpen()}
          onClose={() => setMenuOpen(false)}
          onSelect={id => {
            if (id === 'remove') props.onRemove?.();
          }}
          items={[{ id: 'remove', label: 'Remove subagent', danger: true }]}
          placement="bottom-end"
        />
      </Show>
    </header>
  );
}

/** The selected saved profile. Lives on one page for every profile, so switching profiles swaps it in place. */
export function ProfilePage(): JSX.Element {
  const selectedName = () => {
    const current = selection();
    return current.kind === 'profile' ? current.name : undefined;
  };
  // A rename in flight: the engine still knows the profile by its old name until it echoes the new list.
  const [pendingName, setPendingName] = createSignal<string>();
  const profile = () => findProfile(selectedName()) ?? findProfile(pendingName());

  createEffect(
    on(
      () => [pendingName(), viewState.subagentProfiles] as const,
      ([pending]) => {
        if (pending !== undefined && findProfile(pending)) {
          setPendingName(undefined);
          select({ kind: 'profile', name: pending });
        }
      },
    ),
  );
  // The engine refused the rename: keep the old name.
  createEffect(
    on(
      engineError,
      error => {
        if (error) setPendingName(undefined);
      },
      { defer: true },
    ),
  );

  const save = (current: SubagentProfile, next: SubagentProfile) => {
    if (!next.name) return;
    if (next.name !== current.name) {
      if (findProfile(next.name)) return;
      setPendingName(next.name);
    }
    post({ type: 'saveSubagent', originalName: current.name, profile: next });
  };

  return (
    <Show when={profile()} fallback={<p class="ag-empty type-caption">This subagent was removed.</p>}>
      {current => (
        <section class="ag-page" aria-label={`Subagent ${current().name}`}>
          <ProfileHeader
            title={current().name}
            profile={current()}
            onRemove={() => {
              post({ type: 'removeSubagent', name: current().name });
              select({ kind: 'general' });
            }}
          />
          <ProfileRows
            profile={current()}
            nameCaption="The main agent asks for this subagent by name."
            onChange={next => save(current(), next)}
          />
        </section>
      )}
    </Show>
  );
}

/** A new profile, kept locally until it is added. */
export function NewProfilePage(): JSX.Element {
  const [draft, setDraft] = createSignal<SubagentProfile>({ name: '', model: '', mode: 'read-only' });
  const [typedName, setTypedName] = createSignal('');
  const [adding, setAdding] = createSignal<string>();

  const name = () => typedName().trim();
  const duplicate = () => !!name() && !!findProfile(name());
  const canAdd = () => !!name() && !!draft().model && !duplicate() && adding() === undefined;
  const nameCaption = () => (duplicate() ? 'A subagent with this name already exists.' : 'The main agent asks for this subagent by name.');

  createEffect(
    on(
      () => [adding(), viewState.subagentProfiles] as const,
      ([pending]) => {
        if (pending !== undefined && findProfile(pending)) {
          setAdding(undefined);
          select({ kind: 'profile', name: pending });
        }
      },
    ),
  );
  createEffect(
    on(
      engineError,
      error => {
        if (error) setAdding(undefined);
      },
      { defer: true },
    ),
  );

  const add = () => {
    if (!canAdd()) return;
    const profile = { ...draft(), name: name() };
    setAdding(profile.name);
    post({ type: 'saveSubagent', profile });
  };

  return (
    <section class="ag-page" aria-label="New subagent">
      <ProfileHeader title="New subagent" profile={draft()} />
      <ProfileRows
        profile={draft()}
        nameCaption={nameCaption()}
        onNameInput={setTypedName}
        onChange={next => {
          setTypedName(next.name);
          setDraft(next);
        }}
      />
      <div class="ag-actions">
        <Button variant="secondary" onClick={() => select({ kind: 'general' })}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!canAdd()} onClick={add}>
          Add subagent
        </Button>
      </div>
    </section>
  );
}
