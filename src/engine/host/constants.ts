/** Constants of the extension host: storage keys, limits, patterns and notes. */
import { SidebarFeatureKey } from '../sidebar/view';
import type { Actor } from './types';

export const SESSIONS_KEY = 'unify.ide.sessions.v1';
/** Chats kept per project folder; creating one more deletes the folder's oldest idle chat. */
export const MAX_CHATS_PER_PROJECT = 25;
export const SELECTED_MODEL_KEY = 'unify.ide.selectedModel.v1';
export const ACTIVE_SESSION_KEY = 'unify.ide.activeSession.v1';
export const CURSOR_MODELS_KEY = 'unify.ide.cursorModels.v1';
/** The id the Cursor login goes by wherever an account id is expected (usage, model routing, the Providers screen). */
export const CURSOR_ACCOUNT_ID = 'cursor-login';
export const MODEL_CHOICES_KEY = 'unify.ide.modelChoices.v1';
export const APPROVAL_KEY = 'unify.ide.approvalMode.v1';
export const TRANSCRIPTS_KEY = 'unify.ide.transcripts.v1';
export const TIMELINES_KEY = 'unify.ide.timelines.v1';
export const SYNC_OFFER_KEY = 'unify.ide.syncOffer.v1';
/** Feed notes for the turn that starts a chat's new agent session. */
export const RESUME_NOTES = {
  checkpoint: { icon: 'history', text: 'Resumed from checkpoint' },
  compact: { icon: 'compress', text: 'Context compacted into a summary' },
  idle: { icon: 'schedule', text: 'Started a fresh session after idle' },
} as const;
export const PROVIDER_USAGE_URLS = new Map([
  ['codex-cli', 'https://chatgpt.com/settings/usage?tab=overview'],
  ['claude-cli', 'https://claude.ai/settings/usage'],
  ['cursor-acp', 'https://cursor.com/dashboard?tab=usage'],
  ['deepseek-official', 'https://platform.deepseek.com/usage'],
  ['openrouter', 'https://openrouter.ai/activity'],
  ['opencode-go', 'https://opencode.ai/console'],
  ['mistral', 'https://console.mistral.ai/usage'],
]);
export const RISKY_ACTION = /\brm\s+-[a-z]*[rf]|\bsudo\b|\bchmod\b|\bchown\b|\bmkfs\b|\bdd\s+if=|\bformat\s+[a-z]:|\bdel\s+\/|Remove-Item|git\s+(push|reset\s+--hard|clean|checkout\s+--)|\b(curl|wget|iwr|Invoke-WebRequest)\b|\|\s*(sh|bash|iex)\b|\b(npm|pip|pnpm|yarn)\s+(publish|install\s+-g)|\bkill(all)?\b|\bshutdown\b|\.env\b|\.ssh|credentials|\.\.[\\/]|(^|\s)(\/|~|[A-Za-z]:[\\/])/i;
export const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const MAX_IMAGES = 8;
export const MAX_IMAGE_BASE64 = 14_000_000;
/** Customize page switches and the `unify` settings that store them. */
export const FEATURE_SETTINGS: Record<SidebarFeatureKey, string> = {
  activityRail: 'features.activityRail', autoName: 'features.autoName', shareRules: 'features.shareRules', editorContext: 'features.editorContext',
  reduceMotion: 'features.reduceMotion', updateChecks: 'updates.check', mirror: 'runtime.mirror', reviewAgent: 'features.reviewAgent',
  fileSummaries: 'features.fileSummaries', smartAuto: 'features.smartAuto',
  autoCompact: 'experimental.autoCompact', batching: 'experimental.batching', trimTools: 'experimental.trimTools', voice: 'features.voice',
  rustTools: 'runtime.rustTools', powershellSpeedups: 'runtime.powershellSpeedups',
};
export const PARENT: Actor = { owner: 'parent', label: '', readOnly: false };
export const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
export const DELEGATE_SERVER = 'unify';
/** How long an account that reported a usage limit is tried after the others. */
export const LIMIT_COOLDOWN_MS = 30 * 60 * 1000;
/** A chat approval or question left unanswered this long resolves as rejected/skipped, so a lost reply cannot hang a turn. */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
/** Turns other agents' messages may start for an idle chat before the user next writes in it. */
export const MAX_MESSAGE_WAKES = 10;
/** A ChatGPT (Codex) runtime launches with at least this much token validity left, so long turns do not outlive it. */
export const CODEX_TOKEN_MARGIN_MS = 45 * 60 * 1000;
/** Errors from a ChatGPT (Codex) turn that mean its access token was rejected. */
export const CODEX_AUTH_ERROR = /\b401\b|unauthori[sz]ed|invalid[^.\n]*token|token[^.\n]*expired/i;
/** Reasoning effort levels from cheapest to most expensive; unknown values sort last. */
export const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
