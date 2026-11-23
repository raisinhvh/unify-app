/**
 * Organic timing engine (pure: no DOM, no Solid).
 *
 *   const plan = planRetype('Untitled chat', 'Fix login redirect');
 *   plan.steps   [{ at: 58, text: 'Untitled ', phase: 'erase' }, …, { at: 640, text: 'Fix login redirect', phase: 'type' }]
 *   plan.typed   ms when the last character lands (the caret blink + fade follows, see caretTiming)
 *
 * How a fast, confident person retypes a name on a shared screen:
 *   - the caret lands at the end (caretLead), then a held backspace erases back to the shared prefix; key repeat
 *     speeds up as it goes, and a long tail is erased a word at a time (ctrl+backspace);
 *   - a short beat;
 *   - the new suffix is typed with uneven rhythm: common bigrams roll faster, a space / punctuation / case change
 *     costs a little extra, and the odd word boundary gets a tiny hesitation;
 *   - total time is capped: long text compresses per-key time, and past a length whole words land per step.
 *
 * Deterministic: the same (from, to, seed) always gives the same plan. Without a seed the texts are hashed.
 */

export type RetypePhase = 'erase' | 'type';

export interface RetypeStep {
  /** Milliseconds from the start of the plan. Steps are in order. */
  at: number;
  /** What is displayed from this moment on. */
  text: string;
  phase: RetypePhase;
}

export interface RetypePlan {
  steps: RetypeStep[];
  /** Length (in characters) of the prefix both texts share; erasing stops here. */
  sharedPrefix: number;
  /** When the final text is fully shown (ms). The caret tail starts here. */
  typed: number;
  /** typed + the caret's blink and fade (ms). */
  total: number;
}

export interface RetypeOptions {
  /** 'fast' for status / loader labels: everything ~half as long. */
  speed?: 'normal' | 'fast';
  /** The caret is already showing (an interruption mid-animation): no lead-in, shorter beat. */
  continuing?: boolean;
}

/** Every timing constant, in milliseconds unless noted. */
export const retypeTiming = {
  /** Caret visible at the end before the first key. */
  caretLead: 70,
  /** First backspace repeat interval; each next interval is multiplied by eraseAcceleration down to eraseMin. */
  eraseFirst: 64,
  eraseAcceleration: 0.8,
  eraseMin: 18,
  /** More characters than this to erase: erase a word per step instead. */
  eraseWordThreshold: 24,
  /** Interval between word erases. */
  eraseWord: 68,
  /** Longest the erase phase may take; longer runs compress. */
  eraseBudget: 180,
  /** Beat between erasing and typing (± beatJitter). */
  beat: 100,
  beatJitter: 28,
  /** Mean interval between typed characters before jitter and compression. */
  typeBase: 36,
  /** Shortest a compressed key interval gets. */
  typeMin: 11,
  /** Longest the typing phase may take; longer runs compress. */
  typeBudget: 340,
  /** Suffixes longer than this type a word per step. */
  wordChunkThreshold: 28,
  /** At most this many word steps; extra words are merged into the steps. */
  maxWordChunks: 12,
  /** Interval for a word step (before jitter / compression). */
  typeWord: 62,
  /** Multiplier on everything for speed 'fast'. */
  fastFactor: 0.55,
} as const;

/** Caret tail after the last key: stays solid, one blink, then fades out. */
export const caretTiming = {
  hold: 140,
  off: 110,
  on: 120,
  fade: 180,
} as const;

/** Total of the caret tail (ms). */
export const caretTail = caretTiming.hold + caretTiming.off + caretTiming.on + caretTiming.fade;

/** Bigrams a touch typist rolls (both hands / home row): typed noticeably faster. */
const fastBigrams = new Set([
  'th', 'he', 'in', 'er', 'an', 're', 'on', 'at', 'en', 'nd', 'ti', 'es', 'or', 'te', 'of', 'ed', 'is', 'it', 'al',
  'ar', 'st', 'to', 'nt', 'ng', 'se', 'ha', 'as', 'ou', 'io', 'le', 've', 'co', 'me', 'de', 'hi', 'ri', 'ro', 'ic',
  'ne', 'ea', 'ra', 'ce', 'li', 'ch', 'll', 'be', 'ma', 'si', 'om', 'ur',
]);

const punctuation = /[.,:;!?\-_/\\()[\]{}'"`]/;

/** Characters, not UTF-16 units, so emoji and accents never split. */
function characters(text: string): string[] {
  return Array.from(text);
}

export function sharedPrefixLength(from: string, to: string): number {
  const fromChars = characters(from);
  const toChars = characters(to);
  let length = 0;
  while (length < fromChars.length && length < toChars.length && fromChars[length] === toChars[length]) length += 1;
  return length;
}

/** Small fast seeded PRNG (mulberry32): returns numbers in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash, the default seed for a pair of texts. */
export function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Log-normal-ish jitter around 1, clamped so no key is absurdly slow or fast. */
function jitter(random: () => number, spread: number): number {
  const gaussian = (random() + random() + random() - 1.5) * 1.15;
  return Math.min(1.55, Math.max(0.62, Math.exp(gaussian * spread)));
}

function isUpper(character: string): boolean {
  return character !== character.toLowerCase() && character === character.toUpperCase();
}

function isLower(character: string): boolean {
  return character !== character.toUpperCase() && character === character.toLowerCase();
}

/** How much longer than average the key `current` takes after `previous`. */
function keyCost(previous: string | undefined, current: string, random: () => number): number {
  let cost = jitter(random, 0.24);
  if (previous === undefined) return cost;
  if (fastBigrams.has((previous + current).toLowerCase())) cost *= 0.62;
  if (previous === ' ') {
    cost *= 1.45;
    // The odd word start gets a tiny hesitation (finding the next word).
    if (random() < 0.12) cost += 1.1;
  }
  if (punctuation.test(previous)) cost *= 1.7;
  if (isUpper(current) && !isUpper(previous)) cost *= 1.35;
  if (/\d/.test(current) && !/\d/.test(previous)) cost *= 1.25;
  if (previous === current) cost *= 0.85;
  return cost;
}

/** Fits a list of intervals into a budget (scales down, never below `minimum`). */
function fitIntervals(intervals: number[], budget: number, minimum: number): number[] {
  const total = intervals.reduce((sum, interval) => sum + interval, 0);
  if (total <= budget) return intervals;
  const scale = budget / total;
  return intervals.map(interval => Math.max(minimum, interval * scale));
}

/** Splits text into word chunks: each word keeps its trailing spaces / separator. */
function wordChunks(text: string): string[] {
  return text.match(/[^\s.\-_/]+[\s.\-_/]*|[\s.\-_/]+/g) ?? [text];
}

/** Merges neighbouring chunks until there are at most `limit`. */
function limitChunks(chunks: string[], limit: number): string[] {
  if (chunks.length <= limit) return chunks;
  const perStep = Math.ceil(chunks.length / limit);
  const merged: string[] = [];
  for (let index = 0; index < chunks.length; index += perStep) merged.push(chunks.slice(index, index + perStep).join(''));
  return merged;
}

/** Erase phase: returns [interval before each step, text after each step]. */
function planErase(fromChars: string[], sharedPrefix: number, speed: number, random: () => number): [number[], string[]] {
  const erasedCount = fromChars.length - sharedPrefix;
  if (erasedCount <= 0) return [[], []];
  const intervals: number[] = [];
  const texts: string[] = [];
  if (erasedCount > retypeTiming.eraseWordThreshold) {
    // ctrl+backspace: strip whole words from the end until the shared prefix.
    const tail = fromChars.slice(sharedPrefix).join('');
    const chunks = limitChunks(wordChunks(tail), retypeTiming.maxWordChunks);
    let remaining = tail;
    for (let index = chunks.length - 1; index >= 0; index -= 1) {
      remaining = remaining.slice(0, remaining.length - chunks[index].length);
      intervals.push(retypeTiming.eraseWord * jitter(random, 0.18) * speed);
      texts.push(fromChars.slice(0, sharedPrefix).join('') + remaining);
    }
  } else {
    // A held backspace: key repeat that accelerates.
    let interval: number = retypeTiming.eraseFirst;
    for (let count = 1; count <= erasedCount; count += 1) {
      intervals.push(interval * jitter(random, 0.08) * speed);
      texts.push(fromChars.slice(0, fromChars.length - count).join(''));
      interval = Math.max(retypeTiming.eraseMin, interval * retypeTiming.eraseAcceleration);
    }
  }
  return [fitIntervals(intervals, retypeTiming.eraseBudget * speed, retypeTiming.eraseMin * 0.6 * speed), texts];
}

/** Type phase: returns [interval before each step, text after each step]. */
function planType(toChars: string[], sharedPrefix: number, speed: number, random: () => number): [number[], string[]] {
  const suffix = toChars.slice(sharedPrefix);
  if (!suffix.length) return [[], []];
  const prefixText = toChars.slice(0, sharedPrefix).join('');
  const intervals: number[] = [];
  const texts: string[] = [];
  if (suffix.length > retypeTiming.wordChunkThreshold) {
    const chunks = limitChunks(wordChunks(suffix.join('')), retypeTiming.maxWordChunks);
    let typed = prefixText;
    let previous: string | undefined = toChars[sharedPrefix - 1];
    for (const chunk of chunks) {
      typed += chunk;
      intervals.push(retypeTiming.typeWord * jitter(random, 0.2) * (previous === undefined ? 1 : 1.1) * speed);
      texts.push(typed);
      previous = chunk.at(-1);
    }
  } else {
    let typed = prefixText;
    for (let index = 0; index < suffix.length; index += 1) {
      const previous = index === 0 ? toChars[sharedPrefix - 1] : suffix[index - 1];
      typed += suffix[index];
      intervals.push(retypeTiming.typeBase * keyCost(previous, suffix[index], random) * speed);
      texts.push(typed);
    }
  }
  return [fitIntervals(intervals, retypeTiming.typeBudget * speed, retypeTiming.typeMin * speed), texts];
}

/**
 * Plans retyping `from` into `to`. Pure and deterministic.
 * The first typed key lands right after the beat (its own interval is dropped: the beat already is the pause).
 */
export function planRetype(from: string, to: string, seed?: number, options: RetypeOptions = {}): RetypePlan {
  const fromChars = characters(from);
  const toChars = characters(to);
  const sharedPrefix = sharedPrefixLength(from, to);
  const speed = options.speed === 'fast' ? retypeTiming.fastFactor : 1;
  const random = seededRandom(seed ?? hashText(from + '\u0000' + to));
  if (from === to) return { steps: [], sharedPrefix, typed: 0, total: 0 };

  const [eraseIntervals, eraseTexts] = planErase(fromChars, sharedPrefix, speed, random);
  const [typeIntervals, typeTexts] = planType(toChars, sharedPrefix, speed, random);
  const steps: RetypeStep[] = [];
  let time = options.continuing ? 0 : retypeTiming.caretLead * speed;

  eraseIntervals.forEach((interval, index) => {
    // The first backspace follows the caret lead directly.
    time += index === 0 ? Math.min(interval, retypeTiming.eraseFirst * 0.5 * speed) : interval;
    steps.push({ at: Math.round(time), text: eraseTexts[index], phase: 'erase' });
  });

  if (typeIntervals.length) {
    if (eraseIntervals.length) {
      const beat = retypeTiming.beat + (random() * 2 - 1) * retypeTiming.beatJitter;
      time += beat * speed * (options.continuing ? 0.6 : 1);
    }
    typeIntervals.forEach((interval, index) => {
      time += index === 0 ? (eraseIntervals.length ? 0 : Math.min(interval, retypeTiming.typeBase * speed)) : interval;
      steps.push({ at: Math.round(time), text: typeTexts[index], phase: 'type' });
    });
  }

  const typed = steps.length ? steps[steps.length - 1].at : 0;
  return { steps, sharedPrefix, typed, total: typed + caretTail };
}
