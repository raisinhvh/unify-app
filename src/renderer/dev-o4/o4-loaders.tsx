/**
 * DEV ONLY preview of loader morphs (components/loaders/morph.ts).
 *
 *   /dev-o4/o4-loaders.html?mode=film           filmstrips: each row settles on one shape, switches, and copies
 *                                               the drawing at fixed times (virtual clock, so frames repeat)
 *   /dev-o4/o4-loaders.html?mode=matrix         every from → to pair, 120 ms into the morph
 *   /dev-o4/o4-loaders.html?mode=live           real time, cells cycling through every pair
 *   /dev-o4/o4-loaders.html?mode=live&interrupt=1   the same, switching again mid-morph
 *   &theme=walnutLight
 *
 * Film and matrix replace performance.now / requestAnimationFrame with a virtual clock before any app module
 * loads, so springs and the loader clock only move when the page advances them. `window.__o4Ready` is set once
 * everything is drawn (the capture script waits for it).
 */
import type { LoaderShape } from '../components/loaders';
import type { ThemeId } from '../theme';

type Shape = LoaderShape | undefined;

interface FilmRow {
  from: Shape;
  to: Shape;
  /** Switch again `at` ms into the morph (an interrupt). */
  then?: { at: number; to: Shape };
}

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'film';
const frameStep = 1000 / 60;

/** Virtual clock: rAF callbacks run only inside __advance, on a 60 fps grid. */
function installVirtualClock(): (ms: number) => void {
  let now = 0;
  let nextHandle = 1;
  let queue = new Map<number, FrameRequestCallback>();
  performance.now = () => now;
  window.requestAnimationFrame = callback => {
    const handle = nextHandle;
    nextHandle += 1;
    queue.set(handle, callback);
    return handle;
  };
  window.cancelAnimationFrame = handle => {
    queue.delete(handle);
  };
  const advance = (ms: number) => {
    const steps = Math.max(0, Math.round(ms / frameStep));
    for (let index = 0; index < steps; index += 1) {
      now += frameStep;
      const callbacks = queue;
      queue = new Map();
      for (const callback of callbacks.values()) callback(now);
    }
  };
  (window as unknown as { __advance: (ms: number) => void }).__advance = advance;
  return advance;
}

const advance = mode === 'live' ? undefined : installVirtualClock();

const filmRows: FilmRow[] = [
  { from: 'quad', to: 'trace' },
  { from: 'sift', to: 'splice' },
  { from: 'pixels', to: 'develop' },
  { from: 'fill', to: 'lay' },
  { from: 'knock', to: 'checks' },
  { from: 'relay', to: 'press' },
  { from: 'shelve', to: 'split' },
  { from: 'pull', to: 'quad' },
  { from: 'trace', to: 'done' },
  { from: 'lay', to: undefined },
  { from: undefined, to: 'sift' },
  { from: 'done', to: 'relay' },
  { from: 'quad', to: 'sift', then: { at: 120, to: 'trace' } },
];

const filmTimes = [0, 33, 67, 100, 150, 200, 267, 350, 500];
const interruptTimes = [0, 50, 100, 133, 167, 200, 267, 350, 500, 700];

const label = (shape: Shape) => shape ?? 'idle';

async function boot(): Promise<void> {
  const { installMockBridge } = await import('../dev/mockBridge');
  await installMockBridge();
  const [{ render }, { createSignal, For, onCleanup }, loaders, theme] = await Promise.all([
    import('solid-js/web'),
    import('solid-js'),
    import('../components/loaders'),
    import('../theme'),
  ]);
  await import('./o4-preview.css');
  theme.installTheme();
  const themeName = params.get('theme');
  if (themeName) theme.setTheme(themeName as ThemeId);

  const shapes: Shape[] = [undefined, ...loaders.loaderInfo.map(info => info.id), 'done'];
  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing');

  if (mode === 'live') {
    const interrupt = params.get('interrupt') === '1';
    const LiveCell = (props: { offset: number }) => {
      const [index, setIndex] = createSignal(props.offset % shapes.length);
      // Each cell walks the shape list with a different stride, so together they visit every pair.
      const stride = 1 + (props.offset % (shapes.length - 1));
      const timer = window.setInterval(() => {
        setIndex(current => (current + stride) % shapes.length);
      }, interrupt ? 140 + props.offset * 23 : 900 + props.offset * 40);
      onCleanup(() => window.clearInterval(timer));
      return (
        <div class="o4-live-cell">
          <div class="o4-frame-cell">
            <loaders.Loader id={shapes[index()]} size={64} class={`o4-live-loader-${props.offset}`} />
          </div>
          <span class="o4-frame-time">{label(shapes[index()])}</span>
        </div>
      );
    };
    render(
      () => (
        <div class="o4-page">
          <div class="o4-title">Live morphs{interrupt ? ', rapid interrupts' : ''}</div>
          <div class="o4-live">
            <For each={[0, 1, 2, 3, 4, 5, 6, 7]}>{offset => <LiveCell offset={offset} />}</For>
          </div>
        </div>
      ),
      root,
    );
    (window as unknown as { __o4Ready: boolean }).__o4Ready = true;
    return;
  }

  const tick = advance as (ms: number) => void;
  const [stageShape, setStageShape] = createSignal<Shape>(undefined);
  let stage!: HTMLDivElement;
  const page = document.createElement('div');
  page.className = 'o4-page';
  render(
    () => (
      <div ref={stage} class="o4-stage">
        <loaders.Loader id={stageShape()} size={64} />
      </div>
    ),
    root,
  );
  root.appendChild(page);

  const copyDrawing = (size: number): Element => {
    const svg = stage.querySelector('svg');
    if (!svg) throw new Error('stage has no svg');
    const copy = svg.cloneNode(true) as SVGSVGElement;
    copy.setAttribute('width', String(size));
    copy.setAttribute('height', String(size));
    return copy;
  };

  const settleOn = (shape: Shape) => {
    setStageShape(shape);
    tick(1500);
  };

  if (mode === 'matrix') {
    const title = document.createElement('div');
    title.className = 'o4-title';
    title.textContent = 'Every pair, 120 ms into the morph (rows: from, columns: to)';
    page.appendChild(title);
    const grid = document.createElement('div');
    grid.className = 'o4-matrix';
    grid.style.gridTemplateColumns = `repeat(${shapes.length + 1}, 34px)`;
    page.appendChild(grid);
    const head = (text: string) => {
      const cell = document.createElement('div');
      cell.className = 'o4-matrix-head';
      cell.textContent = text;
      grid.appendChild(cell);
    };
    head('');
    for (const shape of shapes) head(label(shape));
    for (const from of shapes) {
      head(label(from));
      for (const to of shapes) {
        settleOn(from);
        setStageShape(to);
        tick(120);
        const cell = document.createElement('div');
        cell.className = 'o4-matrix-cell';
        cell.appendChild(copyDrawing(28));
        grid.appendChild(cell);
      }
    }
    (window as unknown as { __o4Ready: boolean }).__o4Ready = true;
    return;
  }

  const rowsParam = params.get('rows');
  const rows = rowsParam
    ? rowsParam.split(',').map(index => filmRows[Number(index)]).filter(Boolean)
    : filmRows;
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'o4-row';
    const name = document.createElement('div');
    name.className = 'o4-row-label';
    name.textContent = row.then
      ? `${label(row.from)} → ${label(row.to)} → ${label(row.then.to)} @${row.then.at}`
      : `${label(row.from)} → ${label(row.to)}`;
    line.appendChild(name);
    page.appendChild(line);

    settleOn(row.from);
    setStageShape(row.to);
    const times = row.then ? interruptTimes : filmTimes;
    let elapsed = 0;
    let switched = false;
    for (const time of times) {
      if (row.then && !switched && time >= row.then.at) {
        tick(row.then.at - elapsed);
        elapsed = row.then.at;
        setStageShape(row.then.to);
        switched = true;
      }
      tick(time - elapsed);
      elapsed = time;
      const frame = document.createElement('div');
      frame.className = 'o4-frame';
      const cell = document.createElement('div');
      cell.className = 'o4-frame-cell';
      cell.appendChild(copyDrawing(48));
      const stamp = document.createElement('span');
      stamp.className = 'o4-frame-time';
      stamp.textContent = `${time} ms`;
      frame.append(cell, stamp);
      line.appendChild(frame);
    }
  }
  (window as unknown as { __o4Ready: boolean }).__o4Ready = true;
}

void boot();
