import type { OAuthCliAccount } from './oauthCli';
import type { AccountUsage } from './usageTypes';
import { readClaudeUsage, claudeEventMetric } from './claudeUsage';
import { readCodexUsage } from './codexUsage';
import { readCursorUsage } from './cursorUsage';
import { readDeepSeekUsage } from './deepseekUsage';
import { readOpenCodeUsage } from './opencodeUsage';
import { readOpenRouterUsage } from './openRouterUsage';

export type UsageEntry = AccountUsage & { loading?: boolean };
export interface UsageTarget { id: string; provider: string; oauth?: OAuthCliAccount; secret?: () => Promise<string | undefined> }

/** Providers whose usage only exists in their web console, so Unify points there instead of guessing. */
const CONSOLE_ONLY: Record<string, { detail: string; fix: AccountUsage['fix'] }> = {
  gemini: { detail: 'Google AI Studio does not report Gemini API key usage. Check your quota in Google AI Studio.', fix: 'browser' },
  'google-gemini': { detail: 'Google AI Studio does not report Gemini API key usage. Check your quota in Google AI Studio.', fix: 'browser' },
  xai: { detail: 'xAI reports usage only through its team management console. Check usage there.', fix: 'browser' },
  groq: { detail: 'Groq does not report API key usage. Check usage in the Groq console.', fix: 'browser' },
  mistral: { detail: 'Mistral has no usage API for normal API keys. Check usage in the Mistral console.', fix: 'browser' },
};

export class AccountUsageService {
  private usage: Record<string, UsageEntry> = {};
  private readonly inFlight = new Map<string, Promise<void>>();
  private emitPending = false;
  constructor(private readonly onChange: (usage: Record<string, UsageEntry>) => void) {}

  snapshot(): Record<string, UsageEntry> { return { ...this.usage }; }

  private emit(): void {
    if (this.emitPending) return;
    this.emitPending = true;
    queueMicrotask(() => { this.emitPending = false; this.onChange(this.snapshot()); });
  }

  /** Refreshes targets and removes entries for accounts no longer present. */
  async refresh(targets: UsageTarget[], force = false): Promise<void> {
    const ids = new Set(targets.map(target => target.id));
    let changed = false;
    for (const id of Object.keys(this.usage)) if (!ids.has(id)) { delete this.usage[id]; changed = true; }
    if (changed) this.emit();
    await Promise.all(targets.map(target => this.refreshOne(target, force)));
  }

  refreshOne(target: UsageTarget, force = false): Promise<void> {
    const pending = this.inFlight.get(target.id);
    if (pending) return pending;
    const previous = this.usage[target.id];
    if (!force && previous && Date.now() - previous.fetchedAt < 60_000) return Promise.resolve();
    this.usage[target.id] = { ...(previous || { status: 'unavailable', metrics: [], fetchedAt: 0 }), loading: true };
    this.emit();
    const task = (async () => {
      const read = async (): Promise<AccountUsage> => {
        try {
          const missing = (fix: AccountUsage['fix']): AccountUsage => ({ status: 'error', metrics: [], detail: 'Account details are missing.', fix, fetchedAt: Date.now() });
          if (target.provider === 'claude-cli' || target.provider === 'codex-cli') {
            return !target.oauth ? missing('signin') : target.provider === 'claude-cli' ? await readClaudeUsage(target.oauth) : await readCodexUsage(target.oauth);
          }
          if (target.provider === 'deepseek-official' || target.provider === 'openrouter') {
            const secret = await target.secret?.();
            return !secret ? missing('key') : target.provider === 'deepseek-official' ? await readDeepSeekUsage(secret) : await readOpenRouterUsage(secret);
          }
          if (target.provider === 'cursor-acp') return await readCursorUsage();
          if (target.provider === 'opencode-go') return await readOpenCodeUsage(await target.secret?.());
          if (target.provider === 'self-hosted') return { status: 'unavailable', metrics: [], detail: 'Unify does not track usage for self-hosted servers.', fetchedAt: Date.now() };
          const consoleOnly = CONSOLE_ONLY[target.provider];
          if (consoleOnly) return { status: 'unavailable', metrics: [], ...consoleOnly, fetchedAt: Date.now() };
          return { status: 'unavailable', metrics: [], detail: 'This provider does not report usage to Unify yet.', fetchedAt: Date.now() };
        } catch { return { status: 'error', metrics: [], detail: 'Could not read account usage. Try again later.', fix: 'retry', fetchedAt: Date.now() }; }
      };
      let result = await read();
      if (result.status === 'error' && result.fix === 'retry') {
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (!this.usage[target.id]) return;
        result = await read();
      }
      if (this.usage[target.id]) { this.usage[target.id] = result; this.emit(); }
    })();
    this.inFlight.set(target.id, task);
    void task.finally(() => { if (this.inFlight.get(target.id) === task) this.inFlight.delete(target.id); });
    return task;
  }

  /** Merge a Claude rate limit update into cached usage. */
  applyClaudeEvent(accountId: string, info: unknown): void {
    const metric = claudeEventMetric(info); if (!metric) return;
    const metrics = [...(this.usage[accountId]?.metrics || [])];
    const index = metrics.findIndex(item => item.label === metric.label);
    if (index < 0) metrics.push(metric); else metrics[index] = metric;
    const plan = this.usage[accountId]?.plan;
    this.usage[accountId] = { status: 'ready', metrics, fetchedAt: Date.now(), ...(plan ? { plan } : {}), ...(this.inFlight.has(accountId) ? { loading: true } : {}) };
    this.emit();
  }
}
