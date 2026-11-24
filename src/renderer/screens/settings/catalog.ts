/**
 * Everything the Settings screen can change, as one flat list of rows.
 *
 * Rows come from two places:
 *   1. `featureDefinitions` (store/features.ts), the Unify feature toggles. Generated, never listed by hand:
 *      a new feature appears in Settings as soon as it is added there (boolean → toggle, string with options →
 *      select, number → stepper), in the section named by its `group`.
 *   2. The settings the engine already had (SidebarFeatures, accessibility, auto compaction, process priority).
 *
 * A row whose `parent` toggle is off collapses away, so turning a feature off never leaves its options behind.
 * Children are found by id prefix (`motion.organic.rename` hangs under `motion.organic`) plus `extraParents`.
 */
import { post } from '../../bridge';
import type { JSX } from 'solid-js';
import type { SidebarFeatures } from '../../protocol';
import { viewState } from '../../store';
import { feature, featureDefinitions, setFeature, type FeatureDefinition, type FeatureId, type FeatureValue } from '../../store/features';

export type SectionId =
  | 'appearance'
  | 'motion'
  | 'chats'
  | 'agents'
  | 'runtime'
  | 'knowledge'
  | 'editor'
  | 'usage'
  | 'toolpacks'
  | 'notifications'
  | 'power'
  | 'accessibility'
  | 'accounts'
  | 'sync'
  | 'about';

export interface SectionInfo {
  id: SectionId;
  title: string;
  lede: string;
  /** Extra words the search matches for sections drawn by hand (theme names, accounts, updates). */
  keywords?: string;
}

/** Nav order. Appearance first (Figma 25), then features, then the hand-drawn sections. */
export const sections: SectionInfo[] = [
  { id: 'appearance', title: 'Appearance', lede: 'How Unify looks on this device.', keywords: 'theme colour color dark light walnut graphite paper slate moss ink oled density size text' },
  { id: 'motion', title: 'Motion', lede: 'How things move. The real value always changes at once; motion is only for show.' },
  { id: 'chats', title: 'Chats', lede: 'The Chats panel, panes and what each message carries.' },
  { id: 'agents', title: 'Agents', lede: 'How chat agents run. Subagents, the explorer, helper models and messaging live in Agents.', keywords: 'subagent profile explorer helper models decider smart auto rank review name summary messaging' },
  { id: 'runtime', title: 'Runtime', lede: 'Tools and speedups for agent processes. Applies to agents started after a change.' },
  { id: 'knowledge', title: 'Knowledge', lede: 'Rules, skills and memory.' },
  { id: 'editor', title: 'Editor', lede: 'The Files screen and its code editor.' },
  { id: 'usage', title: 'Usage', lede: 'Plan limits and the usage meter.' },
  { id: 'toolpacks', title: 'Toolpacks', lede: 'Toolpacks and the Hub.' },
  { id: 'notifications', title: 'Notifications', lede: 'When Unify gets your attention.' },
  { id: 'power', title: 'Power', lede: 'Send /shutdown in a chat to turn the PC off once agents finish.', keywords: 'shutdown shut down idle sleep' },
  { id: 'accessibility', title: 'Accessibility', lede: 'Reading comfort and larger targets.' },
  { id: 'accounts', title: 'Accounts', lede: 'Provider accounts Unify can run agents with.', keywords: 'provider sign in login api key claude codex cursor setup' },
  { id: 'sync', title: 'Sync', lede: 'Back up settings, rules and memory to a private GitHub repository.', keywords: 'github backup upload download token sign in login' },
  { id: 'about', title: 'About', lede: 'Version, updates and setup.', keywords: 'version update release setup wizard data folder' },
];

export const sectionById = Object.fromEntries(sections.map(section => [section.id, section])) as Record<SectionId, SectionInfo>;

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingRow {
  key: string;
  section: SectionId;
  label: string;
  description: string;
  /** 'custom' rows (Agents screen) draw `control` instead of a built-in one; read and write go unused. */
  kind: 'toggle' | 'select' | 'number' | 'custom';
  control?: () => JSX.Element;
  /** Id of the control the label names (`<label for>`), for custom rows with a text field. */
  labelFor?: string;
  /** Extra condition for showing the row, on top of its parents (e.g. Effort only when the model has efforts). */
  shown?: () => boolean;
  options?: SettingOption[];
  min?: number;
  max?: number;
  step?: number;
  /** Turns the stored number into what the field shows (70000 → "70k"). */
  format?: (value: number) => string;
  /** Key of the toggle that must be on for this row to show. */
  parent?: string;
  read: () => FeatureValue;
  write: (value: FeatureValue) => void;
}

/* 1. Unify features, generated. */

const groupSection: Record<FeatureDefinition['group'], SectionId> = {
  Appearance: 'appearance',
  Motion: 'motion',
  Agents: 'agents',
  Knowledge: 'knowledge',
  Chats: 'chats',
  Editor: 'editor',
  Usage: 'usage',
  Toolpacks: 'toolpacks',
  Notifications: 'notifications',
  Power: 'power',
};

/** Parents the id prefix cannot express. */
const extraParents: Partial<Record<FeatureId, FeatureId>> = {
  'editor.minimap': 'editor.enabled',
};

/** Ranges for number features (default 0–999, step 1). */
const numberRanges: Partial<Record<FeatureId, { min: number; max: number; step?: number }>> = {
  'agents.maxParallel': { min: 1, max: 16 },
  'agents.stuckCommandMinutes': { min: 0, max: 120 },
  'chats.maxPerProject': { min: 1, max: 50 },
};

/** Shorter Settings wording where the definition's own text is long. */
const descriptionOverrides: Partial<Record<FeatureId, string>> = {
  'power.rememberArmed': 'Keep /shutdown armed if Unify restarts.',
};

/**
 * Features with no switch of their own. `power.shutdownWhenIdle` is armed with the `/shutdown` command and
 * cancelled from the bar it shows by the composer.
 */
const commandOnlyFeatures = new Set<FeatureId>(['power.shutdownWhenIdle']);

/** Labels for option values; anything missing is humanised ("same-chat" → "Same chat"). */
const optionLabels: Record<string, string> = {
  everyone: 'Everyone',
  'same-chat': 'Same chat only',
  'parent-child': 'Parent and child only',
  'space-mono': 'Space Mono',
  'ibm-plex-mono': 'IBM Plex Mono',
  'jetbrains-mono': 'JetBrains Mono',
  'geist-mono': 'Geist Mono',
  'ibm-plex-sans': 'IBM Plex Sans',
  'space-grotesk': 'Space Grotesk',
  'fira-code': 'Fira Code',
  'source-code-pro': 'Source Code Pro',
  'cascadia-code': 'Cascadia Code',
};

export function humanize(value: string): string {
  const spaced = value.replace(/[-_.]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function featureParent(id: FeatureId): string | undefined {
  const explicit = extraParents[id];
  if (explicit) return `feature:${explicit}`;
  const parts = id.split('.');
  for (let length = parts.length - 1; length > 0; length -= 1) {
    const candidate = parts.slice(0, length).join('.') as FeatureId;
    const definition = featureDefinitions[candidate] as FeatureDefinition | undefined;
    if (definition && typeof definition.defaultValue === 'boolean') return `feature:${candidate}`;
  }
  return undefined;
}

function featureRows(): SettingRow[] {
  return (Object.keys(featureDefinitions) as FeatureId[]).filter(id => !commandOnlyFeatures.has(id)).map(id => {
    const definition = featureDefinitions[id] as FeatureDefinition;
    const kind: SettingRow['kind'] =
      typeof definition.defaultValue === 'boolean' ? 'toggle' : typeof definition.defaultValue === 'number' ? 'number' : 'select';
    const range = numberRanges[id] ?? { min: 0, max: 999 };
    return {
      key: `feature:${id}`,
      section: groupSection[definition.group],
      label: definition.label,
      description: descriptionOverrides[id] ?? definition.description,
      kind,
      options: definition.options?.map(value => ({ value, label: optionLabels[value] ?? humanize(value) })),
      min: range.min,
      max: range.max,
      step: range.step ?? 1,
      parent: featureParent(id),
      read: () => feature<FeatureValue>(id),
      write: value => setFeature(id, value),
    };
  });
}

/* 2. Engine settings that already exist. */

type EngineFeatureKey = keyof SidebarFeatures;

const engineFeatures: { key: EngineFeatureKey; section: SectionId; label: string; description: string; parent?: string }[] = [
  { key: 'reduceMotion', section: 'motion', label: 'Reduce motion', description: 'Swap movement for short crossfades everywhere. Follows your system setting too.' },
  { key: 'activityRail', section: 'chats', label: 'Activity colours', description: 'Chats show gray while running, amber when they need you and blue when they finished while you were elsewhere.' },
  { key: 'autoName', section: 'chats', label: 'Name chats automatically', description: 'A name model turns your first message into a short title. Renaming a chat yourself keeps your name.' },
  { key: 'editorContext', section: 'chats', label: 'Send editor context', description: 'Adds your open files, cursor position, selection and diagnostics to each message.' },
  { key: 'voice', section: 'chats', label: 'Voice input', description: 'A microphone button next to Send types what you say, using Windows speech recognition.' },
  { key: 'mirror', section: 'agents', label: 'Private workspace copy', description: "Each new chat edits its own copy of the workspace. Turn off to let agents edit your real files. Applies to new chats." },
  { key: 'reviewAgent', section: 'agents', label: 'Separate review agent', description: 'A separate read-only agent reviews each /job round. When off, the chat agent reviews its own work.' },
  { key: 'smartAuto', section: 'agents', label: 'Smart Auto', description: 'Adds Smart Auto to the model menu: a decider model picks a model and effort for each message.' },
  { key: 'autoCompact', section: 'agents', label: 'Auto compaction', description: 'Past the limit below, your next message starts a fresh session; earlier messages are saved by topic and summarised.' },
  { key: 'trimTools', section: 'runtime', label: 'Trim built-in tools', description: "Leaves out provider tools that cannot work in Unify or that Unify replaces. Saves thousands of tokens per request." },
  { key: 'batching', section: 'runtime', label: 'Advanced batching', description: 'Agents get a batch tool: several tool calls run in parallel and come back as one result.' },
  { key: 'fileSummaries', section: 'runtime', label: 'File summaries', description: 'Outlines come from code for TS/JS, Python, Go, Rust and Lua; the summary model covers the rest.' },
  { key: 'rustTools', section: 'runtime', label: 'Fast search tools', description: 'Downloads ripgrep, fd and sd (checked against their SHA-256) and steers agent shells to them.' },
  { key: 'powershellSpeedups', section: 'runtime', label: 'PowerShell speedups', description: 'Starts agent PowerShells without telemetry or update checks and teaches agents the fast patterns.' },
  { key: 'shareRules', section: 'knowledge', label: 'Share global rules and skills', description: "Before each Claude turn, copies your all-project rules and skills into that account." },
  { key: 'updateChecks', section: 'about', label: 'Check for updates', description: 'Looks for a new release when Unify starts and tells you before installing anything.' },
];

function engineFeatureRows(): SettingRow[] {
  return engineFeatures.map(item => ({
    key: `engine:${item.key}`,
    section: item.section,
    label: item.label,
    description: item.description,
    kind: 'toggle',
    parent: item.parent,
    read: () => !!(viewState.features as Partial<SidebarFeatures>)[item.key],
    write: value => post({ type: 'setFeature', key: item.key, enabled: !!value }),
  }));
}

/* Accessibility (SidebarAccessibility; the renderer starts with an empty object until customizeState arrives). */

type Accessibility = typeof viewState.accessibility;

const accessibilityDefaults: Accessibility = {
  textScale: 1,
  lineSpacing: 'normal',
  spacing: 'default',
  letterSpacing: 'normal',
  highContrast: false,
  largeTargets: false,
  underlineLinks: false,
};

export function accessibility(): Accessibility {
  return { ...accessibilityDefaults, ...viewState.accessibility };
}

function saveAccessibility<Key extends keyof Accessibility>(key: Key, value: Accessibility[Key]): void {
  post({ type: 'saveAccessibility', accessibility: { ...accessibility(), [key]: value } });
}

function accessibilityRow<Key extends keyof Accessibility>(
  key: Key,
  section: SectionId,
  label: string,
  description: string,
  extra: Partial<SettingRow> = {},
): SettingRow {
  const sample = accessibilityDefaults[key];
  return {
    key: `accessibility:${key}`,
    section,
    label,
    description,
    kind: typeof sample === 'boolean' ? 'toggle' : typeof sample === 'number' ? 'number' : 'select',
    read: () => accessibility()[key] as FeatureValue,
    write: value => saveAccessibility(key, value as Accessibility[Key]),
    ...extra,
  };
}

function engineExtraRows(): SettingRow[] {
  return [
    accessibilityRow('spacing', 'appearance', 'Density', 'Compact fits more rows in lists and panes.', {
      options: [
        { value: 'compact', label: 'Compact' },
        { value: 'default', label: 'Default' },
        { value: 'roomy', label: 'Comfortable' },
      ],
    }),
    accessibilityRow('textScale', 'appearance', 'Text size', 'Applies to chats and panels. The editor has its own size.', {
      min: 0.85,
      max: 1.6,
      step: 0.05,
      format: value => `${Math.round(value * 100)}%`,
    }),
    {
      key: 'engine:autoCompactTokens',
      section: 'agents',
      label: 'Compaction limit',
      description: 'Conversation size, in tokens, that starts a fresh session.',
      kind: 'number',
      min: 20_000,
      max: 400_000,
      step: 10_000,
      format: value => `${Math.round(value / 1000)}k`,
      parent: 'engine:autoCompact',
      read: () => viewState.autoCompactTokens,
      write: value => post({ type: 'saveAutoCompactTokens', tokens: Number(value) }),
    },
    {
      key: 'engine:processPriority',
      section: 'runtime',
      label: 'Process priority',
      description: 'CPU priority for agent runtimes and the commands they run.',
      kind: 'select',
      options: [
        { value: 'normal', label: 'Normal' },
        { value: 'aboveNormal', label: 'Above normal' },
        { value: 'high', label: 'High' },
      ],
      read: () => viewState.processPriority,
      write: value => post({ type: 'saveProcessPriority', priority: value as typeof viewState.processPriority }),
    },
    accessibilityRow('lineSpacing', 'accessibility', 'Line spacing', 'More room between lines of text.', {
      options: [
        { value: 'normal', label: 'Normal' },
        { value: 'relaxed', label: 'Relaxed' },
        { value: 'loose', label: 'Loose' },
      ],
    }),
    accessibilityRow('letterSpacing', 'accessibility', 'Letter spacing', 'Wider spacing between letters.', {
      options: [
        { value: 'normal', label: 'Normal' },
        { value: 'wide', label: 'Wide' },
      ],
    }),
    accessibilityRow('highContrast', 'accessibility', 'High contrast', 'Stronger text and borders on every surface.'),
    accessibilityRow('largeTargets', 'accessibility', 'Larger click targets', 'Taller rows and bigger buttons.'),
    accessibilityRow('underlineLinks', 'accessibility', 'Underline links', 'Links stay underlined, not only on hover.'),
  ];
}

/*
 * Rows the Agents screen (screens/agents) draws instead of Settings, so each option lives in one place.
 * They stay in this catalog (one row builder, parents and depth still resolve) but never reach `settingRows`.
 */
const agentsScreenKeys = new Set<string>([
  'feature:agents.messaging',
  'feature:agents.messaging.scope',
  'feature:agents.messaging.showInChat',
  'feature:agents.maxParallel',
  'feature:agents.blockNativeAgents',
  'feature:agents.imagesToParent',
  'feature:agents.explorerRanges',
  'engine:autoName',
  'engine:reviewAgent',
  'engine:smartAuto',
]);

const allRows: SettingRow[] = [...engineExtraRows(), ...featureRows(), ...engineFeatureRows()];

/** Every row, in display order within its section. Built once; values are read reactively. */
export const settingRows: SettingRow[] = (() => {
  const all = allRows.filter(row => !agentsScreenKeys.has(row.key));
  // Within a section: rows keep their source order, but children always follow their parent.
  const ordered: SettingRow[] = [];
  const placed = new Set<string>();
  const place = (row: SettingRow) => {
    if (placed.has(row.key)) return;
    placed.add(row.key);
    ordered.push(row);
    for (const child of all) if (child.parent === row.key) place(child);
  };
  for (const row of all) if (!row.parent || !all.some(item => item.key === row.parent)) place(row);
  // The order within a section: reduce motion leads Motion, Density/Text size lead Appearance (already first).
  const sectionOrder = new Map(sections.map((section, index) => [section.id, index]));
  const leading = new Set(['engine:reduceMotion']);
  return ordered
    .map((row, index) => ({ row, index }))
    .sort((first, second) =>
      (sectionOrder.get(first.row.section)! - sectionOrder.get(second.row.section)!)
      || (Number(leading.has(second.row.key)) - Number(leading.has(first.row.key)))
      || first.index - second.index)
    .map(item => item.row);
})();

const rowByKey = new Map(allRows.map(row => [row.key, row]));

/** One of the rows the Agents screen draws (see `agentsScreenKeys`). Throws on a key it does not own. */
export function agentsScreenRow(key: string): SettingRow {
  const row = rowByKey.get(key);
  if (!row || !agentsScreenKeys.has(key)) throw new Error(`"${key}" is not an Agents screen row.`);
  return row;
}

/** Whether every toggle above this row is on (a row under an off parent is hidden). */
export function rowVisible(row: SettingRow): boolean {
  let parentKey = row.parent;
  while (parentKey) {
    const parent = rowByKey.get(parentKey);
    if (!parent) return true;
    if (!parent.read()) return false;
    parentKey = parent.parent;
  }
  return true;
}

/** How deep under parents the row hangs (0 = top level). */
export function rowDepth(row: SettingRow): number {
  let depth = 0;
  let parentKey = row.parent;
  while (parentKey && rowByKey.has(parentKey)) {
    depth += 1;
    parentKey = rowByKey.get(parentKey)!.parent;
  }
  return depth;
}

export function rowsIn(section: SectionId): SettingRow[] {
  return settingRows.filter(row => row.section === section);
}

/** Case-insensitive match on label, description, section title and option labels. */
export function rowMatches(row: SettingRow, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  const haystack = [row.label, row.description, sectionById[row.section].title, ...(row.options?.map(option => option.label) ?? [])]
    .join(' ')
    .toLowerCase();
  return text.split(/\s+/).every(word => haystack.includes(word));
}

export function sectionMatches(section: SectionInfo, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  const haystack = `${section.title} ${section.keywords ?? ''}`.toLowerCase();
  return text.split(/\s+/).every(word => haystack.includes(word));
}
