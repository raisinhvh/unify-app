/**
 * The 15 Unify loaders (Figma "02 · Loaders", 306:4857). One per action, so you can tell what an agent is doing
 * at a glance. Each is a LoaderFrame: time in seconds → cells in a 16×16 box. Wood only: bright cells are
 * --wood-light, dim cells --loader-dim.
 */
import { cell, gridCell, mix, phase, pulse, smooth, span, type LoaderCell, type LoaderFrame } from './cells';

export type LoaderId =
  | 'quad'
  | 'trace'
  | 'fill'
  | 'pixels'
  | 'sift'
  | 'splice'
  | 'lay'
  | 'checks'
  | 'pull'
  | 'split'
  | 'relay'
  | 'knock'
  | 'press'
  | 'shelve'
  | 'develop';

/** 01 Quad · Planning. One tile of a 2×2 grid steps clockwise. */
const quad: LoaderFrame = seconds => {
  const corners = ['g0', 'g2', 'g8', 'g6'];
  const positions = [
    [1.5, 1.5],
    [9, 1.5],
    [9, 9],
    [1.5, 9],
  ];
  const step = phase(seconds, 1.6) * 4;
  return corners.map((key, index) => {
    const distance = (step - index + 4) % 4;
    const tone = distance < 1 ? 1 - smooth(distance) * 0.15 : Math.max(0, 1 - smooth(distance - 0.6) * 1.4);
    return cell(key, positions[index][0], positions[index][1], 5.5, 5.5, Math.max(0, Math.min(1, tone)), { radius: 1 });
  });
};

/** 02 Trace · Thinking. A segment runs around a square outline. */
const trace: LoaderFrame = seconds => {
  const inset = 2;
  const size = 12;
  const perimeter = size * 4;
  const length = 6;
  const head = phase(seconds, 1.4) * perimeter;
  const cells: LoaderCell[] = [cell('frame', inset, inset, size, size, 0, { outline: true, radius: 1 })];
  // Split the segment where it turns a corner so each piece stays a straight rectangle.
  const pieces: [number, number][] = [];
  let start = head - length;
  while (start < head) {
    const sideEnd = Math.floor(start / size + 1) * size;
    const end = Math.min(head, sideEnd);
    pieces.push([start, end]);
    start = end;
  }
  pieces.slice(-2).forEach(([from, to], index) => {
    const wrapped = ((from % perimeter) + perimeter) % perimeter;
    const side = Math.floor(wrapped / size);
    const along = wrapped - side * size;
    const extent = to - from;
    const thickness = 1.5;
    const edge = inset - thickness / 2 + 0.5;
    const far = inset + size - thickness / 2 - 0.5;
    let rect: [number, number, number, number];
    if (side === 0) rect = [inset + along, edge, extent, thickness];
    else if (side === 1) rect = [far, inset + along, thickness, extent];
    else if (side === 2) rect = [inset + size - along - extent, far, extent, thickness];
    else rect = [edge, inset + size - along - extent, thickness, extent];
    cells.push(cell(`segment${index}`, rect[0], rect[1], rect[2], rect[3], 1));
  });
  return cells;
};

/** 03 Fill · Loading. A square fills from the bottom like stain soaking in. */
const fill: LoaderFrame = seconds => {
  const progress = phase(seconds, 1.8);
  const level = progress < 0.75 ? span(progress, 0, 0.75) : 1;
  const fade = progress < 0.85 ? 1 : 1 - span(progress, 0.85, 1);
  const height = 12 * level;
  return [
    cell('box', 2, 2, 12, 12, 0, { radius: 1.5 }),
    cell('fill', 2, 14 - height, 12, height, 1, { radius: 1.5, opacity: fade }),
  ];
};

/** 04 Pixels · any other tool. Three pixels pass a light along. */
const pixels: LoaderFrame = seconds => {
  const light = phase(seconds, 1.2) * 4 - 0.5;
  return [0, 1, 2].map(index => cell(`p${index}`, 1.5 + index * 4.75, 6.5, 3, 3, pulse(light - index, 1.2), { radius: 0.5 }));
};

/** 05 Sift · Finding files. Matches blink on across a 3×3 grid. */
const siftPatterns = [
  [0, 4, 7],
  [2, 3, 8],
  [1, 5, 6],
  [0, 5, 7],
  [2, 4, 6],
];
const sift: LoaderFrame = seconds => {
  const step = phase(seconds, siftPatterns.length * 0.4) * siftPatterns.length;
  const current = siftPatterns[Math.floor(step)];
  const local = step - Math.floor(step);
  const strength = local < 0.3 ? span(local, 0, 0.3) : 1 - span(local, 0.7, 1);
  return Array.from({ length: 9 }, (_, index) => {
    const { x, y } = gridCell(index);
    return cell(`g${index}`, x, y, 3.5, 3.5, current.includes(index) ? strength : 0, { radius: 0.5 });
  });
};

/** 06 Splice · Editing. A line parts and a new block drops into the gap. */
const splice: LoaderFrame = seconds => {
  const progress = phase(seconds, 1.6);
  const open = progress < 0.25 ? span(progress, 0, 0.25) : progress < 0.75 ? 1 : 1 - span(progress, 0.75, 0.95);
  const drop = span(progress, 0.25, 0.55);
  const gap = 4 * open;
  const settled = progress > 0.75;
  const blockWidth = settled ? 4 * open : 3;
  return [
    cell('l0', 1, 7.25, 6.5 - gap / 2, 1.5, 0.35),
    cell('l1', 8.5 + gap / 2, 7.25, 6.5 - gap / 2, 1.5, 0.35),
    cell('block', 8 - blockWidth / 2, mix(1.5, 7.25, drop), blockWidth, 1.5, 1, { opacity: progress < 0.25 ? span(progress, 0.1, 0.25) : 1 }),
  ];
};

/** 07 Lay · Writing. Lines lay down one after another. */
const lay: LoaderFrame = seconds => {
  const progress = phase(seconds, 2);
  const widths = [8, 12, 10, 6];
  const fade = progress < 0.85 ? 1 : 1 - span(progress, 0.85, 1);
  return widths.map((width, index) => {
    const grow = span(progress, index * 0.18, index * 0.18 + 0.16);
    const newest = progress >= index * 0.18 && progress < (index + 1) * 0.18 + 0.05;
    return cell(`l${index}`, 2, 2.5 + index * 3.25, width * grow, 1.5, newest ? 1 : 0.45, { opacity: fade });
  });
};

/** 08 Checks · Testing. A checklist ticks off row by row. */
const checks: LoaderFrame = seconds => {
  const progress = phase(seconds, 2);
  const cells: LoaderCell[] = [];
  for (let index = 0; index < 3; index += 1) {
    const ticked = span(progress, 0.1 + index * 0.22, 0.2 + index * 0.22) * (progress < 0.9 ? 1 : 1 - span(progress, 0.9, 1));
    const y = 2.5 + index * 4.25;
    cells.push(cell(`box${index}`, 1.5, y, 3, 3, ticked, { outline: ticked < 0.5, radius: 0.5 }));
    cells.push(cell(`l${index}`, 6.5, y + 0.75, 8, 1.5, 0.3 + ticked * 0.4));
  }
  return cells;
};

/** 09 Pull · Downloading. A pixel falls into a filling bar. */
const pull: LoaderFrame = seconds => {
  const cycle = 3;
  const progress = phase(seconds, 0.7 * cycle);
  const drop = (progress * cycle) % 1;
  const landed = Math.floor(progress * cycle) + span(drop, 0.65, 0.8);
  const width = (12 * landed) / cycle;
  return [
    cell('bar', 2, 12.5, 12, 1.5, 0),
    cell('fill', 2, 12.5, width, 1.5, 1),
    cell('drop', 7, mix(1.5, 10.5, span(drop, 0, 0.65)), 2, 2, 1, { opacity: drop < 0.7 ? 1 : 1 - span(drop, 0.7, 0.8) }),
  ];
};

/** 10 Split · Spawning. One square splits into two, then four. */
const split: LoaderFrame = seconds => {
  const progress = phase(seconds, 2);
  const two = span(progress, 0.15, 0.35);
  const four = span(progress, 0.5, 0.7);
  const back = span(progress, 0.85, 1);
  const size = mix(mix(6, 4.5, two), 6, back);
  const half = size / 2;
  const spreadX = mix(mix(0, 3, two), 0, back);
  const spreadY = mix(mix(0, 3, four), 0, back);
  const keys = ['g0', 'g2', 'g6', 'g8'];
  const signs = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  return keys.map((key, index) => {
    const [signX, signY] = signs[index];
    return cell(key, 8 + signX * spreadX - half, 8 + signY * spreadY - half, size, size, 1, { radius: 1 });
  });
};

/** 11 Relay · Delegating. A pixel passes between two squares. */
const relay: LoaderFrame = seconds => {
  const progress = phase(seconds, 1.6);
  const outward = progress < 0.5;
  const travel = outward ? span(progress, 0.05, 0.45) : 1 - span(progress, 0.55, 0.95);
  const arriveRight = outward ? span(progress, 0.4, 0.5) : 1 - span(progress, 0.5, 0.6);
  return [
    cell('a', 1, 6, 4, 4, 1 - arriveRight * 0.6, { radius: 0.75 }),
    cell('b', 11, 6, 4, 4, 0.4 + arriveRight * 0.6, { radius: 0.75 }),
    cell('pixel', mix(6, 8.5, travel), 7.25, 1.5, 1.5, 1),
  ];
};

/** 12 Knock · Needs you. Two knocks, then a rest. */
const knock: LoaderFrame = seconds => {
  const progress = phase(seconds, 1.6);
  const hit = pulse(progress - 0.06, 0.06) + pulse(progress - 0.22, 0.06);
  const grow = Math.min(1, hit) * 1.25;
  const size = 5 + grow;
  return [
    cell('frame', 2, 2, 12, 12, 0.6, { outline: true, radius: 1.5 }),
    cell('inner', 8 - size / 2, 8 - size / 2, size, size, 0.55 + Math.min(1, hit) * 0.45, { radius: 0.75 }),
  ];
};

/** 13 Press · Compacting. Three lines press into one. */
const press: LoaderFrame = seconds => {
  const progress = phase(seconds, 1.8);
  const squeeze = progress < 0.5 ? span(progress, 0.1, 0.45) : 1 - span(progress, 0.8, 1);
  return [0, 1, 2].map(index => {
    const spreadY = 4 + (index - 1) * 4 * (1 - squeeze);
    const height = mix(1.5, 3, squeeze);
    return cell(`l${index}`, 2, spreadY + 3.25 - height / 2, 12, height, mix(0.55, 1, squeeze));
  });
};

/** 14 Shelve · Remembering. A book slides onto the shelf. */
const shelve: LoaderFrame = seconds => {
  const progress = phase(seconds, 2);
  const slide = span(progress, 0.15, 0.55);
  const fade = progress < 0.85 ? 1 : 1 - span(progress, 0.85, 1);
  return [
    cell('shelf', 1, 13, 14, 1, 0.45),
    cell('b0', 2.5, 6, 2, 7, 0.5),
    cell('b1', 5, 5, 2, 8, 0.5),
    cell('b2', 7.5, 7, 2, 6, 0.5),
    cell('b3', mix(16, 10, slide), 5.5, 2, 7.5, 1, { opacity: fade * Math.min(1, slide * 3) }),
  ];
};

/** 15 Develop · Imaging. Pixels resolve like a print developing. */
const developOrder = [4, 0, 8, 2, 6, 1, 7, 3, 5];
const develop: LoaderFrame = seconds => {
  const progress = phase(seconds, 2.2);
  const fade = progress < 0.85 ? 1 : 1 - span(progress, 0.85, 1);
  return Array.from({ length: 9 }, (_, index) => {
    const order = developOrder.indexOf(index);
    const resolved = span(progress, 0.05 + order * 0.07, 0.2 + order * 0.07) * fade;
    const { x, y } = gridCell(index);
    return cell(`g${index}`, x, y, 3.5, 3.5, resolved, { radius: 0.5 });
  });
};

export const loaders: Record<LoaderId, LoaderFrame> = {
  quad,
  trace,
  fill,
  pixels,
  sift,
  splice,
  lay,
  checks,
  pull,
  split,
  relay,
  knock,
  press,
  shelve,
  develop,
};

/** Display order and names (Figma). */
export const loaderInfo: { id: LoaderId; name: string; action: string }[] = [
  { id: 'quad', name: 'Quad', action: 'Planning' },
  { id: 'trace', name: 'Trace', action: 'Thinking' },
  { id: 'fill', name: 'Fill', action: 'Loading' },
  { id: 'pixels', name: 'Pixels', action: 'Working' },
  { id: 'sift', name: 'Sift', action: 'Finding files' },
  { id: 'splice', name: 'Splice', action: 'Editing' },
  { id: 'lay', name: 'Lay', action: 'Writing' },
  { id: 'checks', name: 'Checks', action: 'Testing' },
  { id: 'pull', name: 'Pull', action: 'Downloading' },
  { id: 'split', name: 'Split', action: 'Spawning' },
  { id: 'relay', name: 'Relay', action: 'Delegating' },
  { id: 'knock', name: 'Knock', action: 'Needs you' },
  { id: 'press', name: 'Press', action: 'Compacting' },
  { id: 'shelve', name: 'Shelve', action: 'Remembering' },
  { id: 'develop', name: 'Develop', action: 'Imaging' },
];
