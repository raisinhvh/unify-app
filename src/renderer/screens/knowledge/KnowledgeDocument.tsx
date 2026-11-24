/**
 * The Knowledge document (Figma 21 · Knowledge 306:2710, right side): one rule, skill file or memory note,
 * read like an open file.
 *
 *   top bar    breadcrumb (scope / kind / [folder] / name / [file]), Read | Edit, Saved, open in editor, more
 *   article    title, description, hairline, the body (headings, lists, paragraphs, inline code)
 *   Details    Type, Scope, Applies to (audience picker), Files, Created, Last (+ an agent's change: Open / Undo),
 *              Used in
 *
 * Edit mode edits the same three parts in place and saves on its own shortly after typing stops.
 */
import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, Show, Switch, type JSX } from 'solid-js';
import { Button, Icon, IconButton, Menu, type MenuEntry } from '../../components';
import { feature } from '../../store/features';
import { setEngineError, viewState } from '../../store';
import { ConfirmBar } from '../toolpacks/ConfirmBar';
import {
  frontmatter,
  openKnowledgeExternally,
  readKnowledge,
  removeKnowledge,
  saveKnowledge,
  setAudiences,
  undoKnowledgeChange,
  type Audience,
  type KnowledgeItem,
} from './adapter';
import { Segmented } from './Segmented';
import { audienceLabel, focusTitle, kindLabels, mode, scopeLabels, select, selectedItem, selection, setFocusTitle, setMode } from './state';

// ---------------------------------------------------------------------------------------------------------------
// Formatting

const hour = 3_600_000;

function relative(at: number | undefined): string {
  if (!at) return '';
  const elapsed = Date.now() - at;
  if (elapsed < 60_000) return 'just now';
  if (elapsed < hour) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 24 * hour) return `${Math.floor(elapsed / hour)}h ago`;
  const days = Math.floor(elapsed / (24 * hour));
  if (days < 7) return `${days}d ago`;
  return shortDate(at);
}

function shortDate(at: number | undefined): string {
  if (!at) return '';
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** A change an agent made in the last day, which the document offers to open or undo. */
export function agentChange(item: KnowledgeItem): boolean {
  return !!item.updatedBy && item.updatedBy !== 'you' && !!item.updatedAt && Date.now() - item.updatedAt < 24 * hour;
}

// ---------------------------------------------------------------------------------------------------------------
// Markdown-ish body: headings, "-" lists, paragraphs and `code`. Enough for rules, skills and notes.

function Inline(props: { text: string }): JSX.Element {
  const parts = () => props.text.split(/(`[^`]+`)/g).filter(Boolean);
  return (
    <For each={parts()}>
      {part => (part.startsWith('`') && part.endsWith('`') ? <code class="kd-code">{part.slice(1, -1)}</code> : <>{part}</>)}
    </For>
  );
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; text: string };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: string[] | undefined;
  let fence: string[] | undefined;
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    if (list) blocks.push({ kind: 'list', items: list });
    paragraph = [];
    list = undefined;
  };
  for (const line of lines) {
    if (fence) {
      if (line.trim().startsWith('```')) {
        blocks.push({ kind: 'code', text: fence.join('\n') });
        fence = undefined;
      } else fence.push(line);
      continue;
    }
    if (line.trim().startsWith('```')) {
      flush();
      fence = [];
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (paragraph.length) {
        blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
        paragraph = [];
      }
      list = [...(list ?? []), bullet[1]];
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (list) flush();
    paragraph.push(line.trim());
  }
  if (fence) blocks.push({ kind: 'code', text: fence.join('\n') });
  flush();
  return blocks;
}

function Body(props: { text: string }): JSX.Element {
  const blocks = createMemo(() => parseBlocks(props.text));
  return (
    <div class="kd-body">
      <For each={blocks()}>
        {block => (
          <Switch>
            <Match when={block.kind === 'heading' && block}>
              {heading => <h3 class="kd-heading">{<Inline text={heading().text} />}</h3>}
            </Match>
            <Match when={block.kind === 'list' && block}>
              {listBlock => (
                <ul class="kd-list">
                  <For each={listBlock().items}>{item => <li><Inline text={item} /></li>}</For>
                </ul>
              )}
            </Match>
            <Match when={block.kind === 'code' && block}>
              {code => <pre class="kd-pre type-mono">{code().text}</pre>}
            </Match>
            <Match when={block.kind === 'paragraph' && block}>
              {paragraph => <p class="kd-paragraph"><Inline text={paragraph().text} /></p>}
            </Match>
          </Switch>
        )}
      </For>
      <Show when={!blocks().length}>
        <p class="kd-paragraph kd-muted">Empty. Switch to Edit to write it.</p>
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Details column

function DetailRow(props: { label: string; children: JSX.Element; class?: string }): JSX.Element {
  return (
    <div class={`kd-detail${props.class ? ' ' + props.class : ''}`}>
      <span class="kd-detail-label">{props.label}</span>
      <div class="kd-detail-value">{props.children}</div>
    </div>
  );
}

/** Who sees the item. Everyone is exclusive; the rest combine. */
function AudiencePicker(props: { item: KnowledgeItem }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();
  const profiles = createMemo(() => {
    const names = new Set(viewState.subagentProfiles.map(profile => profile.name));
    for (const audience of props.item.audiences) if (audience.startsWith('profile:')) names.add(audience.slice('profile:'.length));
    return [...names];
  });
  const has = (audience: Audience) => props.item.audiences.includes(audience);
  const items = (): MenuEntry[] => [
    { id: 'everyone', label: 'Everyone', checked: has('everyone') },
    { id: 'main', label: 'Main agent', checked: has('main') },
    { id: 'subagents', label: 'Subagents', hint: 'every profile', checked: has('subagents') },
    ...(profiles().length ? ([{ kind: 'group', label: 'Subagent profiles' }] as MenuEntry[]) : []),
    ...profiles().map(name => ({ id: `profile:${name}`, label: name, checked: has(`profile:${name}`) })),
  ];
  const toggle = (id: string) => {
    const audience = id as Audience;
    if (audience === 'everyone') {
      setAudiences(props.item.id, ['everyone']);
      return;
    }
    const rest = props.item.audiences.filter(item => item !== 'everyone');
    const next = rest.includes(audience) ? rest.filter(item => item !== audience) : [...rest, audience];
    setAudiences(props.item.id, next.length ? next : ['everyone']);
  };
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        class="kd-audience"
        classList={{ open: open() }}
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <For each={props.item.audiences}>{audience => <span class="kd-audience-line">{audienceLabel(audience)}</span>}</For>
      </button>
      <Menu
        anchor={anchor()}
        open={open()}
        onClose={() => setOpen(false)}
        onSelect={toggle}
        items={items()}
        placement="bottom-start"
        checkColumn
      />
    </>
  );
}

function Details(props: { item: KnowledgeItem }): JSX.Element {
  const fileCount = () => props.item.files?.length;
  return (
    <aside class="kd-details" aria-label="Details">
      <h2 class="kd-details-title">Details</h2>
      <DetailRow label="Type">{kindLabels[props.item.kind].one}</DetailRow>
      <DetailRow label="Scope">{scopeLabels[props.item.scope]}</DetailRow>
      <Show when={props.item.folder}>
        <DetailRow label="Folder">{props.item.folder}</DetailRow>
      </Show>
      <Show when={feature('knowledge.audiences')}>
        <DetailRow label="Applies to" class="kd-detail-audience">
          <AudiencePicker item={props.item} />
        </DetailRow>
      </Show>
      <Show when={fileCount()}>
        <DetailRow label="Files">{fileCount()}</DetailRow>
      </Show>
      <Show when={props.item.createdAt || props.item.createdBy}>
        <DetailRow label="Created">
          <span class="kd-pair">
            <span>{props.item.createdBy}</span>
            <span class="kd-muted">{shortDate(props.item.createdAt)}</span>
          </span>
        </DetailRow>
      </Show>
      <Show when={props.item.updatedAt || props.item.updatedBy}>
        <DetailRow label="Last">
          <span class="kd-pair">
            <span>{props.item.updatedBy}</span>
            <span class="kd-muted">{relative(props.item.updatedAt)}</span>
          </span>
          <Show when={feature('knowledge.agentWrites') && agentChange(props.item)}>
            <span class="kd-change">
              <Button variant="text" class="kd-change-action" onClick={() => openKnowledgeExternally(props.item, selection()?.file)}>
                Open change
              </Button>
              <Button variant="text" class="kd-change-action" onClick={() => undoKnowledgeChange(props.item)}>
                Undo
              </Button>
            </span>
          </Show>
        </DetailRow>
      </Show>
      <Show when={props.item.usedIn !== undefined}>
        <DetailRow label="Used in">
          {props.item.usedIn === 0 ? 'No chats this week' : `${props.item.usedIn} chat${props.item.usedIn === 1 ? '' : 's'} this week`}
        </DetailRow>
      </Show>
    </aside>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Document

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

function Document(props: { item: KnowledgeItem; file?: string }): JSX.Element {
  const [raw, { mutate, refetch }] = createResource(() => readKnowledge(props.item, props.file));
  const [saveState, setSaveState] = createSignal<SaveState>('saved');
  const [error, setError] = createSignal<string>();
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuAnchor, setMenuAnchor] = createSignal<HTMLButtonElement>();
  const [confirmRemove, setConfirmRemove] = createSignal(false);
  let titleInput: HTMLInputElement | undefined;

  const isSkillFile = () => props.item.kind === 'skill' && !!props.file;
  const parsed = createMemo(() => frontmatter(raw() ?? ''));
  const body = () => (isSkillFile() ? raw() ?? '' : parsed().body);
  const description = () => (isSkillFile() ? undefined : props.item.description ?? parsed().description);
  const title = () => (isSkillFile() ? props.file!.split('/').pop()! : props.item.name);

  // Edit buffers, reset whenever another document (or a fresh copy from the engine) loads.
  const [draftName, setDraftName] = createSignal('');
  const [draftDescription, setDraftDescription] = createSignal('');
  const [draftBody, setDraftBody] = createSignal('');
  createEffect(
    on(raw, () => {
      if (raw.loading) return;
      setDraftName(props.item.name);
      setDraftDescription(description() ?? '');
      setDraftBody(body());
      setSaveState('saved');
    }),
  );

  // Someone else (an agent, another device) changed the file: reload it unless there are unsaved edits.
  createEffect(
    on(
      () => props.item.updatedAt,
      () => {
        if (saveState() === 'saved' && props.item.updatedBy !== 'you') void refetch();
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    if (mode() === 'edit' && focusTitle()) {
      queueMicrotask(() => {
        titleInput?.focus();
        titleInput?.select();
      });
      setFocusTitle(false);
    }
  });

  const compose = (): string => {
    if (props.item.kind !== 'skill' || isSkillFile()) return draftBody();
    return `---\nname: ${draftName()}\ndescription: ${draftDescription()}\n---\n${draftBody()}`;
  };

  let timer: number | undefined;
  const save = async () => {
    window.clearTimeout(timer);
    setSaveState('saving');
    try {
      const saved = await saveKnowledge(
        {
          id: props.item.id,
          kind: props.item.kind,
          scope: props.item.scope,
          name: isSkillFile() ? props.item.name : draftName().trim() || props.item.name,
          folder: props.item.folder,
          description: isSkillFile() ? props.item.description : draftDescription().trim() || undefined,
          audiences: props.item.audiences,
        },
        compose(),
        props.file,
      );
      mutate(compose());
      setSaveState('saved');
      setError(undefined);
      if (saved.id !== props.item.id) select({ id: saved.id, file: props.file });
    } catch (failure) {
      setSaveState('error');
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const schedule = () => {
    setSaveState('dirty');
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void save(), 700);
  };
  onCleanup(() => {
    if (saveState() === 'dirty') void save();
    window.clearTimeout(timer);
  });

  const saveLabel = () => ({ saved: 'Saved', dirty: 'Edited', saving: 'Saving…', error: 'Not saved' })[saveState()];

  const crumbs = (): string[] => {
    const parts = [scopeLabels[props.item.scope], kindLabels[props.item.kind].many];
    if (props.item.folder) parts.push(props.item.folder);
    parts.push(props.item.name);
    if (props.item.kind === 'skill') parts.push(props.file ?? 'SKILL.md');
    else {
      // Rules and notes: the file on disk, so it's clear which one this is.
      const fileName = props.item.path.split(/[\\/]/).pop();
      if (fileName) parts.push(fileName);
    }
    return parts;
  };

  /** Hover text per crumb: the last one (the file) shows its full path. */
  const crumbTitle = (crumb: string, index: number): string =>
    index === crumbs().length - 1 && props.item.kind !== 'skill' ? props.item.path : crumb;

  const moreItems = (): MenuEntry[] => [
    { id: 'open', label: 'Open in editor', icon: 'pop' },
    { id: 'reload', label: 'Reload from disk', icon: 'refresh' },
    { kind: 'separator' },
    { id: 'remove', label: `Remove ${kindLabels[props.item.kind].one.toLowerCase()}…`, danger: true },
  ];

  return (
    <div class="kd-document">
      <header class="kd-topbar">
        <nav class="kd-crumbs type-label" aria-label="Location">
          <For each={crumbs()}>
            {(crumb, index) => (
              <>
                <Show when={index() > 0}>
                  <span class="kd-crumb-sep">/</span>
                </Show>
                <span class="kd-crumb" classList={{ current: index() === crumbs().length - 1 }} title={crumbTitle(crumb, index())}>{crumb}</span>
              </>
            )}
          </For>
        </nav>
        <Segmented
          class="kd-mode"
          label="Mode"
          value={mode()}
          onChange={next => {
            if (next === 'read' && saveState() === 'dirty') void save();
            setMode(next);
          }}
          options={[
            { value: 'read', label: 'Read' },
            { value: 'edit', label: 'Edit' },
          ]}
        />
        <span class="kd-saved type-caption" classList={{ error: saveState() === 'error' }} title={error()}>
          {saveLabel()}
        </span>
        <IconButton icon="pop" label="Open in editor" onClick={() => openKnowledgeExternally(props.item, props.file)} />
        <IconButton ref={setMenuAnchor} icon="more" label="More" active={menuOpen()} onClick={() => setMenuOpen(!menuOpen())} />
        <Menu
          anchor={menuAnchor()}
          open={menuOpen()}
          onClose={() => setMenuOpen(false)}
          placement="bottom-end"
          items={moreItems()}
          onSelect={id => {
            if (id === 'open') openKnowledgeExternally(props.item, props.file);
            if (id === 'reload') void refetch();
            if (id === 'remove') setConfirmRemove(true);
          }}
        />
      </header>

      <div class="kd-scroll">
        <article class="kd-article">
          <ConfirmBar
            open={confirmRemove()}
            message={<>Remove <strong>{props.item.name}</strong>? Agents stop seeing it in new chats.</>}
            action="Remove"
            onCancel={() => setConfirmRemove(false)}
            onConfirm={() => {
              setConfirmRemove(false);
              // The tree row plays its select-all sweep before it collapses (KnowledgePanel's OrganicList).
              removeKnowledge(props.item.id).catch(error => setEngineError(`Could not remove ${props.item.name}: ${error instanceof Error ? error.message : String(error)}`));
              select(undefined);
            }}
          />
          <Show
            when={mode() === 'edit'}
            fallback={
              <>
                <h1 class="kd-title">{title()}</h1>
                <Show when={description()}>
                  <p class="kd-description">{description()}</p>
                </Show>
                <hr class="kd-rule" />
                <Show when={!raw.loading} fallback={<p class="kd-paragraph kd-muted">Loading…</p>}>
                  <Show when={!raw.error} fallback={<p class="kd-paragraph kd-error">{String(raw.error?.message ?? raw.error)}</p>}>
                    <Body text={body()} />
                  </Show>
                </Show>
              </>
            }
          >
            <input
              ref={titleInput}
              class="kd-title kd-input"
              value={isSkillFile() ? title() : draftName()}
              readOnly={isSkillFile()}
              aria-label="Title"
              placeholder="Title"
              onInput={event => {
                setDraftName(event.currentTarget.value);
                schedule();
              }}
            />
            <Show when={!isSkillFile()}>
              <input
                class="kd-description kd-input"
                value={draftDescription()}
                aria-label="Description"
                placeholder={props.item.kind === 'skill' ? 'When should an agent load this skill?' : 'Description (optional)'}
                onInput={event => {
                  setDraftDescription(event.currentTarget.value);
                  schedule();
                }}
              />
            </Show>
            <hr class="kd-rule" />
            <textarea
              class="kd-editor type-mono"
              value={draftBody()}
              spellcheck={false}
              aria-label="Content"
              onInput={event => {
                setDraftBody(event.currentTarget.value);
                schedule();
              }}
              onKeyDown={event => {
                if ((event.ctrlKey || event.metaKey) && event.key === 's') {
                  event.preventDefault();
                  void save();
                }
              }}
            />
          </Show>
        </article>
        <Details item={props.item} />
      </div>
    </div>
  );
}

/** The right-hand side of Knowledge: the selected item, or a short empty state. */
export function KnowledgeDocument(): JSX.Element {
  return (
    <Show
      when={selectedItem()}
      fallback={
        <div class="kd-empty">
          <Icon name="knowledge" size={16} />
          <h1 class="type-title">Nothing open</h1>
          <p class="kd-description">Pick a rule, skill or memory note on the left, or press + to write one.</p>
        </div>
      }
    >
      {item => (
        // Keyed by id and file: another document starts fresh; updates to the same one flow in.
        <Show when={`${item().id}::${selection()?.file ?? ''}`} keyed>
          {(_key: string) => <Document item={item()} file={selection()?.file} />}
        </Show>
      )}
    </Show>
  );
}
