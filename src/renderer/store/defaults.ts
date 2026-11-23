/**
 * The state the renderer starts from before the engine's first messages arrive.
 * Mirrors `initialSidebarState()` in the engine's view.ts; it is copied (not imported) because that module
 * pulls Node APIs in. Keep the two in step when the engine adds fields.
 */
import type { SidebarFeatures, SidebarViewState } from '../protocol';

export const defaultFeatures = (): SidebarFeatures => ({
  activityRail: true,
  autoName: true,
  shareRules: true,
  editorContext: true,
  reduceMotion: false,
  updateChecks: true,
  mirror: true,
  reviewAgent: false,
  fileSummaries: true,
  smartAuto: false,
  autoCompact: false,
  batching: false,
  trimTools: true,
  voice: true,
  rustTools: true,
  powershellSpeedups: true,
} as SidebarFeatures);

export function defaultViewState(): SidebarViewState {
  return {
    page: 'chat',
    approvalMode: 'ask',
    subagentProfiles: [],
    instructions: [],
    toolpacks: [],
    features: defaultFeatures(),
    unifyFeatures: {},
    shutdown: { armed: false, phase: 'idle' },
    nameModel: {},
    reviewModel: {},
    summaryModel: {},
    deciderModel: {},
    explorerModel: {},
    smartAutoRanks: [],
    autoCompactTokens: 70_000,
    voiceCommands: [],
    voiceAvailable: false,
    processPriority: 'normal',
    slashCommands: [],
    jobs: {},
    accessibility: {} as SidebarViewState['accessibility'],
    sync: { connected: false, auto: true } as SidebarViewState['sync'],
    railIcons: [],
    sessions: [],
    models: [],
    providerLabel: 'No provider',
    accountLabel: 'No account connected',
    accountConnected: false,
    accounts: [],
    usage: {},
    dependencies: [],
    cursor: { connected: false, label: 'Not connected' },
    messages: {},
    timeline: {},
    tools: [],
    subagents: {},
    diffs: [],
    runStates: {},
    queues: {},
  };
}

/** DSH hosts embed the first state as JSON in #boot-state; Unify may do the same. Missing is fine. */
export function readBootState(): Partial<SidebarViewState> | undefined {
  const element = document.getElementById('boot-state');
  if (!element?.textContent) return undefined;
  try {
    const parsed = JSON.parse(element.textContent) as Partial<SidebarViewState>;
    element.remove();
    return parsed;
  } catch {
    return undefined;
  }
}
