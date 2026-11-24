/**
 * DEV ONLY. The organic motion gallery (see gallery.tsx). One card per primitive with trigger buttons,
 * a "Spam" button per card for interruption, and global toggles (reduced motion, each motion.organic feature,
 * theme). Elements carry data-motion names for .unify/tools/motion-audit.mjs; buttons have ids for scenarios.
 */
import { createSignal, For, Index, onCleanup, type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { Button, Toggle } from '../../components';
import { connectStore } from '../../store';
import { feature, setFeature, type FeatureId } from '../../store/features';
import { installTheme, setTheme, currentTheme, themes, type ThemeId } from '../../theme';
import { prefersReducedMotion, setAppReducedMotion } from '../reducedMotion';
import { EditedLines } from './EditedLines';
import { OrganicList } from './OrganicList';
import { RetypeText } from './RetypeText';
import { RollingNumber } from './RollingNumber';
import './gallery.css';

const renameNames = [
  'Untitled chat',
  'Fix login redirect',
  'Fix login redirect loop',
  'Session refresh tokens',
  'auth.ts',
  'session.ts',
  'Refactor provider registry into smaller per-runtime modules',
];

const statusLabels = ['Reading files', 'Running tests', 'Running typecheck', 'Writing summary', 'Reading files'];

const extraNames = ['notes.md', 'router.ts', 'Plan the Hub backend', 'theme.css', 'README.md', 'Usage popover', 'flip.ts'];

let nextId = 100;

function pick<T>(list: readonly T[], index: number): T {
  return list[((index % list.length) + list.length) % list.length];
}

function Card(props: { title: string; hint: string; children: JSX.Element; actions: JSX.Element }): JSX.Element {
  return (
    <section class="gallery-card">
      <header class="gallery-card-header">
        <h2 class="type-heading">{props.title}</h2>
        <p class="type-caption gallery-hint">{props.hint}</p>
      </header>
      <div class="gallery-card-body">{props.children}</div>
      <footer class="gallery-actions">{props.actions}</footer>
    </section>
  );
}

function RenameCard(): JSX.Element {
  const [names, setNames] = createSignal(['Untitled chat', 'auth.ts', 'Plan the Hub backend', 'Theme tokens', 'Usage popover', 'Loader morphs']);
  const [status, setStatus] = createSignal(statusLabels[0]);
  let renameIndex = 0;
  let statusIndex = 0;
  const timers: number[] = [];
  onCleanup(() => timers.forEach(timer => window.clearTimeout(timer)));

  const renameFirst = () => {
    renameIndex += 1;
    const next = pick(renameNames, renameIndex);
    setNames(list => [next === list[0] ? pick(renameNames, ++renameIndex) : next, ...list.slice(1)]);
  };
  const spam = () => {
    for (let index = 0; index < 5; index += 1) timers.push(window.setTimeout(renameFirst, index * 110));
  };
  const renameAll = () => {
    setNames(list => list.map((name, index) => (index % 2 === 0 ? `${name} v2` : name.replace(/ v2$/, '') + ' (copy)')));
  };
  const nextStatus = () => {
    statusIndex += 1;
    setStatus(pick(statusLabels, statusIndex));
  };

  return (
    <Card
      title="Rename"
      hint="Backspace to the shared prefix, beat, type. Click a row to finish at once."
      actions={
        <>
          <Button id="rename-one" variant="secondary" onClick={renameFirst}>Rename</Button>
          <Button id="rename-spam" variant="secondary" onClick={spam}>Spam</Button>
          <Button id="rename-all" variant="secondary" onClick={renameAll}>Rename all (scheduler)</Button>
          <Button id="status-next" variant="secondary" onClick={nextStatus}>Status</Button>
        </>
      }
    >
      <div class="gallery-tree">
        <Index each={names()}>
          {(name, index) => (
            <div class="gallery-row" tabIndex={0} data-motion={`rename-row-${index}`}>
              <span class="gallery-row-icon" />
              <span class="gallery-row-name type-body">
                <RetypeText value={name()} data-motion={`rename-text-${index}`} />
              </span>
              <span class="gallery-row-meta type-caption" data-motion={`rename-meta-${index}`}>2m</span>
            </div>
          )}
        </Index>
      </div>
      <div class="gallery-status type-label">
        <span class="gallery-status-dot" />
        <RetypeText value={status()} speed="fast" data-motion="status-label" />
        <span class="gallery-row-meta">12s</span>
      </div>
    </Card>
  );
}

interface Item {
  id: string;
  name: string;
}

function CreateDeleteCard(): JSX.Element {
  const [items, setItems] = createSignal<Item[]>([
    { id: 'a', name: 'App.tsx' },
    { id: 'b', name: 'bridge.ts' },
    { id: 'c', name: 'persist.ts' },
  ]);
  let created = 0;
  const create = () => {
    created += 1;
    const item = { id: `n${nextId++}`, name: pick(extraNames, created) };
    setItems(list => {
      const at = Math.min(list.length, 1 + (created % 3));
      return [...list.slice(0, at), item, ...list.slice(at)];
    });
  };
  const remove = () => setItems(list => (list.length ? list.filter((_, index) => index !== Math.min(1, list.length - 1)) : list));
  const spam = () => {
    create();
    window.setTimeout(create, 90);
    window.setTimeout(remove, 200);
    window.setTimeout(create, 260);
  };
  return (
    <Card
      title="Created and deleted"
      hint="New names type in while the row opens. Deleted names get a select-all sweep, then collapse."
      actions={
        <>
          <Button id="create" variant="secondary" onClick={create}>Create</Button>
          <Button id="delete" variant="secondary" onClick={remove}>Delete</Button>
          <Button id="create-spam" variant="secondary" onClick={spam}>Spam</Button>
        </>
      }
    >
      <OrganicList each={items()} key={item => item.id} class="gallery-tree">
        {(item, row) => (
          <div class="gallery-row" data-motion={`cd-row-${item().id}`}>
            <span class="gallery-row-icon" />
            <span class="gallery-row-name type-body">
              <RetypeText value={item().name} typeOnMount={row.created} deleting={row.leaving()} onDeleted={row.swept} />
            </span>
          </div>
        )}
      </OrganicList>
    </Card>
  );
}

function MoveCard(): JSX.Element {
  const [items, setItems] = createSignal<Item[]>([
    { id: 'm1', name: 'Fix login redirect' },
    { id: 'm2', name: 'Theme tokens' },
    { id: 'm3', name: 'Usage popover' },
    { id: 'm4', name: 'Hub registry' },
    { id: 'm5', name: 'Setup wizard' },
  ]);
  let turn = 0;
  const moveToTop = () => {
    turn += 1;
    setItems(list => {
      const from = list.length - 1 - (turn % 2);
      return [list[from], ...list.filter((_, index) => index !== from)];
    });
  };
  const swap = () => setItems(list => [list[1], list[0], ...list.slice(2)]);
  const spam = () => {
    moveToTop();
    window.setTimeout(moveToTop, 120);
    window.setTimeout(swap, 260);
  };
  return (
    <Card
      title="Moved"
      hint="The moved row lifts, travels like it was dragged, then settles. Neighbours just make room."
      actions={
        <>
          <Button id="move-top" variant="secondary" onClick={moveToTop}>Move to top</Button>
          <Button id="move-swap" variant="secondary" onClick={swap}>Swap</Button>
          <Button id="move-spam" variant="secondary" onClick={spam}>Spam</Button>
        </>
      }
    >
      <OrganicList each={items()} key={item => item.id} class="gallery-tree">
        {item => (
          <div class="gallery-row" data-motion={`move-row-${item().id}`}>
            <span class="gallery-row-icon" />
            <span class="gallery-row-name type-body">{item().name}</span>
            <span class="gallery-row-meta type-caption">now</span>
          </div>
        )}
      </OrganicList>
    </Card>
  );
}

function CounterCard(): JSX.Element {
  const [added, setAdded] = createSignal(12);
  const [removed, setRemoved] = createSignal(3);
  const [seconds, setSeconds] = createSignal(42);
  const [percent, setPercent] = createSignal(34);
  const [files, setFiles] = createSignal(8);
  const increment = () => {
    setAdded(value => value + 7);
    setRemoved(value => value + 1);
    setSeconds(value => value + 19);
    setPercent(value => Math.min(100, value + 9));
    setFiles(value => value + 3);
  };
  const decrement = () => {
    setAdded(value => Math.max(0, value - 9));
    setRemoved(value => Math.max(0, value - 2));
    setSeconds(value => Math.max(0, value - 25));
    setPercent(value => Math.max(0, value - 13));
    setFiles(value => Math.max(0, value - 4));
  };
  const big = () => {
    setAdded(value => (value < 100 ? value + 95 : value - 95));
    setPercent(value => (value < 50 ? 100 : 7));
    setSeconds(value => (value < 600 ? value + 600 : value - 600));
  };
  const spam = () => {
    for (let index = 0; index < 6; index += 1) window.setTimeout(index % 2 ? decrement : increment, index * 70);
  };
  const clock = () => `${Math.floor(seconds() / 60)}:${String(seconds() % 60).padStart(2, '0')}`;
  return (
    <Card
      title="Counters"
      hint="Digits roll like an odometer: up rolls up, down rolls down. Width follows new and lost digits."
      actions={
        <>
          <Button id="count-up" variant="secondary" onClick={increment}>Increment</Button>
          <Button id="count-down" variant="secondary" onClick={decrement}>Decrement</Button>
          <Button id="count-big" variant="secondary" onClick={big}>Add digits</Button>
          <Button id="count-spam" variant="secondary" onClick={spam}>Spam</Button>
        </>
      }
    >
      <div class="gallery-counters">
        <div class="gallery-counter">
          <span class="type-caption gallery-hint">Turn edits</span>
          <span class="type-label gallery-edits">
            <span class="gallery-add"><RollingNumber value={`+${added()}`} data-motion="counter-added" /></span>
            <span class="gallery-del"><RollingNumber value={`−${removed()}`} data-motion="counter-removed" /></span>
            <span class="gallery-row-meta">3 files</span>
          </span>
        </div>
        <div class="gallery-counter">
          <span class="type-caption gallery-hint">Elapsed</span>
          <span class="type-mono"><RollingNumber value={clock()} data-motion="counter-clock" /></span>
        </div>
        <div class="gallery-counter">
          <span class="type-caption gallery-hint">Usage</span>
          <span class="type-heading"><RollingNumber value={`${percent()}%`} data-motion="counter-percent" /></span>
        </div>
        <div class="gallery-counter">
          <span class="type-caption gallery-hint">Count</span>
          <span class="type-body"><RollingNumber value={`${files()} files`} data-motion="counter-files" /> changed</span>
        </div>
      </div>
    </Card>
  );
}

interface Line {
  id: string;
  text: string;
}

const startLines: Line[] = [
  { id: 'l1', text: 'export function retry(task, tries = 3) {' },
  { id: 'l2', text: '  let lastError;' },
  { id: 'l3', text: '  for (let i = 0; i < tries; i += 1) {' },
  { id: 'l4', text: '    try {' },
  { id: 'l5', text: '      return await task();' },
  { id: 'l6', text: '    } catch (error) {' },
  { id: 'l7', text: '      lastError = error;' },
  { id: 'l8', text: '    }' },
  { id: 'l9', text: '  }' },
  { id: 'l10', text: '  throw lastError;' },
  { id: 'l11', text: '}' },
];

const addedBlock = [
  '      const wait = 2 ** i * 100;',
  '      await sleep(wait);',
  '      log.warn(`retry ${i}`);',
];

function CodeCard(): JSX.Element {
  const [lines, setLines] = createSignal<Line[]>(startLines);
  const addLines = () => {
    setLines(list => {
      const at = list.findIndex(line => line.text.includes('lastError = error')) + 1 || list.length - 2;
      const block = addedBlock.map(text => ({ id: `x${nextId++}`, text }));
      return [...list.slice(0, at), ...block, ...list.slice(at)];
    });
  };
  const removeLines = () => {
    setLines(list => {
      const added = list.filter(line => line.id.startsWith('x'));
      if (added.length) return list.filter(line => !added.includes(line));
      return list.filter(line => line.id !== 'l2' && line.id !== 'l10');
    });
  };
  const replace = () => {
    setLines(list => {
      const at = list.findIndex(line => line.id === 'l5');
      if (at < 0) return [...startLines];
      return [...list.slice(0, at), { id: `x${nextId++}`, text: '      const result = await task();' }, { id: `x${nextId++}`, text: '      return result;' }, ...list.slice(at + 1)];
    });
  };
  const reset = () => setLines([...startLines]);
  const spam = () => {
    addLines();
    window.setTimeout(replace, 120);
    window.setTimeout(removeLines, 300);
  };
  return (
    <Card
      title="Code edits"
      hint="Removed lines: highlight sweep, then collapse. Added lines wipe in left to right; the caret rides the last one."
      actions={
        <>
          <Button id="code-add" variant="secondary" onClick={addLines}>Add lines</Button>
          <Button id="code-remove" variant="secondary" onClick={removeLines}>Remove lines</Button>
          <Button id="code-replace" variant="secondary" onClick={replace}>Replace line</Button>
          <Button id="code-reset" variant="secondary" onClick={reset}>Reset</Button>
          <Button id="code-spam" variant="secondary" onClick={spam}>Spam</Button>
        </>
      }
    >
      <div class="gallery-code type-mono">
        <EditedLines each={lines()} key={line => line.id} lineClass="gallery-code-line">
          {line => <span data-motion={`code-${line().id}`}>{line().text}</span>}
        </EditedLines>
      </div>
    </Card>
  );
}

const organicFeatures: { id: FeatureId; label: string }[] = [
  { id: 'motion.organic', label: 'Organic' },
  { id: 'motion.organic.rename', label: 'Rename' },
  { id: 'motion.organic.createDelete', label: 'Create/delete' },
  { id: 'motion.organic.move', label: 'Move' },
  { id: 'motion.organic.counters', label: 'Counters' },
  { id: 'motion.organic.codeEdits', label: 'Code edits' },
];

/**
 * DEV ONLY: feature toggles post `setUnifyFeature` like Settings does. The gallery bridge answers with
 * `unifyFeaturesState`; `feature()` turns reactive on that once store/index handles the message. Until then
 * the local `overrides` keep the switches clickable, and the animation keeps its default (on).
 */
function Controls(): JSX.Element {
  const [reduced, setReduced] = createSignal(false);
  const [overrides, setOverrides] = createSignal<Partial<Record<FeatureId, boolean>>>({});
  const featureOn = (id: FeatureId) => overrides()[id] ?? feature<boolean>(id);
  const toggleFeature = (id: FeatureId, value: boolean) => {
    setOverrides(current => ({ ...current, [id]: value }));
    setFeature(id, value);
  };
  const themeIds = Object.keys(themes) as ThemeId[];
  const nextTheme = () => setTheme(pick(themeIds, themeIds.indexOf(currentTheme()) + 1));
  return (
    <div class="gallery-controls">
      <label class="gallery-toggle type-label">
        <Toggle
          checked={reduced()}
          onChange={checked => {
            setReduced(checked);
            setAppReducedMotion(checked);
          }}
        />
        <span id="reduced-label">Reduced motion {prefersReducedMotion() ? '(on)' : ''}</span>
      </label>
      <For each={organicFeatures}>
        {entry => (
          <label
            class="gallery-toggle type-label"
            title="Posts setUnifyFeature; gating needs the store's unifyFeaturesState case."
          >
            <Toggle checked={featureOn(entry.id)} onChange={checked => toggleFeature(entry.id, checked)} />
            <span>{entry.label}</span>
          </label>
        )}
      </For>
      <Button id="theme-next" variant="text" onClick={nextTheme}>Theme: {currentTheme()}</Button>
    </div>
  );
}

function Gallery(): JSX.Element {
  return (
    <main class="gallery">
      <header class="gallery-header">
        <h1 class="type-title">Organic motion</h1>
        <Controls />
      </header>
      <div class="gallery-grid">
        <RenameCard />
        <CreateDeleteCard />
        <MoveCard />
        <CounterCard />
        <CodeCard />
      </div>
    </main>
  );
}

export function startGallery(root: HTMLElement): void {
  installTheme();
  const disconnect = render(() => <Gallery />, root);
  const stopListening = connectStore();
  import.meta.hot?.dispose(() => {
    stopListening();
    disconnect();
  });
}
