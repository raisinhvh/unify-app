#!/usr/bin/env node
// Audits UI motion quality in a web or Electron UI by sampling the live DOM over CDP.
// Usage:
//   node .dsh/tools/motion-audit.mjs --url <http url | local html> [--scenario steps.json]
//       [--watch "css,selectors"] [--out <dir>] [--width 1280] [--height 800] [--scale 1]
//       [--settle 800] [--max-duration 700] [--json]
//   node .dsh/tools/motion-audit.mjs --attach <port> [--scenario steps.json] [--out <dir>]
//   node .dsh/tools/motion-audit.mjs --electron <electron.exe> [--app <app dir>]
//       [--url <url>] [--scenario steps.json] [--out <dir>]
// Finds Edge or Chrome like .dsh/tools/sidebar-preview.mjs, drives it headlessly, records DOM
// geometry/opacity/colour plus screencast frames, then writes report.json, report.md,
// filmstrip.png and curves.png. Exit code is 1 when any error-severity issue is found.
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const TOOL_VERSION = 1;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const DEFAULT_SETTLE_MS = 800;
const DEFAULT_MAX_DURATION_MS = 700;
const MAX_TRACKED_ELEMENTS = 600;
const MAX_SAMPLES_PER_ELEMENT = 1500;
const MAX_FRAME_TIMES = 5400;
const MAX_MUTATIONS = 3000;
const MAX_TARGET_DESCENDANTS = 80;
const MAX_SCREENSHOT_FRAMES = 90;
const SCREENSHOT_INTERVAL_MS = 110;
const FILMSTRIP_FRAME_LIMIT = 30;
const MAX_ISSUES_PER_RULE = 24;
const MAX_MOTIONS_IN_TABLE = 40;
const MAX_CURVES = 8;
const MERGE_WINDOW_MS = 100;
const MIN_MOTION_DURATION_MS = 55;
const MOTION_GAP_MS = 100;
const SNAP_POSITION_PX = 3;
const SNAP_SIZE_PX = 3;
const SNAP_OPACITY = 0.2;
const SNAP_SCALE = 0.05;
const SNAP_COLOR_DISTANCE = 20;
const LATE_FEEDBACK_MS = 50;
const JANK_FRAME_MS = 25;
const WOBBLE_REVERSALS = 2;
const WOBBLE_OVERSHOOT_PERCENT = 12;
const WOBBLE_LARGE_ELEMENT_PX = 200;
const LINEAR_FLATNESS_CV = 0.2;
const LINEAR_MIN_DURATION_MS = 180;
const RESTART_JUMP_FACTOR = 1.5;
// Sub-pixel rendering and layout rounding create noise below this; keep it above
// one device pixel so spring tails are not stitched into a single endless motion.
const MOTION_POSITION_EPSILON_PX = 0.5;
const MOTION_OPACITY_EPSILON = 0.006;
const MOTION_SCALE_EPSILON = 0.002;
const MOTION_MIN_TRAVEL_PX = 2;

const MOTION_PROPERTIES = [
  {
    key: 'cx',
    label: 'x position',
    unit: 'px',
    epsilon: MOTION_POSITION_EPSILON_PX,
    minTravel: MOTION_MIN_TRAVEL_PX,
  },
  {
    key: 'cy',
    label: 'y position',
    unit: 'px',
    epsilon: MOTION_POSITION_EPSILON_PX,
    minTravel: MOTION_MIN_TRAVEL_PX,
  },
  {
    key: 'w',
    label: 'width',
    unit: 'px',
    epsilon: MOTION_POSITION_EPSILON_PX,
    minTravel: MOTION_MIN_TRAVEL_PX,
  },
  {
    key: 'h',
    label: 'height',
    unit: 'px',
    epsilon: MOTION_POSITION_EPSILON_PX,
    minTravel: MOTION_MIN_TRAVEL_PX,
  },
  {
    key: 'opacity',
    label: 'opacity',
    unit: '',
    epsilon: MOTION_OPACITY_EPSILON,
    minTravel: 0.03,
  },
  {
    key: 'scaleX',
    label: 'scale x',
    unit: '',
    epsilon: MOTION_SCALE_EPSILON,
    minTravel: 0.02,
  },
  {
    key: 'scaleY',
    label: 'scale y',
    unit: '',
    epsilon: MOTION_SCALE_EPSILON,
    minTravel: 0.02,
  },
];

const LAYOUT_PROPERTIES = [
  {
    key: 'ow',
    label: 'width (layout)',
    unit: 'px',
    epsilon: MOTION_POSITION_EPSILON_PX,
    minTravel: MOTION_MIN_TRAVEL_PX,
  },
  {
    key: 'oh',
    label: 'height (layout)',
    unit: 'px',
    epsilon: MOTION_POSITION_EPSILON_PX,
    minTravel: MOTION_MIN_TRAVEL_PX,
  },
  {
    key: 'ox',
    label: 'left (layout)',
    unit: 'px',
    epsilon: MOTION_POSITION_EPSILON_PX,
    minTravel: MOTION_MIN_TRAVEL_PX,
  },
  {
    key: 'oy',
    label: 'top (layout)',
    unit: 'px',
    epsilon: MOTION_POSITION_EPSILON_PX,
    minTravel: MOTION_MIN_TRAVEL_PX,
  },
];

const BROWSER_CANDIDATES = [
  process.env.MOTION_AUDIT_BROWSER,
  process.env.EDGE_PATH,
  process.env.CHROME_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const KEY_CODES = {
  Escape: 27,
  Enter: 13,
  Tab: 9,
  Backspace: 8,
  Delete: 46,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  Space: 32,
};

let activeSession = null;
let handlingSignal = false;

function printUsage() {
  console.error(
    'Usage: node .dsh/tools/motion-audit.mjs --url <url|file> [--scenario steps.json] ' +
      '[--watch "css,selectors"] [--out <dir>] [--json]\n' +
      '       node .dsh/tools/motion-audit.mjs --attach <port> [--scenario steps.json]\n' +
      '       node .dsh/tools/motion-audit.mjs --electron <electron.exe> [--app <dir>] [--url <url>]',
  );
}

function parseArguments(argv) {
  const options = {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    scale: 1,
    settle: DEFAULT_SETTLE_MS,
    maxDuration: DEFAULT_MAX_DURATION_MS,
    json: false,
    watch: [],
    thresholds: {
      snapPositionPx: SNAP_POSITION_PX,
      snapSizePx: SNAP_SIZE_PX,
      snapOpacity: SNAP_OPACITY,
      snapScale: SNAP_SCALE,
      snapColor: SNAP_COLOR_DISTANCE,
      lateFeedbackMs: LATE_FEEDBACK_MS,
      jankMs: JANK_FRAME_MS,
      wobbleReversals: WOBBLE_REVERSALS,
      wobbleOvershootPercent: WOBBLE_OVERSHOOT_PERCENT,
      maxIssuesPerRule: MAX_ISSUES_PER_RULE,
    },
  };
  const valueOptions = new Set([
    'url',
    'scenario',
    'watch',
    'out',
    'width',
    'height',
    'scale',
    'settle',
    'max-duration',
    'attach',
    'electron',
    'app',
    'late-ms',
    'jank-ms',
    'snap-px',
    'snap-opacity',
    'snap-scale',
    'max-issues',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === '--json') {
      options.json = true;
      continue;
    }
    if (!raw.startsWith('--')) {
      throw new Error(`Unexpected argument: ${raw}`);
    }
    const name = raw.slice(2);
    if (!valueOptions.has(name)) {
      throw new Error(`Unknown option: ${raw}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Option ${raw} needs a value.`);
    }
    index += 1;
    if (name === 'url') options.url = value;
    else if (name === 'scenario') options.scenario = value;
    else if (name === 'watch') options.watch = value.split(',').map(part => part.trim()).filter(Boolean);
    else if (name === 'out') options.out = value;
    else if (name === 'attach') options.attach = Number(value);
    else if (name === 'electron') options.electron = value;
    else if (name === 'app') options.app = value;
    else if (name === 'late-ms') options.thresholds.lateFeedbackMs = Number(value);
    else if (name === 'jank-ms') options.thresholds.jankMs = Number(value);
    else if (name === 'snap-px') options.thresholds.snapPositionPx = Number(value);
    else if (name === 'snap-opacity') options.thresholds.snapOpacity = Number(value);
    else if (name === 'snap-scale') options.thresholds.snapScale = Number(value);
    else if (name === 'max-issues') options.thresholds.maxIssuesPerRule = Number(value);
    else if (name === 'max-duration') options.maxDuration = Number(value);
    else if (name === 'settle') options.settle = Number(value);
    else if (name === 'width') options.width = Number(value);
    else if (name === 'height') options.height = Number(value);
    else if (name === 'scale') options.scale = Number(value);
  }
  if (!Number.isFinite(options.width) || options.width < 100) throw new Error('--width must be at least 100.');
  if (!Number.isFinite(options.height) || options.height < 100) throw new Error('--height must be at least 100.');
  if (!Number.isFinite(options.scale) || options.scale <= 0) throw new Error('--scale must be positive.');
  if (!Number.isFinite(options.settle) || options.settle < 0) throw new Error('--settle must be non-negative.');
  if (!Number.isFinite(options.maxDuration) || options.maxDuration <= 0) {
    throw new Error('--max-duration must be positive.');
  }
  if (options.attach !== undefined && (!Number.isInteger(options.attach) || options.attach <= 0)) {
    throw new Error('--attach needs a positive port.');
  }
  if (!options.url && options.attach === undefined && !options.electron) {
    throw new Error('Provide --url, --attach <port> or --electron <path>.');
  }
  if (options.attach !== undefined && options.electron) {
    throw new Error('Use either --attach or --electron, not both.');
  }
  if (options.app && !options.electron) {
    throw new Error('--app is only used with --electron.');
  }
  return options;
}

function resolveTargetUrl(input) {
  if (!input) return null;
  if (/^(https?|file|data|about):/i.test(input)) return input;
  const absolute = resolve(input);
  if (!existsSync(absolute)) {
    throw new Error(`Local HTML file not found: ${absolute}`);
  }
  return pathToFileURL(absolute).href;
}

function findBrowserExecutable() {
  const found = BROWSER_CANDIDATES.filter(Boolean).find(candidate => existsSync(candidate));
  if (!found) {
    throw new Error('No Edge or Chrome found. Set MOTION_AUDIT_BROWSER or CHROME_PATH.');
  }
  return found;
}

function formatError(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function loadScenario(path) {
  if (!path) return null;
  const fullPath = resolve(path);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(fullPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Could not read scenario ${fullPath}: ${error.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Scenario must be a JSON array of steps.');
  }
  for (const [index, step] of parsed.entries()) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error(`Scenario step ${index} must be an object.`);
    }
    const known = ['wait', 'hover', 'down', 'up', 'click', 'move', 'drag', 'key', 'type', 'eval', 'mark'];
    if (!known.some(key => key in step)) {
      throw new Error(`Scenario step ${index} has no known action.`);
    }
  }
  return parsed;
}

function buildRecorderSource(options) {
  const config = {
    watchSelectors: options.watch,
    maxTrackedElements: MAX_TRACKED_ELEMENTS,
    maxSamplesPerElement: MAX_SAMPLES_PER_ELEMENT,
    maxFrameTimes: MAX_FRAME_TIMES,
    maxMutations: MAX_MUTATIONS,
    maxTargetDescendants: MAX_TARGET_DESCENDANTS,
  };
  return `(${recorderMain.toString()})(${JSON.stringify(config)});`;
}

function recorderMain(config) {
  if (window.__motionAudit && window.__motionAudit.version === 1) return;

  const idByElement = new WeakMap();
  const structuralKeyByElement = new WeakMap();
  const tracked = new Map();
  const errors = [];
  const frames = [];
  const steps = [];
  const mutations = [];
  const directIds = new Set();

  let nextId = 1;
  let nextStructuralKey = 1;
  let trackedMode = 'data-motion';
  let observer = null;
  let frameRequest = 0;
  let stopped = false;
  let truncatedElements = 0;
  const startedAt = performance.now();

  function structuralKey(element) {
    if (!element) return null;
    let key = structuralKeyByElement.get(element);
    if (!key) {
      key = nextStructuralKey;
      nextStructuralKey += 1;
      structuralKeyByElement.set(element, key);
    }
    return key;
  }

  function matchesWatchSelector(element) {
    return config.watchSelectors.some(selector => {
      try {
        return element.matches(selector);
      } catch (error) {
        if (!errors.some(entry => entry.message === `Bad watch selector: ${selector}`)) {
          errors.push({ message: `Bad watch selector: ${selector}`, detail: String(error) });
        }
        return false;
      }
    });
  }

  function isCandidate(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (config.watchSelectors.length > 0) return matchesWatchSelector(element);
    if (trackedMode === 'data-motion') return element.hasAttribute('data-motion');
    return isVisibleNow(element);
  }

  function isVisibleNow(element) {
    if (!element.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function priorityForElement(element) {
    if (element.matches('button, a, input, select, textarea, summary, [role], [tabindex]')) return 0;
    if (element.matches('img, svg, canvas, video')) return 1;
    if (element.children.length === 0 || (element.textContent || '').trim().length > 0) return 2;
    return 3;
  }

  function shortText(element) {
    const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > 30 ? `${text.slice(0, 27)}...` : text;
  }

  function labelFor(element) {
    let label = element.tagName.toLowerCase();
    if (element.id) label += `#${element.id}`;
    const classes = Array.from(element.classList).slice(0, 3);
    if (classes.length > 0) label += `.${classes.join('.')}`;
    const name = element.getAttribute('data-motion') || element.getAttribute('aria-label') || shortText(element);
    return name ? `${label} "${name}"` : label;
  }

  function trackElement(element, discovery = 'interaction') {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    if (idByElement.has(element)) return tracked.get(idByElement.get(element));
    if (tracked.size >= config.maxTrackedElements && trackedMode === 'visible') return null;
    const id = nextId;
    nextId += 1;
    const record = {
      el: element,
      id,
      label: labelFor(element),
      tag: element.tagName.toLowerCase(),
      discovery,
      firstSeen: performance.now(),
      parentKey: element.parentElement ? structuralKey(element.parentElement) : null,
      parentId: element.parentElement && idByElement.has(element.parentElement)
        ? idByElement.get(element.parentElement)
        : null,
      samples: [],
      truncated: false,
    };
    idByElement.set(element, id);
    tracked.set(id, record);
    return record;
  }

  function trackTree(rootElement, limit) {
    const records = [];
    if (!rootElement) return records;
    const rootRecord = trackElement(rootElement, 'interaction');
    if (rootRecord) records.push(rootRecord);
    const descendants = rootElement.querySelectorAll('*');
    for (const child of descendants) {
      if (records.length >= limit) break;
      const record = trackElement(child, 'interaction');
      if (record) records.push(record);
    }
    return records;
  }

  function trackAncestors(element) {
    const records = [];
    let current = element.parentElement;
    let depth = 0;
    while (current && current !== document.body && depth < 5) {
      const record = trackElement(current, 'interaction');
      if (record) records.push(record);
      current = current.parentElement;
      depth += 1;
    }
    return records;
  }

  function scanAddedNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (isCandidate(node)) trackElement(node, 'mutation');
    if (trackedMode === 'visible' && !isCandidate(node)) {
      const children = node.querySelectorAll('*');
      for (const child of children) {
        if (tracked.size >= config.maxTrackedElements) break;
        if (isCandidate(child)) trackElement(child, 'mutation');
      }
      return;
    }
    const descendants = node.querySelectorAll('*');
    for (const descendant of descendants) {
      if (isCandidate(descendant)) trackElement(descendant, 'mutation');
    }
  }

  function initialScan() {
    if (config.watchSelectors.length > 0) {
      trackedMode = 'watch';
      for (const selector of config.watchSelectors) {
        let nodes;
        try {
          nodes = document.querySelectorAll(selector);
        } catch (error) {
          errors.push({ message: `Bad watch selector: ${selector}`, detail: String(error) });
          continue;
        }
        for (const node of nodes) trackElement(node, 'initial');
      }
      return;
    }
    if (document.querySelector('[data-motion]')) {
      trackedMode = 'data-motion';
      for (const node of document.querySelectorAll('[data-motion]')) trackElement(node, 'initial');
      return;
    }
    trackedMode = 'visible';
    if (!document.body) return;
    const all = Array.from(document.body.querySelectorAll('*'))
      .filter(element => isVisibleNow(element))
      .map((element, index) => ({
        element,
        index,
        priority: priorityForElement(element),
      }))
      .sort((a, b) => a.priority - b.priority || a.index - b.index);
    for (const entry of all) {
      if (tracked.size >= config.maxTrackedElements) break;
      trackElement(entry.element, 'initial');
    }
  }

  function ensureObserver() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(records => {
      const now = performance.now();
      for (const record of records) {
        if (mutations.length >= config.maxMutations) break;
        if (record.type === 'attributes') {
          // A hidden node revealed by a class or style change is a first-class
          // appearance event, so pick it up before its first painted frame.
          const target = record.target;
          if (target && target.nodeType === Node.ELEMENT_NODE && !idByElement.has(target) && isCandidate(target)) {
            scanAddedNode(target);
          }
          continue;
        }
        if (record.type !== 'childList') continue;
        const addedIds = [];
        const removedIds = [];
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          scanAddedNode(node);
          const recordElement = node;
          if (idByElement.has(recordElement)) addedIds.push(idByElement.get(recordElement));
        }
        for (const node of record.removedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (idByElement.has(node)) removedIds.push(idByElement.get(node));
          for (const child of node.querySelectorAll('*')) {
            if (idByElement.has(child)) removedIds.push(idByElement.get(child));
          }
        }
        if (addedIds.length === 0 && removedIds.length === 0) continue;
        const parentKey = record.target && record.target.nodeType === Node.ELEMENT_NODE
          ? structuralKey(record.target)
          : null;
        mutations.push({
          t: now,
          frame: frames.length,
          type: addedIds.length > 0 ? 'added' : 'removed',
          addedIds,
          removedIds,
          parentKey,
        });
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });
  }

  function start() {
    ensureObserver();
    initialScan();
    const loop = now => {
      if (stopped) return;
      if (frames.length >= config.maxFrameTimes) {
        stopped = true;
        return;
      }
      frames.push(now);
      for (const record of tracked.values()) {
        const sample = sampleElement(record, now);
        if (record.samples.length < config.maxSamplesPerElement) {
          record.samples.push(sample);
        } else if (!record.truncated) {
          record.truncated = true;
          truncatedElements += 1;
        }
      }
      frameRequest = requestAnimationFrame(loop);
    };
    frameRequest = requestAnimationFrame(loop);
  }

  function parseColor(value) {
    if (!value) return 0;
    const match = value.match(/rgba?\(([^)]+)\)/i);
    if (!match) return 0;
    const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    const red = Math.max(0, Math.min(255, Math.round(parts[0] || 0)));
    const green = Math.max(0, Math.min(255, Math.round(parts[1] || 0)));
    const blue = Math.max(0, Math.min(255, Math.round(parts[2] || 0)));
    const alpha = Math.max(0, Math.min(255, Math.round((parts.length > 3 ? parts[3] : 1) * 255)));
    return (((red << 24) | (green << 16) | (blue << 8) | alpha) >>> 0);
  }

  function transformScale(transform) {
    if (!transform || transform === 'none') return { x: 1, y: 1 };
    const matrix = transform.match(/^matrix(3d)?\(([^)]+)\)$/);
    if (!matrix) return { x: 1, y: 1 };
    const parts = matrix[2].split(',').map(Number);
    if (matrix[1]) {
      if (parts.length < 6) return { x: 1, y: 1 };
      return {
        x: Math.hypot(parts[0], parts[1]),
        y: Math.hypot(parts[4], parts[5]),
      };
    }
    if (parts.length < 4) return { x: 1, y: 1 };
    return {
      x: Math.hypot(parts[0], parts[1]),
      y: Math.hypot(parts[2], parts[3]),
    };
  }

  function sampleElement(record, now) {
    const element = record.el;
    const connected = Boolean(element && element.isConnected);
    if (!connected) {
      return [now, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
    }
    const rect = element.getBoundingClientRect();
    let style;
    try {
      style = getComputedStyle(element);
    } catch (error) {
      style = null;
    }
    let hidden = false;
    let effectiveOpacity = 1;
    let effectiveScaleX = 1;
    let effectiveScaleY = 1;
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      let nodeStyle = node === element ? style : getComputedStyle(node);
      if (nodeStyle) {
        hidden = hidden || nodeStyle.display === 'none' || nodeStyle.visibility === 'hidden' ||
          nodeStyle.visibility === 'collapse';
        const opacity = Number.parseFloat(nodeStyle.opacity);
        effectiveOpacity *= Number.isFinite(opacity) ? opacity : 1;
        const scale = transformScale(nodeStyle.transform);
        effectiveScaleX *= scale.x;
        effectiveScaleY *= scale.y;
      }
      node = node.parentElement;
    }
    const visible = !hidden && rect.width > 0 && rect.height > 0;
    const background = style ? parseColor(style.backgroundColor) : 0;
    const foreground = style ? parseColor(style.color) : 0;
    record.parentKey = element.parentElement ? structuralKey(element.parentElement) : record.parentKey;
    record.parentId = element.parentElement && idByElement.has(element.parentElement)
      ? idByElement.get(element.parentElement)
      : record.parentId;
    return [
      now,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      Math.max(0, Math.min(1, effectiveOpacity)),
      Number.isFinite(effectiveScaleX) ? effectiveScaleX : 1,
      Number.isFinite(effectiveScaleY) ? effectiveScaleY : 1,
      background,
      foreground,
      visible ? 1 : 0,
      element.offsetWidth || 0,
      element.offsetHeight || 0,
      element.offsetLeft || 0,
      element.offsetTop || 0,
    ];
  }

  function resolveTarget(selector) {
    let element;
    try {
      element = document.querySelector(selector);
    } catch (error) {
      throw new Error(`Invalid selector "${selector}": ${error.message}`);
    }
    if (!element) throw new Error(`Selector not found: ${selector}`);
    const initialRect = element.getBoundingClientRect();
    const fullyVisible = initialRect.top >= 0 && initialRect.left >= 0 &&
      initialRect.bottom <= window.innerHeight && initialRect.right <= window.innerWidth;
    if (!fullyVisible) {
      try {
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      } catch (error) {
        element.scrollIntoView({ block: 'center', inline: 'center' });
      }
    }
    const rect = element.getBoundingClientRect();
    const point = {
      x: Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2)),
      y: Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2)),
    };
    return { element, point };
  }

  function locate(selector) {
    const { element, point } = resolveTarget(selector);
    const records = trackTree(element, config.maxTargetDescendants);
    const ancestors = trackAncestors(element);
    return {
      point,
      targetIds: records.map(record => record.id),
      relatedIds: Array.from(new Set([...records, ...ancestors].map(record => record.id))),
    };
  }

  function snapshot(record, now) {
    return { id: record.id, sample: sampleElement(record, now) };
  }

  function beginStep(spec) {
    const now = performance.now();
    const step = {
      t: now,
      kind: spec.kind || 'step',
      label: spec.label || spec.kind || 'step',
      selector: spec.selector || null,
      targetIds: [],
      relatedIds: [],
      point: null,
      baseline: [],
      endTime: null,
    };
    if (spec.selector) {
      const located = locate(spec.selector);
      step.point = located.point;
      step.targetIds = located.targetIds;
      step.relatedIds = located.relatedIds;
      step.baseline = step.targetIds
        .map(id => tracked.get(id))
        .filter(Boolean)
        .map(record => snapshot(record, now));
    } else if (Array.isArray(spec.point)) {
      step.point = { x: spec.point[0], y: spec.point[1] };
    }
    steps.push(step);
    return { index: steps.length - 1, t: now, point: step.point, targetIds: step.targetIds };
  }

  function endStep(index) {
    const step = steps[index];
    if (step) step.endTime = performance.now();
  }

  function notePointer(x, y, dragging) {
    const element = document.elementFromPoint(x, y);
    if (!element) return;
    let record = tracked.get(idByElement.get(element));
    if (!record) record = trackElement(element, 'interaction');
    if (record) directIds.add(record.id);
  }

  function finish() {
    stopped = true;
    if (frameRequest) cancelAnimationFrame(frameRequest);
    if (observer) observer.disconnect();
    const trackedRecords = Array.from(tracked.values()).map(record => ({
      id: record.id,
      label: record.label,
      tag: record.tag,
      discovery: record.discovery,
      firstSeen: record.firstSeen,
      parentId: record.parentId,
      parentKey: record.parentKey,
      truncated: record.truncated,
      sampleCount: record.samples.length,
    }));
    const samples = {};
    for (const record of tracked.values()) {
      samples[record.id] = record.samples;
    }
    return {
      version: 1,
      startedAt,
      finishedAt: performance.now(),
      timeOrigin: performance.timeOrigin,
      frames,
      tracked: trackedRecords,
      samples,
      steps,
      mutations,
      directIds: Array.from(directIds),
      errors,
      truncatedElements,
      trackedMode,
    };
  }

  window.__motionAudit = {
    version: 1,
    beginStep,
    endStep,
    locate,
    notePointer,
    finish,
    state: () => ({ frames: frames.length, tracked: tracked.size, steps: steps.length }),
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}

class CDPClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.socket = new WebSocket(webSocketUrl);
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.socket.addEventListener('open', () => resolveReady(this), { once: true });
      this.socket.addEventListener('error', event => {
        rejectReady(new Error(`WebSocket error for ${webSocketUrl}: ${event.message || 'connection failed'}`));
      }, { once: true });
    });
    this.socket.addEventListener('message', event => this.handleMessage(event));
    this.socket.addEventListener('close', () => this.handleClose());
  }

  handleMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch (error) {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message || 'CDP error'}`));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }
    if (!message.method) return;
    const handlers = this.listeners.get(message.method);
    if (!handlers) return;
    for (const handler of Array.from(handlers)) {
      try {
        handler(message.params || {});
      } catch (error) {
        console.error(`[motion-audit] ${message.method} handler failed: ${error.message}`);
      }
    }
  }

  handleClose() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`CDP connection closed during ${pending.method}`));
    }
    this.pending.clear();
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error(`CDP connection closed (${method})`));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, timer, method });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectSend(error);
      }
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => {
      const handlers = this.listeners.get(method);
      if (!handlers) return;
      handlers.delete(handler);
      if (handlers.size === 0) this.listeners.delete(method);
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`CDP connection closed during ${pending.method}`));
    }
    this.pending.clear();
    try {
      this.socket.close();
    } catch (error) {
      // The socket may already be closing.
    }
  }
}

async function connectCDP(webSocketUrl) {
  const client = new CDPClient(webSocketUrl);
  await client.ready;
  return client;
}

async function fetchJson(url, timeoutMs = 2500) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

async function waitForDebugger(port, timeoutMs) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`, 1500);
      if (version && version.webSocketDebuggerUrl) return version;
    } catch (error) {
      lastError = error;
    }
    await sleep(80);
  }
  throw new Error(`Timed out waiting for remote debugging on port ${port}${lastError ? `: ${lastError.message}` : ''}`);
}

async function waitForPageTarget(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, 1500);
      const pages = targets.filter(target =>
        target.type === 'page' &&
        target.webSocketDebuggerUrl &&
        !target.url.startsWith('devtools://'));
      if (pages.length > 0) return pages[0];
    } catch (error) {
      // The browser may not be listening yet.
    }
    await sleep(100);
  }
  throw new Error(`No debuggable page target appeared on port ${port}.`);
}

function killProcessTree(processHandle) {
  if (!processHandle || !processHandle.pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(processHandle.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 8000,
      });
    } catch (error) {
      try {
        processHandle.kill('SIGKILL');
      } catch (killError) {
        // The process is already gone.
      }
    }
    return;
  }
  try {
    process.kill(-processHandle.pid, 'SIGKILL');
  } catch (error) {
    try {
      processHandle.kill('SIGKILL');
    } catch (killError) {
      // The process is already gone.
    }
  }
}

function removeDirectoryWithRetries(directory) {
  if (!directory) return;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === 3) console.error(`[motion-audit] Could not remove ${directory}: ${error.message}`);
      else execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},120)'], { stdio: 'ignore' });
    }
  }
}

async function launchChromium(options, recorderSource) {
  const browserPath = findBrowserExecutable();
  const port = await getFreePort();
  const profileDir = mkdtempSync(join(tmpdir(), 'motion-audit-profile-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--allow-file-access-from-files',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${Math.round(options.width * options.scale)},${Math.round(options.height * options.scale)}`,
    'about:blank',
  ];
  const child = spawn(browserPath, args, {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  child.on('error', error => {
    console.error(`[motion-audit] Browser failed to start: ${error.message}`);
  });
  const session = {
    mode: 'browser',
    port,
    profileDir,
    browserProcess: child,
    attached: false,
    cdp: null,
    closed: false,
    async close() {
      if (this.closed) return;
      this.closed = true;
      try {
        this.cdp?.close();
      } catch (error) {
        // The connection may already be gone.
      }
      killProcessTree(this.browserProcess);
      await sleep(350);
      removeDirectoryWithRetries(this.profileDir);
    },
  };
  try {
    await waitForDebugger(port, 20000);
    const page = await waitForPageTarget(port, 20000);
    const cdp = await connectCDP(page.webSocketDebuggerUrl);
    session.cdp = cdp;
    session.pageTarget = page;
    await configurePage(cdp, options, recorderSource);
    if (options.url) {
      const targetUrl = resolveTargetUrl(options.url);
      await navigateTo(cdp, targetUrl);
    }
    return session;
  } catch (error) {
    await session.close();
    throw error;
  }
}

async function launchElectron(options, recorderSource) {
  const electronPath = resolve(options.electron);
  if (!existsSync(electronPath)) {
    throw new Error(`Electron executable not found: ${electronPath}`);
  }
  if (options.app && !existsSync(resolve(options.app))) {
    throw new Error(`Electron app directory not found: ${resolve(options.app)}`);
  }
  const port = await getFreePort();
  const profileDir = mkdtempSync(join(tmpdir(), 'motion-audit-electron-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
  ];
  if (options.app) args.push(resolve(options.app));
  const child = spawn(electronPath, args, {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  child.on('error', error => {
    console.error(`[motion-audit] Electron failed to start: ${error.message}`);
  });
  const session = {
    mode: 'electron',
    port,
    profileDir,
    browserProcess: child,
    attached: false,
    cdp: null,
    closed: false,
    async close() {
      if (this.closed) return;
      this.closed = true;
      try {
        this.cdp?.close();
      } catch (error) {
        // The connection may already be gone.
      }
      killProcessTree(this.browserProcess);
      await sleep(350);
      removeDirectoryWithRetries(this.profileDir);
    },
  };
  try {
    await waitForDebugger(port, 40000);
    const page = await waitForPageTarget(port, 40000);
    const cdp = await connectCDP(page.webSocketDebuggerUrl);
    session.cdp = cdp;
    session.pageTarget = page;
    await configurePage(cdp, options, recorderSource);
    if (options.url) {
      const targetUrl = resolveTargetUrl(options.url);
      await navigateTo(cdp, targetUrl);
    }
    return session;
  } catch (error) {
    await session.close();
    throw error;
  }
}

async function attachToBrowser(options, recorderSource) {
  const port = options.attach;
  await waitForDebugger(port, 3000);
  const page = await waitForPageTarget(port, 5000);
  const cdp = await connectCDP(page.webSocketDebuggerUrl);
  const session = {
    mode: 'attach',
    port,
    profileDir: null,
    browserProcess: null,
    attached: true,
    cdp,
    pageTarget: page,
    closed: false,
    async close() {
      if (this.closed) return;
      this.closed = true;
      try {
        this.cdp?.close();
      } catch (error) {
        // The connection may already be gone.
      }
    },
  };
  await configurePage(cdp, options, recorderSource, true);
  if (options.url) {
    const targetUrl = resolveTargetUrl(options.url);
    const current = await evaluateValue(cdp, 'location.href', false);
    if (current !== targetUrl) await navigateTo(cdp, targetUrl);
  }
  return session;
}

async function configurePage(cdp, options, recorderSource, attached = false) {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: Math.round(options.width),
    height: Math.round(options.height),
    deviceScaleFactor: options.scale,
    mobile: false,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: recorderSource });
  if (attached) {
    await evaluateValue(cdp, recorderSource, false);
    await waitForAuditReady(cdp, 5000).catch(() => {});
  }
}

async function navigateTo(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await waitForAuditReady(cdp, 20000);
  await sleep(120);
}

async function waitForAuditReady(cdp, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await evaluateValue(
        cdp,
        '({ ready: document.readyState, audit: Boolean(window.__motionAudit) })',
      );
      if (status && status.audit && (status.ready === 'complete' || status.ready === 'interactive')) return;
    } catch (error) {
      // Navigation may be replacing the execution context.
    }
    await sleep(60);
  }
  throw new Error('Page did not become ready for motion auditing.');
}

async function evaluateValue(cdp, expression, awaitPromise = true) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const message = result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text || 'Runtime.evaluate failed';
    throw new Error(message);
  }
  return result.result?.value;
}

async function evaluateAudit(cdp, expression) {
  return evaluateValue(cdp, `window.__motionAudit.${expression}`, true);
}

async function dispatchMouse(cdp, type, point, extra = {}) {
  await cdp.send('Input.dispatchMouseEvent', {
    type,
    x: Number(point.x),
    y: Number(point.y),
    button: extra.button || 'none',
    buttons: extra.buttons || 0,
    clickCount: extra.clickCount || 0,
    ...extra,
  });
}

async function beginScenarioStep(cdp, spec) {
  const expression = `window.__motionAudit.beginStep(${JSON.stringify(spec)})`;
  return evaluateValue(cdp, expression);
}

async function endScenarioStep(cdp, index) {
  if (index === undefined || index === null) return;
  try {
    await evaluateValue(cdp, `window.__motionAudit.endStep(${index})`, false);
  } catch (error) {
    // The page may have navigated; this is not fatal for the recording.
  }
}

async function runScenario(cdp, steps) {
  for (const [stepIndex, step] of steps.entries()) {
    if ('wait' in step) {
      const ms = Math.max(0, Number(step.wait) || 0);
      const marker = await beginScenarioStep(cdp, {
        kind: 'wait',
        label: `wait ${ms} ms`,
      });
      await sleep(ms);
      await endScenarioStep(cdp, marker.index);
      continue;
    }
    if ('mark' in step) {
      const marker = await beginScenarioStep(cdp, {
        kind: 'mark',
        label: String(step.mark),
      });
      await endScenarioStep(cdp, marker.index);
      continue;
    }
    if ('hover' in step) {
      const marker = await beginScenarioStep(cdp, {
        kind: 'hover',
        selector: step.hover,
        label: `hover ${step.hover}`,
      });
      await dispatchMouse(cdp, 'mouseMoved', marker.point, { buttons: 0 });
      await endScenarioStep(cdp, marker.index);
      continue;
    }
    if ('down' in step) {
      const marker = await beginScenarioStep(cdp, {
        kind: 'down',
        selector: step.down,
        label: `down ${step.down}`,
      });
      await dispatchMouse(cdp, 'mousePressed', marker.point, {
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      await endScenarioStep(cdp, marker.index);
      continue;
    }
    if ('up' in step) {
      const marker = await beginScenarioStep(cdp, {
        kind: 'up',
        selector: step.up,
        label: `up ${step.up}`,
      });
      await dispatchMouse(cdp, 'mouseReleased', marker.point, {
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
      await endScenarioStep(cdp, marker.index);
      continue;
    }
    if ('click' in step) {
      const marker = await beginScenarioStep(cdp, {
        kind: 'click',
        selector: step.click,
        label: `click ${step.click}`,
      });
      await dispatchMouse(cdp, 'mousePressed', marker.point, {
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      await sleep(80);
      await dispatchMouse(cdp, 'mouseReleased', marker.point, {
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
      await endScenarioStep(cdp, marker.index);
      continue;
    }
    if ('move' in step) {
      const coordinates = Array.isArray(step.move) ? step.move : [0, 0];
      const marker = await beginScenarioStep(cdp, {
        kind: 'move',
        label: `move ${coordinates[0]},${coordinates[1]}`,
        point: coordinates,
      });
      await dispatchMouse(cdp, 'mouseMoved', marker.point, { buttons: 0 });
      await endScenarioStep(cdp, marker.index);
      continue;
    }
    if ('drag' in step) {
      const drag = step.drag || {};
      if (!drag.from) throw new Error(`Scenario step ${stepIndex}: drag needs "from".`);
      const fromLocated = await evaluateValue(
        cdp,
        `window.__motionAudit.locate(${JSON.stringify(drag.from)})`,
      );
      let toPoint;
      if (Array.isArray(drag.to)) {
        toPoint = { x: Number(drag.to[0]), y: Number(drag.to[1]) };
      } else if (typeof drag.to === 'string') {
        const toLocated = await evaluateValue(
          cdp,
          `window.__motionAudit.locate(${JSON.stringify(drag.to)})`,
        );
        toPoint = toLocated.point;
      } else {
        throw new Error(`Scenario step ${stepIndex}: drag "to" must be a selector or [x, y].`);
      }
      const duration = Math.max(80, Number(drag.duration) || 400);
      const marker = await beginScenarioStep(cdp, {
        kind: 'drag',
        selector: drag.from,
        label: `drag ${drag.from} -> ${typeof drag.to === 'string' ? drag.to : `${toPoint.x},${toPoint.y}`}`,
      });
      await dispatchMouse(cdp, 'mouseMoved', fromLocated.point, { buttons: 0 });
      await dispatchMouse(cdp, 'mousePressed', fromLocated.point, {
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      const frames = Math.max(2, Math.round(duration / (1000 / 60)));
      for (let frame = 1; frame <= frames; frame += 1) {
        const progress = frame / frames;
        const point = {
          x: fromLocated.point.x + (toPoint.x - fromLocated.point.x) * progress,
          y: fromLocated.point.y + (toPoint.y - fromLocated.point.y) * progress,
        };
        await dispatchMouse(cdp, 'mouseMoved', point, { button: 'left', buttons: 1 });
        if (frame % 4 === 0) {
          try {
            await evaluateValue(
              cdp,
              `window.__motionAudit.notePointer(${point.x},${point.y},true)`,
              false,
            );
          } catch (error) {
            // Pointer annotations are best-effort.
          }
        }
        await sleep(1000 / 60);
      }
      await dispatchMouse(cdp, 'mouseReleased', toPoint, {
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
      await endScenarioStep(cdp, marker.index);
      continue;
    }
    if ('key' in step) {
      const key = String(step.key);
      const code = KEY_CODES[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
      const marker = await beginScenarioStep(cdp, {
        kind: 'key',
        label: `key ${key}`,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code: key,
        windowsVirtualKeyCode: code,
        nativeVirtualKeyCode: code,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code: key,
        windowsVirtualKeyCode: code,
        nativeVirtualKeyCode: code,
      });
      await endScenarioStep(cdp, marker.index);
      continue;
    }
    if ('type' in step) {
      const marker = await beginScenarioStep(cdp, {
        kind: 'type',
        label: 'type text',
      });
      await cdp.send('Input.insertText', { text: String(step.type) });
      await endScenarioStep(cdp, marker.index);
      continue;
    }
    if ('eval' in step) {
      const marker = await beginScenarioStep(cdp, {
        kind: 'eval',
        label: 'eval',
      });
      await evaluateValue(cdp, String(step.eval), true);
      await endScenarioStep(cdp, marker.index);
      continue;
    }
  }
}

async function startFallbackCaptures(cdp, framesDir, frames) {
  let inFlight = false;
  let stopped = false;
  let lastSaved = 0;
  const timer = setInterval(async () => {
    if (inFlight || stopped) return;
    if (frames.length >= MAX_SCREENSHOT_FRAMES) return;
    const now = Date.now();
    if (now - lastSaved < 50) return;
    inFlight = true;
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 65 }, 10000);
      if (shot.data) {
        const file = join(framesDir, `frame-${String(frames.length).padStart(3, '0')}.jpg`);
        writeFileSync(file, Buffer.from(shot.data, 'base64'));
        frames.push({ file, timestampMs: now });
        lastSaved = now;
      }
    } catch (error) {
      // Fallback captures are best-effort.
    } finally {
      inFlight = false;
    }
  }, 50);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function collectRecording(session, options, scenario) {
  const cdp = session.cdp;
  const framesDir = mkdtempSync(join(tmpdir(), 'motion-audit-frames-'));
  const frames = [];
  let lastSavedTimestamp = 0;
  let screencastStarted = false;
  let fallback = null;
  const onScreencastFrame = event => {
    cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }, 5000).catch(() => {});
    // The metadata timestamp can lead the delivered pixels in headless mode;
    // receipt time keeps frame content aligned with scenario steps.
    const timestampMs = Date.now();
    if (frames.length >= MAX_SCREENSHOT_FRAMES) return;
    if (lastSavedTimestamp && timestampMs - lastSavedTimestamp < SCREENSHOT_INTERVAL_MS) return;
    const file = join(framesDir, `frame-${String(frames.length).padStart(3, '0')}.jpg`);
    try {
      writeFileSync(file, Buffer.from(event.data, 'base64'));
      frames.push({ file, timestampMs });
      lastSavedTimestamp = timestampMs;
    } catch (error) {
      // A failed frame should not abort the audit.
    }
  };
  try {
    const removeScreencastListener = cdp.on('Page.screencastFrame', onScreencastFrame);
    try {
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 70,
        maxWidth: Math.round(options.width),
        maxHeight: Math.round(options.height),
        everyNthFrame: 1,
      });
      screencastStarted = true;
    } catch (error) {
      screencastStarted = false;
    }
    if (!screencastStarted) {
      fallback = await startFallbackCaptures(cdp, framesDir, frames);
    }
    await sleep(160);
    if (scenario) {
      await runScenario(cdp, scenario);
    }
    await sleep(options.settle);
    if (screencastStarted) {
      await cdp.send('Page.stopScreencast', {}, 10000).catch(() => {});
    }
    if (fallback) fallback.stop();
    removeScreencastListener();
    await sleep(80);
    const recording = await evaluateAudit(cdp, 'finish()');
    if (!recording || recording.version !== 1) {
      throw new Error('Recorder did not return a valid recording.');
    }
    const screenshots = frames.map(frame => ({
      timestampMs: frame.timestampMs,
      data: readFileSync(frame.file).toString('base64'),
    }));
    return { recording, screenshots };
  } finally {
    if (fallback) fallback.stop();
    removeDirectoryWithRetries(framesDir);
  }
}

const SAMPLE_INDEX = {
  time: 0,
  x: 1,
  y: 2,
  width: 3,
  height: 4,
  opacity: 5,
  scaleX: 6,
  scaleY: 7,
  background: 8,
  foreground: 9,
  visible: 10,
  offsetWidth: 11,
  offsetHeight: 12,
  offsetLeft: 13,
  offsetTop: 14,
};

function decodeColor(value) {
  const packed = Number(value) >>> 0;
  return {
    r: (packed >>> 24) & 255,
    g: (packed >>> 16) & 255,
    b: (packed >>> 8) & 255,
    a: packed & 255,
  };
}

function colorDistance(first, second) {
  if (!first && !second) return 0;
  const a = decodeColor(first);
  const b = decodeColor(second);
  if (a.a === 0 && b.a === 0) return 0;
  if (a.a === 0 || b.a === 0) return 255;
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

function colorToHex(value) {
  const color = decodeColor(value);
  const hex = part => part.toString(16).padStart(2, '0');
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
}

function buildElementSeries(rawSamples) {
  const series = [];
  for (const sample of rawSamples || []) {
    const x = sample[SAMPLE_INDEX.x];
    const y = sample[SAMPLE_INDEX.y];
    const width = sample[SAMPLE_INDEX.width];
    const height = sample[SAMPLE_INDEX.height];
    series.push({
      t: sample[SAMPLE_INDEX.time],
      x,
      y,
      w: width,
      h: height,
      cx: x + width / 2,
      cy: y + height / 2,
      opacity: sample[SAMPLE_INDEX.opacity],
      scaleX: sample[SAMPLE_INDEX.scaleX],
      scaleY: sample[SAMPLE_INDEX.scaleY],
      bg: sample[SAMPLE_INDEX.background],
      fg: sample[SAMPLE_INDEX.foreground],
      visible: sample[SAMPLE_INDEX.visible] === 1,
      ow: sample[SAMPLE_INDEX.offsetWidth],
      oh: sample[SAMPLE_INDEX.offsetHeight],
      ox: sample[SAMPLE_INDEX.offsetLeft],
      oy: sample[SAMPLE_INDEX.offsetTop],
    });
  }
  return series;
}

function buildSeriesMap(recording) {
  const map = new Map();
  for (const record of recording.tracked) {
    map.set(record.id, buildElementSeries(recording.samples[record.id]));
  }
  return map;
}

function propertyMagnitude(property, first, second) {
  return Math.abs(second[property.key] - first[property.key]);
}

function elementSizeForSegment(series, startIndex, endIndex) {
  let widthSum = 0;
  let heightSum = 0;
  let count = 0;
  for (let index = startIndex; index <= endIndex; index += 1) {
    if (!series[index].visible) continue;
    widthSum += series[index].w;
    heightSum += series[index].h;
    count += 1;
  }
  if (count === 0) return 0;
  return Math.max(widthSum / count, heightSum / count);
}

function calculateReversals(values, epsilon, range) {
  let previousDirection = 0;
  let reversals = 0;
  for (let index = 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    const noiseFloor = Math.max(epsilon * 2, range * 0.03);
    if (Math.abs(delta) < noiseFloor) continue;
    const direction = Math.sign(delta);
    if (previousDirection !== 0 && direction !== previousDirection) reversals += 1;
    previousDirection = direction;
  }
  return reversals;
}

function calculateFlatness(values) {
  if (values.length < 6) return { coefficient: 1, count: 0 };
  const speeds = [];
  const firstInterior = Math.floor(values.length * 0.1);
  const lastInterior = Math.ceil(values.length * 0.9);
  for (let index = Math.max(1, firstInterior); index < Math.min(values.length, lastInterior); index += 1) {
    speeds.push(Math.abs(values[index] - values[index - 1]));
  }
  if (speeds.length < 4) return { coefficient: 1, count: speeds.length };
  const mean = speeds.reduce((sum, value) => sum + value, 0) / speeds.length;
  if (mean <= 0) return { coefficient: 1, count: speeds.length };
  const variance = speeds.reduce((sum, value) => sum + (value - mean) ** 2, 0) / speeds.length;
  return { coefficient: Math.sqrt(variance) / mean, count: speeds.length };
}

function findMotionSegments(series, property, options) {
  const segments = [];
  let active = null;

  const finishSegment = run => {
    if (!run) return;
    const start = series[run.startIndex];
    const end = series[run.lastIndex];
    const duration = end.t - start.t;
    if (duration < MIN_MOTION_DURATION_MS) return;
    const values = [];
    for (let index = run.startIndex; index <= run.lastIndex; index += 1) {
      values.push(series[index][property.key]);
    }
    if (values.length < 2) return;
    const startValue = values[0];
    const endValue = values[values.length - 1];
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const range = maxValue - minValue;
    if (range < property.minTravel) return;
    let largestStep = 0;
    for (let index = 1; index < values.length; index += 1) {
      largestStep = Math.max(largestStep, Math.abs(values[index] - values[index - 1]));
    }
    // A single frame carrying most of the distance is a jump, not continuous
    // motion; snap detection owns that case, but restart analysis still needs it.
    const discontinuous = largestStep > range * 0.6;
    const reversals = calculateReversals(values, property.epsilon, range);
    const overshoot = endValue >= startValue
      ? Math.max(0, maxValue - endValue)
      : Math.max(0, endValue - minValue);
    const travel = Math.abs(endValue - startValue);
    // A physical spring cannot overshoot by more than the distance it travelled;
    // a bigger excursion means the target moved (a retarget), not an overshoot.
    const validOvershoot = overshoot <= travel ? overshoot : 0;
    const overshootPct = travel > 0.01 ? (validOvershoot / travel) * 100 : 0;
    const flatness = calculateFlatness(values);
    const flatLinear = duration >= LINEAR_MIN_DURATION_MS && flatness.count >= 4 &&
      flatness.coefficient < LINEAR_FLATNESS_CV;
    let easing = 'ease';
    if (reversals > 0 || overshootPct > 1) easing = 'spring';
    else if (flatLinear) easing = 'linear';
    else if (duration < 60) easing = 'snap';
    segments.push({
      elementId: null,
      elementLabel: null,
      property: property.key,
      propertyLabel: property.label,
      unit: property.unit,
      startT: start.t,
      endT: end.t,
      duration,
      startValue,
      endValue,
      minValue,
      maxValue,
      range,
      overshootPct,
      reversals,
      easing,
      discontinuous,
      flatness: flatness.coefficient,
      elementSize: elementSizeForSegment(series, run.startIndex, run.lastIndex),
      startIndex: run.startIndex,
      endIndex: run.lastIndex,
      layout: Boolean(property.layout),
    });
  };

  for (let index = 1; index < series.length; index += 1) {
    const previous = series[index - 1];
    const current = series[index];
    const dt = current.t - previous.t;
    const moving = previous.visible && current.visible && dt > 0 && dt < 200 &&
      propertyMagnitude(property, previous, current) > property.epsilon;
    if (moving) {
      if (!active) {
        active = { startIndex: index - 1, lastIndex: index };
      } else if (current.t - series[active.lastIndex].t <= MOTION_GAP_MS) {
        active.lastIndex = index;
      } else {
        finishSegment(active);
        active = { startIndex: index - 1, lastIndex: index };
      }
    } else if (active && current.t - series[active.lastIndex].t > MOTION_GAP_MS) {
      finishSegment(active);
      active = null;
    }
  }
  finishSegment(active);
  return segments;
}

function extractMotions(recording, trackedById, seriesById, options) {
  const motions = [];
  const layoutMotions = [];
  for (const record of recording.tracked) {
    const series = seriesById.get(record.id);
    if (!series || series.length < 2) continue;
    for (const property of MOTION_PROPERTIES) {
      const segments = findMotionSegments(series, property, options);
      for (const segment of segments) {
        segment.elementId = record.id;
        segment.elementLabel = record.label;
        motions.push(segment);
      }
    }
    for (const property of LAYOUT_PROPERTIES) {
      const segments = findMotionSegments(series, { ...property, layout: true }, options);
      for (const segment of segments) {
        segment.elementId = record.id;
        segment.elementLabel = record.label;
        segment.layout = true;
        if (segment.duration >= 120) layoutMotions.push(segment);
      }
    }
  }
  motions.sort((a, b) => a.startT - b.startT || a.elementId - b.elementId);
  return { motions, layoutMotions };
}

function issueFor(rule, severity, record, time, message, measured) {
  return {
    rule,
    severity,
    elementId: record ? record.id : null,
    element: record ? record.label : 'page',
    time,
    message,
    measured: measured || {},
  };
}

function snapSpecifications(options) {
  const thresholds = options.thresholds;
  return [
    {
      property: 'position',
      label: 'position',
      threshold: thresholds.snapPositionPx,
      quiet: 0.8,
      value: sample => [sample.cx, sample.cy],
      magnitude: (first, second) => Math.hypot(second.cx - first.cx, second.cy - first.cy),
      format: values => `${formatNumber(values[0])}, ${formatNumber(values[1])} px`,
    },
    {
      property: 'size',
      label: 'size',
      threshold: thresholds.snapSizePx,
      quiet: 0.8,
      value: sample => [sample.w, sample.h],
      magnitude: (first, second) => Math.max(Math.abs(second.w - first.w), Math.abs(second.h - first.h)),
      format: values => `${formatNumber(values[0])} x ${formatNumber(values[1])} px`,
    },
    {
      property: 'opacity',
      label: 'opacity',
      threshold: thresholds.snapOpacity,
      quiet: 0.02,
      value: sample => [sample.opacity],
      magnitude: (first, second) => Math.abs(second.opacity - first.opacity),
      format: values => formatNumber(values[0], 2),
    },
    {
      property: 'scale',
      label: 'scale',
      threshold: thresholds.snapScale,
      quiet: 0.003,
      value: sample => [sample.scaleX, sample.scaleY],
      magnitude: (first, second) => Math.max(
        Math.abs(second.scaleX - first.scaleX),
        Math.abs(second.scaleY - first.scaleY),
      ),
      format: values => `${formatNumber(values[0], 2)} x ${formatNumber(values[1], 2)}`,
    },
    {
      property: 'background-colour',
      label: 'background colour',
      threshold: thresholds.snapColor,
      quiet: 2,
      value: sample => [sample.bg],
      magnitude: (first, second) => colorDistance(first.bg, second.bg),
      format: values => colorToHex(values[0]),
    },
    {
      property: 'text-colour',
      label: 'text colour',
      threshold: thresholds.snapColor,
      quiet: 2,
      value: sample => [sample.fg],
      magnitude: (first, second) => colorDistance(first.fg, second.fg),
      format: values => colorToHex(values[0]),
    },
  ];
}

function buildDragWindows(recording) {
  return recording.steps
    .filter(step => step.kind === 'drag')
    .map(step => ({
      start: step.t - 30,
      end: (step.endTime || step.t + 100) + 30,
      ids: new Set([...(step.targetIds || []), ...(recording.directIds || [])]),
    }));
}

function isDirectManipulation(elementId, time, dragWindows) {
  return dragWindows.some(window =>
    time >= window.start && time <= window.end && window.ids.has(elementId));
}

function detectSnaps(recording, seriesById, options) {
  const issues = [];
  const specs = snapSpecifications(options);
  const dragWindows = buildDragWindows(recording);
  for (const record of recording.tracked) {
    const series = seriesById.get(record.id);
    if (!series || series.length < 4) continue;
    for (let index = 2; index < series.length - 1; index += 1) {
      const previous = series[index - 1];
      const current = series[index];
      const next = series[index + 1];
      if (!previous.visible || !current.visible || !next.visible) continue;
      if (isDirectManipulation(record.id, current.t, dragWindows)) continue;
      for (const spec of specs) {
        const before = series[index - 2];
        const change = spec.magnitude(previous, current);
        if (change <= spec.threshold) continue;
        const previousChange = spec.magnitude(before, previous);
        const nextChange = spec.magnitude(current, next);
        if (previousChange > spec.quiet || nextChange > spec.quiet) continue;
        const beforeValues = spec.value(previous);
        const afterValues = spec.value(current);
        const measured = {
          property: spec.label,
          from: spec.format(beforeValues),
          to: spec.format(afterValues),
          delta: round(change, 2),
          threshold: spec.threshold,
        };
        issues.push(issueFor(
          'snap',
          'error',
          record,
          current.t,
          `${capitalise(spec.label)} jumped in one frame with no motion around it ` +
            `(${spec.format(beforeValues)} to ${spec.format(afterValues)}); it should animate.`,
          measured,
        ));
      }
    }
  }
  return issues;
}

function isFullScale(sample) {
  return sample.scaleX >= 0.95 && sample.scaleX <= 1.05 &&
    sample.scaleY >= 0.95 && sample.scaleY <= 1.05;
}

function isFullyPresent(sample) {
  return Boolean(sample) && sample.visible && sample.opacity >= 0.9 && isFullScale(sample);
}

function typicalVisibleSize(series) {
  const widths = series.filter(sample => sample.visible && sample.w > 0).map(sample => sample.w).sort((a, b) => a - b);
  const heights = series.filter(sample => sample.visible && sample.h > 0).map(sample => sample.h).sort((a, b) => a - b);
  if (widths.length === 0 || heights.length === 0) return { w: 0, h: 0 };
  return {
    w: widths[Math.floor(widths.length / 2)],
    h: heights[Math.floor(heights.length / 2)],
  };
}

function isNearTypicalSize(sample, typical) {
  if (!typical || typical.w <= 0 || typical.h <= 0) return true;
  return sample.w >= typical.w * 0.7 && sample.h >= typical.h * 0.7;
}

function detectPopTransitions(recording, seriesById) {
  const issues = [];
  for (const record of recording.tracked) {
    const series = seriesById.get(record.id);
    if (!series || series.length === 0) continue;
    const typical = typicalVisibleSize(series);
    const first = series[0];
    const second = series[1];
    // Only a node that arrived through a DOM mutation can be called a pop-in
    // on first sight; elements discovered later were already on screen.
    if (record.discovery === 'mutation' && isFullyPresent(first) && isFullyPresent(second) &&
      isNearTypicalSize(first, typical)) {
      issues.push(issueFor(
        'pop-in',
        'error',
        record,
        first.t,
        'Appeared at full opacity and full scale with no entrance animation.',
        { opacity: round(first.opacity, 2), scale: round(Math.max(first.scaleX, first.scaleY), 2) },
      ));
    }
    for (let index = 1; index < series.length; index += 1) {
      const previous = series[index - 1];
      const current = series[index];
      const appeared = !previous.visible && current.visible;
      const disappeared = previous.visible && !current.visible;
      if (appeared && isFullyPresent(current) && isFullyPresent(series[index + 1]) &&
        isNearTypicalSize(current, typical)) {
        issues.push(issueFor(
          'pop-in',
          'error',
          record,
          current.t,
          'Appeared at full opacity and full scale in one frame; it needs an entrance animation.',
          { opacity: round(current.opacity, 2), scale: round(Math.max(current.scaleX, current.scaleY), 2) },
        ));
      }
      if (disappeared && isFullyPresent(previous) && isFullyPresent(series[index - 2]) &&
        isNearTypicalSize(previous, typical)) {
        issues.push(issueFor(
          'pop-out',
          'error',
          record,
          current.t,
          'Disappeared from full opacity and full scale in one frame; it needs an exit animation.',
          { opacity: round(previous.opacity, 2), scale: round(Math.max(previous.scaleX, previous.scaleY), 2) },
        ));
      }
    }
  }
  return issues;
}

function findSampleAtOrBefore(series, time) {
  let found = null;
  for (const sample of series) {
    if (sample.t > time) break;
    found = sample;
  }
  return found;
}

function rectanglesNear(first, second) {
  if (!first || !second) return false;
  const horizontalGap = Math.max(0, Math.max(first.x, second.x) - Math.min(first.x + first.w, second.x + second.w));
  const verticalGap = Math.max(0, Math.max(first.y, second.y) - Math.min(first.y + first.h, second.y + second.h));
  return Math.max(horizontalGap, verticalGap) <= 50;
}

function buildCauseEvents(recording, seriesById, trackedById) {
  const events = [];
  for (const record of recording.tracked) {
    const series = seriesById.get(record.id);
    if (!series) continue;
    for (let index = 1; index < series.length; index += 1) {
      const previous = series[index - 1];
      const current = series[index];
      if (!previous.visible && current.visible) {
        events.push({ t: current.t, type: 'appeared', record, parentKey: record.parentKey });
      }
      if (previous.visible && !current.visible) {
        events.push({ t: current.t, type: 'disappeared', record, parentKey: record.parentKey });
      }
      if (!previous.visible || !current.visible) continue;
      const sizeChange = Math.max(Math.abs(current.w - previous.w), Math.abs(current.h - previous.h));
      if (sizeChange <= 3) continue;
      const beforeChange = index >= 2
        ? Math.max(Math.abs(previous.w - series[index - 2].w), Math.abs(previous.h - series[index - 2].h))
        : 0;
      const afterChange = index + 1 < series.length
        ? Math.max(Math.abs(series[index + 1].w - current.w), Math.abs(series[index + 1].h - current.h))
        : 0;
      if (beforeChange <= 1.2 && afterChange <= 1.2) {
        events.push({ t: current.t, type: 'resized', record, parentKey: record.parentKey });
      }
    }
  }
  for (const mutation of recording.mutations || []) {
    if (mutation.type === 'removed' && mutation.removedIds.length > 0) {
      for (const id of mutation.removedIds) {
        const record = trackedById.get(id);
        if (record) {
          events.push({ t: mutation.t, type: 'disappeared', record, parentKey: mutation.parentKey });
        }
      }
    }
    if (mutation.type === 'added' && mutation.addedIds.length > 0) {
      for (const id of mutation.addedIds) {
        const record = trackedById.get(id);
        if (record) {
          events.push({ t: mutation.t, type: 'appeared', record, parentKey: mutation.parentKey });
        }
      }
    }
  }
  return events;
}

function detectLayoutJumps(recording, seriesById, trackedById, options) {
  const issues = [];
  const causes = buildCauseEvents(recording, seriesById, trackedById);
  const seen = new Set();
  for (const record of recording.tracked) {
    const series = seriesById.get(record.id);
    if (!series || series.length < 4) continue;
    for (let index = 2; index < series.length - 1; index += 1) {
      const before = series[index - 2];
      const previous = series[index - 1];
      const current = series[index];
      const next = series[index + 1];
      if (!before.visible || !previous.visible || !current.visible || !next.visible) continue;
      const jump = Math.hypot(current.cx - previous.cx, current.cy - previous.cy);
      if (jump <= options.thresholds.snapPositionPx) continue;
      const previousJump = Math.hypot(previous.cx - before.cx, previous.cy - before.cy);
      const nextJump = Math.hypot(next.cx - current.cx, next.cy - current.cy);
      if (previousJump > 1.2 || nextJump > 1.2) continue;
      const ownResize = Math.max(Math.abs(current.w - previous.w), Math.abs(current.h - previous.h));
      if (ownResize > 1.5) continue;
      const cause = causes.find(event => {
        if (event.record.id === record.id) return false;
        if (Math.abs(event.t - current.t) > 55) return false;
        if (event.parentKey && record.parentKey && event.parentKey === record.parentKey) return true;
        const causeSeries = seriesById.get(event.record.id);
        if (!causeSeries) return false;
        const causeSample = findSampleAtOrBefore(causeSeries, current.t);
        return rectanglesNear(previous, causeSample);
      });
      if (!cause) continue;
      const dedupeKey = `${record.id}:${Math.round(current.t / MERGE_WINDOW_MS)}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const causeRecord = cause.record;
      issues.push(issueFor(
        'layout-jump',
        'error',
        record,
        current.t,
        `Siblings jumped ${formatNumber(jump)} px in one frame after ${causeRecord.label} ` +
          `${cause.type === 'appeared' ? 'appeared' : cause.type === 'disappeared' ? 'disappeared' : 'resized'}; ` +
          'surrounding layout should animate.',
        {
          distancePx: round(jump, 2),
          cause: causeRecord.label,
          causeEvent: cause.type,
        },
      ));
    }
  }
  return issues;
}

function visualChangeBetween(first, second) {
  return {
    position: Math.hypot(second.cx - first.cx, second.cy - first.cy),
    size: Math.max(Math.abs(second.w - first.w), Math.abs(second.h - first.h)),
    opacity: Math.abs(second.opacity - first.opacity),
    scale: Math.max(Math.abs(second.scaleX - first.scaleX), Math.abs(second.scaleY - first.scaleY)),
    colour: Math.max(colorDistance(first.bg, second.bg), colorDistance(first.fg, second.fg)),
  };
}

function hasMeaningfulVisualChange(change) {
  return change.position > 1 || change.size > 1 || change.opacity > 0.02 ||
    change.scale > 0.005 || change.colour > 3;
}

function decodeBaselineSample(sample) {
  return buildElementSeries([sample])[0];
}

function detectLateFeedback(recording, seriesById, options) {
  const issues = [];
  const inputKinds = new Set(['down', 'click', 'hover']);
  for (const step of recording.steps) {
    if (!inputKinds.has(step.kind)) continue;
    if (!step.baseline || step.baseline.length === 0) continue;
    // A click is dispatched as down, a short pause, then up; the application's
    // handler may legitimately run on release, so include the press span.
    const feedbackStart = step.kind === 'click' && step.endTime ? step.endTime : step.t;
    const feedbackEnd = feedbackStart + options.thresholds.lateFeedbackMs;
    let changed = false;
    let targetRecord = null;
    for (const baseline of step.baseline) {
      const record = recording.tracked.find(entry => entry.id === baseline.id);
      if (!record) continue;
      if (!targetRecord) targetRecord = record;
      const before = decodeBaselineSample(baseline.sample);
      const series = seriesById.get(baseline.id) || [];
      const samples = series.filter(sample => sample.t > step.t && sample.t <= feedbackEnd);
      if (samples.some(sample => hasMeaningfulVisualChange(visualChangeBetween(before, sample)))) {
        changed = true;
        break;
      }
    }
    if (!changed && targetRecord) {
      issues.push(issueFor(
        'late-feedback',
        'warn',
        targetRecord,
        step.t,
        `No visual feedback appeared within ${options.thresholds.lateFeedbackMs} ms of the ${step.kind}; ` +
          'respond on the next frame.',
        {
          windowMs: options.thresholds.lateFeedbackMs,
          targetCount: step.targetIds.length,
        },
      ));
    }
  }
  return issues;
}

function detectSlowMotions(motions, options) {
  const issues = [];
  for (const motion of motions) {
    if (motion.discontinuous) continue;
    if (motion.duration <= options.maxDuration) continue;
    issues.push(issueFor(
      'slow',
      'warn',
      { id: motion.elementId, label: motion.elementLabel },
      motion.startT,
      `One continuous ${motion.propertyLabel} motion lasted ${Math.round(motion.duration)} ms, ` +
        `longer than the ${options.maxDuration} ms budget.`,
      {
        property: motion.propertyLabel,
        durationMs: Math.round(motion.duration),
        maxDurationMs: options.maxDuration,
      },
    ));
  }
  return issues;
}

function detectWobble(motions, options) {
  const issues = [];
  for (const motion of motions) {
    if (motion.discontinuous) continue;
    if (motion.duration < 100) continue;
    const tooManyReversals = motion.reversals > options.thresholds.wobbleReversals;
    const largeOvershoot = motion.elementSize > WOBBLE_LARGE_ELEMENT_PX &&
      motion.overshootPct > options.thresholds.wobbleOvershootPercent;
    if (!tooManyReversals && !largeOvershoot) continue;
    const reason = tooManyReversals
      ? `reversed direction ${motion.reversals} times`
      : `overshot by ${formatNumber(motion.overshootPct)}% on a ${Math.round(motion.elementSize)} px surface`;
    issues.push(issueFor(
      'wobble',
      'warn',
      { id: motion.elementId, label: motion.elementLabel },
      motion.startT,
      `Motion ${reason} before settling; keep it stable.`,
      {
        property: motion.propertyLabel,
        reversals: motion.reversals,
        overshootPct: round(motion.overshootPct, 1),
        elementSizePx: Math.round(motion.elementSize),
      },
    ));
  }
  return issues;
}

function detectLinearMotions(motions) {
  const issues = [];
  for (const motion of motions) {
    if (motion.discontinuous) continue;
    if (motion.easing !== 'linear') continue;
    issues.push(issueFor(
      'linear',
      'info',
      { id: motion.elementId, label: motion.elementLabel },
      motion.startT,
      `Velocity stayed flat for ${Math.round(motion.duration)} ms; spring easing is expected.`,
      {
        property: motion.propertyLabel,
        durationMs: Math.round(motion.duration),
        flatness: round(motion.flatness, 2),
      },
    ));
  }
  return issues;
}

function detectLayoutProps(layoutMotions) {
  const issues = [];
  for (const motion of layoutMotions) {
    issues.push(issueFor(
      'layout-props',
      'info',
      { id: motion.elementId, label: motion.elementLabel },
      motion.startT,
      `Animated ${motion.propertyLabel} continuously; transform and opacity are cheaper.`,
      {
        property: motion.propertyLabel,
        durationMs: Math.round(motion.duration),
      },
    ));
  }
  return issues;
}

function detectJank(recording, motions, options) {
  if (recording.frames.length < 2 || motions.length === 0) return [];
  const intervals = recording.frames.slice(1).map((time, index) => ({
    start: recording.frames[index],
    end: time,
    gap: time - recording.frames[index],
  }));
  const movingIntervals = motions.map(motion => ({
    start: motion.startT - 20,
    end: motion.endT + 20,
  }));
  const isMoving = interval => movingIntervals.some(motion =>
    interval.start < motion.end && interval.end > motion.start);
  let currentRun = null;
  const runs = [];
  for (const interval of intervals) {
    if (interval.gap > options.thresholds.jankMs && isMoving(interval)) {
      if (!currentRun) currentRun = { start: interval.start, end: interval.end, maxGap: interval.gap, frames: 1 };
      else {
        currentRun.end = interval.end;
        currentRun.maxGap = Math.max(currentRun.maxGap, interval.gap);
        currentRun.frames += 1;
      }
    } else if (currentRun) {
      runs.push(currentRun);
      currentRun = null;
    }
  }
  if (currentRun) runs.push(currentRun);
  if (runs.length === 0) return [];
  const worst = runs.reduce((best, run) => {
    if (!best) return run;
    if (run.maxGap !== best.maxGap) return run.maxGap > best.maxGap ? run : best;
    return run.end - run.start > best.end - best.start ? run : best;
  }, null);
  return [{
    rule: 'jank',
    severity: 'warn',
    elementId: null,
    element: 'page',
    time: worst.start,
    message: `Frame rate dipped while the UI was moving: worst run ${Math.round(worst.end - worst.start)} ms ` +
      `across ${worst.frames} frame${worst.frames === 1 ? '' : 's'} (slowest frame ${Math.round(worst.maxGap)} ms).`,
    measured: {
      runDurationMs: Math.round(worst.end - worst.start),
      slowestFrameMs: Math.round(worst.maxGap),
      frames: worst.frames,
      thresholdMs: options.thresholds.jankMs,
    },
  }];
}

function restartThreshold(property) {
  if (property === 'cx' || property === 'cy') return SNAP_POSITION_PX * RESTART_JUMP_FACTOR;
  if (property === 'w' || property === 'h') return SNAP_SIZE_PX * RESTART_JUMP_FACTOR;
  if (property === 'opacity') return SNAP_OPACITY * RESTART_JUMP_FACTOR;
  if (property === 'scaleX' || property === 'scaleY') return SNAP_SCALE * RESTART_JUMP_FACTOR;
  return SNAP_POSITION_PX * RESTART_JUMP_FACTOR;
}

function segmentValueDelta(property, first, second) {
  if (property === 'cx') return second.cx - first.cx;
  if (property === 'cy') return second.cy - first.cy;
  if (property === 'w') return second.w - first.w;
  if (property === 'h') return second.h - first.h;
  if (property === 'opacity') return second.opacity - first.opacity;
  if (property === 'scaleX') return second.scaleX - first.scaleX;
  if (property === 'scaleY') return second.scaleY - first.scaleY;
  return 0;
}

function segmentDistanceFromStart(property, sample, segment) {
  const startSample = segment.startSample;
  if (!startSample) return null;
  if (property === 'cx') return Math.abs(sample.cx - startSample.cx);
  if (property === 'cy') return Math.abs(sample.cy - startSample.cy);
  if (property === 'w') return Math.abs(sample.w - startSample.w);
  if (property === 'h') return Math.abs(sample.h - startSample.h);
  if (property === 'opacity') return Math.abs(sample.opacity - startSample.opacity);
  if (property === 'scaleX') return Math.abs(sample.scaleX - startSample.scaleX);
  if (property === 'scaleY') return Math.abs(sample.scaleY - startSample.scaleY);
  return null;
}

function detectRestarts(recording, seriesById, motions, options) {
  const issues = [];
  const inputKinds = new Set(['down', 'up', 'click', 'hover', 'drag', 'key', 'type', 'eval']);
  const inputLatencyMs = 120;
  const motionByElement = new Map();
  for (const motion of motions) {
    if (!motionByElement.has(motion.elementId)) motionByElement.set(motion.elementId, []);
    motionByElement.get(motion.elementId).push(motion);
  }
  for (const step of recording.steps) {
    if (!inputKinds.has(step.kind)) continue;
    const related = new Set(step.relatedIds || []);
    const candidateIds = related.size > 0 ? Array.from(related) : Array.from(motionByElement.keys());
    // A click handler runs on release, so allow the reset to land after the
    // recorded step timestamp.
    const reactionTime = (step.kind === 'click' && step.endTime ? step.endTime : step.t) + inputLatencyMs;
    for (const elementId of candidateIds) {
      const record = recording.tracked.find(entry => entry.id === elementId);
      const series = seriesById.get(elementId);
      if (!record || !series) continue;
      const elementMotions = motionByElement.get(elementId) || [];
      for (const motion of elementMotions) {
        if (!(motion.startT <= step.t && motion.endT >= step.t - 30)) continue;
        if (step.t - motion.startT < 30) continue;
        const startSample = series[motion.startIndex];
        if (!startSample) continue;
        const enriched = { ...motion, startSample };
        const beforeIndex = findLastIndexAtOrBefore(series, step.t);
        if (beforeIndex < 2) continue;
        const before = series[beforeIndex];
        const earlier = series[Math.max(0, beforeIndex - 2)];
        const priorDelta = segmentValueDelta(motion.property, earlier, before);
        const distanceBefore = segmentDistanceFromStart(motion.property, before, enriched);
        if (distanceBefore === null || distanceBefore < restartThreshold(motion.property) * 1.4) continue;
        if (Math.abs(priorDelta) < 0.2 && motion.startValue === motion.endValue) continue;
        const threshold = restartThreshold(motion.property);
        // A spring can legitimately move several pixels in one frame. A restart
        // is a step much larger than anything this motion produced while it was
        // running, so compare against its prior peak frame-to-frame delta.
        let priorPeakDelta = 0;
        for (let index = motion.startIndex + 1; index <= beforeIndex; index += 1) {
          const delta = Math.abs(segmentValueDelta(motion.property, series[index - 1], series[index]));
          priorPeakDelta = Math.max(priorPeakDelta, delta);
        }
        const jumpThreshold = Math.max(threshold, priorPeakDelta * 1.8);
        let previous = before;
        for (let index = beforeIndex + 1; index < series.length; index += 1) {
          const after = series[index];
          if (after.t > reactionTime) break;
          const distanceAfter = segmentDistanceFromStart(motion.property, after, enriched);
          const distancePrevious = segmentDistanceFromStart(motion.property, previous, enriched);
          if (distanceAfter === null || distancePrevious === null) break;
          // Only compare consecutive samples: a smooth retarget may travel the
          // same direction over many frames.
          const jump = Math.abs(segmentValueDelta(motion.property, previous, after));
          const movedTowardStart = distanceAfter < distancePrevious - threshold * 0.5;
          if (movedTowardStart && jump >= jumpThreshold) {
            const measured = {
              property: motion.propertyLabel,
              from: propertyValueForMotion(motion, previous),
              to: propertyValueForMotion(motion, after),
              step: step.kind,
              afterInputMs: round(after.t - step.t, 1),
            };
            issues.push(issueFor(
              'restart',
              'error',
              record,
              step.t,
              'A new input arrived while this element was moving and its motion jumped back toward the start ' +
                'instead of retargeting from the current value.',
              measured,
            ));
            break;
          }
          previous = after;
        }
      }
    }
  }
  return issues;
}

function findLastIndexAtOrBefore(series, time) {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    if (series[index].t <= time) return index;
  }
  return -1;
}

function propertyValueForMotion(motion, sample) {
  if (motion.property === 'cx') return `${formatNumber(sample.cx)} px`;
  if (motion.property === 'cy') return `${formatNumber(sample.cy)} px`;
  if (motion.property === 'w') return `${formatNumber(sample.w)} px`;
  if (motion.property === 'h') return `${formatNumber(sample.h)} px`;
  if (motion.property === 'opacity') return formatNumber(sample.opacity, 2);
  if (motion.property === 'scaleX') return formatNumber(sample.scaleX, 2);
  if (motion.property === 'scaleY') return formatNumber(sample.scaleY, 2);
  return '';
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return String(value);
  return String(round(value, digits));
}

function capitalise(value) {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

function mergeIssues(issues) {
  const severityOrder = { error: 0, warn: 1, info: 2 };
  const sorted = issues.slice().sort((first, second) =>
    severityOrder[first.severity] - severityOrder[second.severity] ||
    first.time - second.time ||
    first.rule.localeCompare(second.rule));
  const merged = [];
  for (const issue of sorted) {
    const duplicate = merged.find(previous =>
      previous.rule === issue.rule &&
      previous.elementId === issue.elementId &&
      Math.abs(previous.time - issue.time) <= MERGE_WINDOW_MS);
    if (!duplicate) {
      merged.push({ ...issue, merged: 1 });
      continue;
    }
    duplicate.merged += 1;
    if (issue.rule === 'slow' && issue.measured.durationMs > duplicate.measured.durationMs) {
      duplicate.measured.durationMs = issue.measured.durationMs;
    }
  }
  return merged;
}

function capIssuesByRule(issues, maxPerRule) {
  const counts = new Map();
  const kept = [];
  for (const issue of issues) {
    const count = counts.get(issue.rule) || 0;
    if (count >= maxPerRule) continue;
    counts.set(issue.rule, count + 1);
    kept.push(issue);
  }
  return kept;
}

function summarizeIssues(issues) {
  const summary = { error: 0, warn: 0, info: 0, total: issues.length };
  for (const issue of issues) summary[issue.severity] += 1;
  return summary;
}

function buildMotionsForReport(motions, startTime) {
  return motions
    .filter(motion => !motion.discontinuous && motion.duration >= 60 && motion.range >= 0.01)
    .sort((first, second) => second.duration - first.duration || first.startT - second.startT)
    .slice(0, MAX_MOTIONS_IN_TABLE)
    .map(motion => ({
      element: motion.elementLabel,
      elementId: motion.elementId,
      property: motion.propertyLabel,
      startValue: round(motion.startValue, 2),
      endValue: round(motion.endValue, 2),
      start: motion.startValue,
      end: motion.endValue,
      unit: motion.unit,
      startTimeMs: round(motion.startT - startTime, 1),
      endTimeMs: round(motion.endT - startTime, 1),
      durationMs: round(motion.duration, 1),
      overshootPct: round(motion.overshootPct, 1),
      reversals: motion.reversals,
      easing: motion.easing,
    }));
}

function analyzeRecording(recording, options) {
  const startTime = recording.frames.length > 0 ? recording.frames[0] : recording.startedAt;
  const trackedById = new Map(recording.tracked.map(record => [record.id, record]));
  const seriesById = buildSeriesMap(recording);
  const { motions, layoutMotions } = extractMotions(recording, trackedById, seriesById, options);
  const issues = [
    ...detectSnaps(recording, seriesById, options),
    ...detectPopTransitions(recording, seriesById),
    ...detectLayoutJumps(recording, seriesById, trackedById, options),
    ...detectLateFeedback(recording, seriesById, options),
    ...detectSlowMotions(motions, options),
    ...detectWobble(motions, options),
    ...detectRestarts(recording, seriesById, motions, options),
    ...detectJank(recording, motions, options),
    ...detectLinearMotions(motions),
    ...detectLayoutProps(layoutMotions),
  ];
  const merged = capIssuesByRule(mergeIssues(issues), options.thresholds.maxIssuesPerRule);
  const reportMotions = buildMotionsForReport(motions, startTime);
  return {
    tool: 'motion-audit',
    version: TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    options: {
      width: options.width,
      height: options.height,
      scale: options.scale,
      settle: options.settle,
      maxDuration: options.maxDuration,
      watch: options.watch,
      scenario: options.scenario || null,
    },
    recording: {
      durationMs: round((recording.finishedAt - startTime), 1),
      frames: recording.frames.length,
      trackedElements: recording.tracked.length,
      trackedMode: recording.trackedMode,
      startTimeMs: 0,
      steps: recording.steps.map(step => ({
        kind: step.kind,
        label: step.label,
        selector: step.selector,
        timeMs: round(step.t - startTime, 1),
      })),
      recorderErrors: recording.errors,
    },
    summary: summarizeIssues(merged),
    issues: merged.map(issue => ({
      rule: issue.rule,
      severity: issue.severity,
      element: issue.element,
      elementId: issue.elementId,
      time: round(Math.max(0, issue.time - startTime), 1),
      message: issue.message,
      measured: issue.measured,
      mergedCount: issue.merged,
    })),
    motions: reportMotions,
    internal: {
      motionSegments: motions,
      layoutMotions,
      seriesById,
      trackedById,
      startTime,
    },
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeMarkdown(value) {
  return String(value).replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
}

function shorten(value, length) {
  const text = String(value);
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function formatSeconds(milliseconds) {
  return `${(milliseconds / 1000).toFixed(2)} s`;
}

function formatMotionValue(motion, value) {
  const formatted = formatNumber(value, 2);
  return motion.unit ? `${formatted} ${motion.unit}` : formatted;
}

async function createUtilityTarget(session) {
  if (!session.port) return null;
  const methods = ['PUT', 'GET'];
  for (const method of methods) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${session.port}/json/new?about:blank`,
        { method, signal: AbortSignal.timeout(3000) },
      );
      if (!response.ok) continue;
      const target = await response.json();
      if (target && target.webSocketDebuggerUrl) return target;
    } catch (error) {
      // /json/new is unavailable in some embedded browsers; fall back to the page.
    }
  }
  return null;
}

async function closeUtilityTarget(session, target) {
  if (!session.port || !target || !target.id) return;
  try {
    await fetch(`http://127.0.0.1:${session.port}/json/close/${encodeURIComponent(target.id)}`, {
      signal: AbortSignal.timeout(3000),
    });
  } catch (error) {
    // The target may already have gone.
  }
}

async function waitForRenderReady(cdp, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ready = await evaluateValue(
        cdp,
        `document.readyState === 'complete' && Array.from(document.images).every(image => image.complete) && ` +
          `document.documentElement.scrollHeight > 40`,
      );
      if (ready) return;
    } catch (error) {
      // setDocumentContent may briefly leave the context unavailable.
    }
    await sleep(60);
  }
}

async function renderHtmlToPng(session, html, width, outputPath, scale) {
  const target = await createUtilityTarget(session);
  const ownsTarget = Boolean(target);
  const cdp = target ? await connectCDP(target.webSocketDebuggerUrl) : session.cdp;
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: scale,
      mobile: false,
    });
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 8, g: 11, b: 16, a: 1 },
    });
    const { frameTree } = await cdp.send('Page.getFrameTree');
    await cdp.send('Page.setDocumentContent', {
      frameId: frameTree.frame.id,
      html,
    });
    await waitForRenderReady(cdp, 8000);
    const measuredHeight = await evaluateValue(
      cdp,
      'Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)',
    );
    const height = Math.min(14000, Math.max(300, Math.ceil(Number(measuredHeight) || 900)));
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false,
    });
    await sleep(180);
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
    }, 20000);
    writeFileSync(outputPath, Buffer.from(shot.data, 'base64'));
  } finally {
    if (ownsTarget) {
      cdp.close();
      await closeUtilityTarget(session, target);
    }
  }
}

function selectFilmstripFrames(frames) {
  if (frames.length <= FILMSTRIP_FRAME_LIMIT) return frames;
  const selected = [];
  for (let index = 0; index < FILMSTRIP_FRAME_LIMIT; index += 1) {
    const frameIndex = Math.round(index * (frames.length - 1) / (FILMSTRIP_FRAME_LIMIT - 1));
    selected.push(frames[frameIndex]);
  }
  return selected;
}

function nearestStep(steps, pageTime) {
  let nearest = null;
  for (const step of steps) {
    if (step.t > pageTime) break;
    nearest = step;
  }
  return nearest;
}

function buildFilmstripHtml(recording, screenshots, report, targetDescription) {
  const startTime = recording.frames.length > 0 ? recording.frames[0] : recording.startedAt;
  const timeOrigin = Number(recording.timeOrigin) || (Date.now() - performance.now());
  const orderedFrames = screenshots
    .map(frame => ({
      data: frame.data,
      pageTime: Number(frame.timestampMs) - timeOrigin,
    }))
    .sort((first, second) => first.pageTime - second.pageTime);
  const selected = selectFilmstripFrames(orderedFrames);
  const summary = report.summary;
  const labels = recording.steps.map(step => ({
    t: step.t,
    label: step.label,
    kind: step.kind,
  }));
  const cards = selected.map(frame => {
    const relativeMs = Math.max(0, frame.pageTime - startTime);
    const step = nearestStep(labels, frame.pageTime);
    const label = step ? step.label : 'initial state';
    return `<figure class="shot">
      <img src="data:image/jpeg;base64,${frame.data}" alt="Frame at ${formatSeconds(relativeMs)}">
      <figcaption><span class="clock">${formatSeconds(relativeMs)}</span><span class="step">${escapeHtml(label)}</span></figcaption>
    </figure>`;
  }).join('');
  const empty = selected.length === 0
    ? '<div class="empty">No screencast frames were captured.</div>'
    : '';
  const omitted = orderedFrames.length > selected.length
    ? `<span class="muted">${selected.length} of ${orderedFrames.length} frames shown.</span>`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0f14; color: #dbe4ee;
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif; padding: 26px 28px 30px; }
  h1 { font-size: 23px; font-weight: 650; margin: 0 0 5px; letter-spacing: 0.1px; }
  .sub { color: #8b98a8; font-size: 12.5px; margin-bottom: 16px; }
  .chips { display: flex; gap: 8px; margin-bottom: 18px; flex-wrap: wrap; align-items: center; }
  .chip { border: 1px solid #26313d; border-radius: 999px; padding: 4px 10px; font-size: 12px; color: #b7c5d3; background: #111822; }
  .chip.error { color: #ffb3b8; border-color: #5b2b31; background: #1d1114; }
  .chip.warn { color: #ffd39a; border-color: #5a4224; background: #1c1710; }
  .chip.info { color: #a8ccff; border-color: #294565; background: #111827; }
  .muted { color: #7e8b9a; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
  .shot { margin: 0; border: 1px solid #202b37; border-radius: 8px; overflow: hidden; background: #111820;
    box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
  .shot img { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; background: #070a0e; }
  figcaption { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px 9px; border-top: 1px solid #1b2530; }
  .clock { color: #e7eef6; font-size: 12px; font-variant-numeric: tabular-nums; }
  .step { color: #93a3b5; font-size: 11px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; }
  .empty { padding: 40px; border: 1px dashed #2c3947; border-radius: 8px; color: #8b98a8; }
</style></head><body>
  <h1>Motion audit filmstrip</h1>
  <div class="sub">${escapeHtml(targetDescription)}</div>
  <div class="chips">
    <span class="chip error">${summary.error} error${summary.error === 1 ? '' : 's'}</span>
    <span class="chip warn">${summary.warn} warning${summary.warn === 1 ? '' : 's'}</span>
    <span class="chip info">${summary.info} info</span>
    <span class="chip">${recording.frames.length} sampled frames</span>
    ${omitted}
  </div>
  ${empty}
  <div class="grid">${cards}</div>
  <p class="muted">Each thumbnail is time-stamped relative to the first sampled frame; the label is the most recent scenario step.</p>
</body></html>`;
}

const CURVE_PROPERTY_GROUPS = [
  { name: 'scale', properties: ['scaleX', 'scaleY'] },
  { name: 'opacity', properties: ['opacity'] },
  { name: 'position', properties: ['cx', 'cy'] },
  { name: 'size', properties: ['w', 'h'] },
];

function chooseCurveMotions(motions) {
  const eligible = motions
    .filter(motion => !motion.discontinuous && motion.duration >= 80 && motion.range > 0)
    .slice()
    .sort((first, second) => second.duration - first.duration || first.startT - second.startT);
  // Take the longest motion per property family, round-robin, so one page-wide
  // layout shift cannot fill every chart with the same curve.
  const groups = CURVE_PROPERTY_GROUPS.map(group => ({
    name: group.name,
    motions: eligible.filter(motion => group.properties.includes(motion.property)),
  }));
  const selected = [];
  const usedKeys = new Set();
  let progressed = true;
  while (selected.length < MAX_CURVES && progressed) {
    progressed = false;
    for (const group of groups) {
      const motion = group.motions.find(candidate => {
        const key = `${candidate.elementId}:${group.name}`;
        return !usedKeys.has(key) && !selected.includes(candidate);
      });
      if (!motion) continue;
      usedKeys.add(`${motion.elementId}:${group.name}`);
      selected.push(motion);
      progressed = true;
      if (selected.length >= MAX_CURVES) break;
    }
  }
  return selected;
}

function downsampleSeries(points, maximum) {
  if (points.length <= maximum) return points;
  const selected = [];
  for (let index = 0; index < maximum; index += 1) {
    const sourceIndex = Math.round(index * (points.length - 1) / (maximum - 1));
    selected.push(points[sourceIndex]);
  }
  return selected;
}

const CURVE_COLOURS = ['#78c8ff', '#ffb86b', '#9fe8b5', '#f4a3ff', '#ffd166', '#7fe3df', '#ff9ba7', '#c7b5ff'];

function buildCurveSvg(motion, series, steps, startTime, colour, index) {
  const plot = { left: 62, top: 62, width: 548, height: 150 };
  const chartWidth = 640;
  const chartHeight = 274;
  const rawPoints = series.slice(motion.startIndex, motion.endIndex + 1)
    .filter(sample => sample.visible);
  const sampled = downsampleSeries(rawPoints, 240);
  if (sampled.length < 2) {
    return `<div class="chart"><div class="chart-head"><span class="title">${escapeHtml(
      shorten(motion.elementLabel, 48),
    )}</span><span class="prop">${escapeHtml(motion.propertyLabel)}</span></div>
      <div class="empty-chart">Not enough visible samples for a curve.</div></div>`;
  }
  const values = sampled.map(sample => sample[motion.property]);
  let minValue = Math.min(...values);
  let maxValue = Math.max(...values);
  if (maxValue - minValue < 0.0001) {
    maxValue += 0.5;
    minValue -= 0.5;
  }
  const xMin = motion.startT - 80;
  const xMax = motion.endT + 80;
  const mapX = time => plot.left + ((time - xMin) / (xMax - xMin)) * plot.width;
  const mapY = value => plot.top + plot.height - ((value - minValue) / (maxValue - minValue)) * plot.height;
  const pathPoints = sampled.map(sample => {
    const x = mapX(sample.t);
    const y = mapY(sample[motion.property]);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const markers = steps
    .filter(step => step.t >= xMin && step.t <= xMax)
    .map(step => {
      const x = mapX(step.t);
      return `<line x1="${x.toFixed(2)}" y1="${plot.top}" x2="${x.toFixed(2)}" y2="${plot.top + plot.height}"
        stroke="#7c8ca0" stroke-width="1" stroke-dasharray="3 4" opacity="0.75"/>`;
    }).join('');
  const stepLabels = steps
    .filter(step => step.t >= xMin && step.t <= xMax)
    .slice(0, 6)
    .map(step => {
      const x = mapX(step.t);
      return `<text x="${x.toFixed(2)}" y="${plot.top - 7}" text-anchor="middle" fill="#8797a9"
        font-size="9">${escapeHtml(step.kind)}</text>`;
    }).join('');
  const startValue = formatMotionValue(motion, motion.startValue);
  const endValue = formatMotionValue(motion, motion.endValue);
  const title = shorten(motion.elementLabel, 46);
  return `<div class="chart">
    <div class="chart-head">
      <span class="title">${escapeHtml(title)}</span>
      <span class="prop">${escapeHtml(motion.propertyLabel)}</span>
    </div>
    <div class="chart-sub">${escapeHtml(startValue)} → ${escapeHtml(endValue)} · ${Math.round(motion.duration)} ms ·
      ${escapeHtml(motion.easing)} · overshoot ${formatNumber(motion.overshootPct)}% ·
      ${motion.reversals} reversal${motion.reversals === 1 ? '' : 's'}</div>
    <svg viewBox="0 0 ${chartWidth} ${chartHeight}" width="100%" role="img"
      aria-label="Normalised ${escapeHtml(motion.propertyLabel)} over time">
      <rect x="0" y="0" width="${chartWidth}" height="${chartHeight}" rx="5" fill="#0d131b"/>
      ${[0, 0.25, 0.5, 0.75, 1].map(fraction => {
        const y = plot.top + plot.height * fraction;
        return `<line x1="${plot.left}" y1="${y}" x2="${plot.left + plot.width}" y2="${y}"
          stroke="#1b2632" stroke-width="1"/>`;
      }).join('')}
      ${markers}
      ${stepLabels}
      <text x="18" y="${plot.top + 4}" fill="#748496" font-size="10">1.0</text>
      <text x="18" y="${plot.top + plot.height + 3}" fill="#748496" font-size="10">0.0</text>
      <text x="${plot.left}" y="${plot.top + plot.height + 25}" fill="#748496" font-size="10">
        ${formatSeconds(Math.max(0, motion.startT - startTime))}
      </text>
      <text x="${plot.left + plot.width}" y="${plot.top + plot.height + 25}" fill="#748496"
        font-size="10" text-anchor="end">${formatSeconds(Math.max(0, motion.endT - startTime))}</text>
      <text x="${plot.left}" y="18" fill="#5f7183" font-size="9">${index + 1} / ${MAX_CURVES}</text>
      <polyline points="${pathPoints.join(' ')}" fill="none" stroke="${colour}" stroke-width="1.7"
        stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${mapX(sampled[0].t).toFixed(2)}" cy="${mapY(values[0]).toFixed(2)}" r="2.7" fill="${colour}"/>
      <circle cx="${mapX(sampled[sampled.length - 1].t).toFixed(2)}"
        cy="${mapY(values[values.length - 1]).toFixed(2)}" r="2.7" fill="${colour}"/>
    </svg>
  </div>`;
}

function buildCurvesHtml(recording, motions, seriesById, report, targetDescription) {
  const startTime = recording.frames.length > 0 ? recording.frames[0] : recording.startedAt;
  const selected = chooseCurveMotions(motions);
  const charts = selected.map((motion, index) => {
    const series = seriesById.get(motion.elementId) || [];
    return buildCurveSvg(
      motion,
      series,
      recording.steps,
      startTime,
      CURVE_COLOURS[index % CURVE_COLOURS.length],
      index,
    );
  }).join('');
  const empty = selected.length === 0
    ? '<div class="empty">No motion long enough to plot.</div>'
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0f14; color: #dbe4ee;
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif; padding: 26px 28px 28px; }
  h1 { font-size: 23px; font-weight: 650; margin: 0 0 5px; letter-spacing: 0.1px; }
  .sub { color: #8b98a8; font-size: 12.5px; margin-bottom: 17px; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 17px 20px; }
  .chart { background: #0d131b; border: 1px solid #1d2a36; border-radius: 8px; padding: 12px 13px 9px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
  .chart-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .title { font-size: 13px; color: #e2ebf4; font-weight: 600; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; }
  .prop { color: #8fa2b7; font-size: 11px; white-space: nowrap; }
  .chart-sub { color: #77889a; font-size: 11px; margin: 4px 0 2px; font-variant-numeric: tabular-nums; }
  svg { display: block; width: 100%; height: auto; }
  .empty { padding: 40px; border: 1px dashed #2c3947; border-radius: 8px; color: #8b98a8; }
  .empty-chart { min-height: 170px; display: grid; place-items: center; color: #6f8092; font-size: 12px; }
  .legend { color: #7f8fa1; font-size: 11.5px; margin-top: 16px; line-height: 1.6; }
</style></head><body>
  <h1>Motion curves</h1>
  <div class="sub">${escapeHtml(targetDescription)} · ${report.summary.error} errors,
    ${report.summary.warn} warnings, ${report.summary.info} info</div>
  ${empty}
  <div class="grid">${charts}</div>
  <div class="legend">Each chart is normalised vertically to its own value range and horizontally to the motion's
    time window. Dashed vertical lines mark scenario steps. Thin curves show the actual sampled property; spring
    feel should show one clean overshoot and settle, not a flat ramp.</div>
</body></html>`;
}

function measuredSummary(measured) {
  return Object.entries(measured)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(', ');
}

function buildReportMarkdown(report, targetDescription) {
  const lines = [];
  const summary = report.summary;
  lines.push('# Motion audit report', '');
  lines.push(`**${summary.error} errors · ${summary.warn} warnings · ${summary.info} info**`, '');
  lines.push(`Target: ${escapeMarkdown(targetDescription)}`, '');
  lines.push(
    `Recorded ${formatSeconds(report.recording.durationMs)} at ${report.options.width}×${report.options.height} ` +
      `(scale ${report.options.scale}); ${report.recording.frames} frames, ` +
      `${report.recording.trackedElements} tracked elements.`,
    '',
  );
  lines.push(`Settle after scenario: ${report.options.settle} ms · slow-motion budget: ` +
    `${report.options.maxDuration} ms.`, '');
  const groups = [
    ['Errors', 'error'],
    ['Warnings', 'warn'],
    ['Info', 'info'],
  ];
  for (const [heading, severity] of groups) {
    const groupIssues = report.issues.filter(issue => issue.severity === severity);
    lines.push(`## ${heading} (${groupIssues.length})`, '');
    if (groupIssues.length === 0) {
      lines.push('None.', '');
      continue;
    }
    for (const issue of groupIssues) {
      const measured = measuredSummary(issue.measured);
      lines.push(
        `- **${formatSeconds(issue.time)} · \`${issue.rule}\` · ${escapeMarkdown(issue.element)}** — ` +
          `${escapeMarkdown(issue.message)}${measured ? ` _(${escapeMarkdown(measured)})_` : ''}`,
      );
    }
    lines.push('');
  }
  lines.push('## Motions', '');
  if (report.motions.length === 0) {
    lines.push('No continuous motion segments were long enough to table.', '');
  } else {
    lines.push('| Element | Property | Start → end | Duration | Overshoot | Reversals | Easing |');
    lines.push('| --- | --- | --- | ---: | ---: | ---: | --- |');
    for (const motion of report.motions) {
      const start = formatMotionValue(motion, motion.startValue);
      const end = formatMotionValue(motion, motion.endValue);
      lines.push(
        `| ${escapeMarkdown(motion.element)} | ${escapeMarkdown(motion.property)} | ` +
          `${escapeMarkdown(start)} → ${escapeMarkdown(end)} | ${Math.round(motion.durationMs)} ms | ` +
          `${formatNumber(motion.overshootPct)}% | ${motion.reversals} | ${motion.easing} |`,
      );
    }
    lines.push('');
  }
  lines.push('---', '');
  lines.push(
    'Times are relative to the first sampled frame. The filmstrip and curves are screenshots of ' +
      'generated contact-sheet HTML, not image libraries.',
    '',
  );
  return lines.join('\n');
}

async function writeOutputs(session, options, outDir, report, recording, screenshots) {
  const targetDescription = `${options.url || session.pageTarget?.url || 'attached page'} ` +
    `(${session.mode})`;
  const publicReport = { ...report, target: { url: options.url || session.pageTarget?.url || null, mode: session.mode } };
  delete publicReport.internal;
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(publicReport, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, 'report.md'), `${buildReportMarkdown(publicReport, targetDescription)}\n`, 'utf8');
  const filmstripHtml = buildFilmstripHtml(recording, screenshots, report, targetDescription);
  await renderHtmlToPng(session, filmstripHtml, 1400, join(outDir, 'filmstrip.png'), options.scale);
  const curvesHtml = buildCurvesHtml(
    recording,
    report.internal.motionSegments,
    report.internal.seriesById,
    report,
    targetDescription,
  );
  await renderHtmlToPng(session, curvesHtml, 1400, join(outDir, 'curves.png'), options.scale);
  return publicReport;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const scenario = loadScenario(options.scenario);
  const recorderSource = buildRecorderSource(options);
  const outDir = options.out
    ? resolve(options.out)
    : mkdtempSync(join(tmpdir(), 'motion-audit-report-'));
  mkdirSync(outDir, { recursive: true });
  let session = null;
  try {
    if (options.attach !== undefined) {
      session = await attachToBrowser(options, recorderSource);
    } else if (options.electron) {
      session = await launchElectron(options, recorderSource);
    } else {
      session = await launchChromium(options, recorderSource);
    }
    activeSession = session;
    const { recording, screenshots } = await collectRecording(session, options, scenario);
    const report = analyzeRecording(recording, options);
    const publicReport = await writeOutputs(session, options, outDir, report, recording, screenshots);
    const summary = publicReport.summary;
    if (options.json) {
      console.log(JSON.stringify(publicReport, null, 2));
      console.error(`[motion-audit] report written to ${outDir}`);
    } else {
      console.log(
        `[motion-audit] ${summary.error} errors, ${summary.warn} warnings, ${summary.info} info\n` +
          `[motion-audit] report: ${outDir}`,
      );
    }
    process.exitCode = summary.error > 0 ? 1 : 0;
  } catch (error) {
    console.error(`[motion-audit] ${formatError(error)}`);
    process.exitCode = 1;
  } finally {
    if (activeSession) {
      await activeSession.close();
      activeSession = null;
    }
    if (session && session !== activeSession) {
      await session.close();
    }
  }
}

async function handleSignal(signal) {
  if (handlingSignal) return;
  handlingSignal = true;
  console.error(`[motion-audit] ${signal}; cleaning up.`);
  if (activeSession) {
    await activeSession.close();
    activeSession = null;
  }
  process.exit(signal === 'SIGINT' ? 130 : 1);
}

process.once('SIGINT', () => {
  handleSignal('SIGINT');
});
process.once('SIGTERM', () => {
  handleSignal('SIGTERM');
});

main().catch(error => {
  console.error(`[motion-audit] ${formatError(error)}`);
  process.exitCode = 1;
});
