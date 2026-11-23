/**
 * Combined AI usage across accounts: DSH's maths, unchanged (media/sidebar.js usageSummary/resetIn/resetColor,
 * lines ~1163-1269). Each account's binding metric is its highest used percent; accounts count in proportion
 * to their plan's monthly price, and unpriced plans count as the average priced one.
 */
import { createMemo, createRoot } from 'solid-js';
import type { SidebarAccount, SidebarPlan, SidebarUsageMetric } from '../protocol';
import { viewState } from './index';
import { accountGroupOrder, providerColor } from './providers';

export interface UsageEntry {
  account: Pick<SidebarAccount, 'id' | 'provider' | 'label'>;
  binding: SidebarUsageMetric & { usedPercent: number };
  used: number;
  plan?: SidebarPlan;
  color: string;
  weight: number;
  /** Share of the combined meter this account represents, 0-100. */
  share: number;
  /** Width of this account's segment in the stacked bar, 0-100. */
  width: number;
}

export interface UsageSummary {
  entries: UsageEntry[];
  /** Accounts that should report usage but have none yet. */
  missing: number;
  /** Combined usage percent, rounded. */
  combined: number;
}

export const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

function cursorUsageAccount() {
  const cursor = viewState.cursor;
  return cursor.connected ? { id: 'cursor-login', provider: 'cursor-acp', label: cursor.label || 'Cursor account' } : undefined;
}

export function computeUsageSummary(): UsageSummary {
  const entries: UsageEntry[] = [];
  const shades = new Map<string, number>();
  const cursor = cursorUsageAccount();
  for (const provider of accountGroupOrder) {
    const accounts = [
      ...viewState.accounts.filter(item => item.provider === provider),
      ...(cursor && provider === 'cursor-acp' ? [cursor] : []),
    ];
    for (const account of accounts) {
      const metrics = (viewState.usage[account.id]?.metrics || []).filter(
        (metric): metric is SidebarUsageMetric & { usedPercent: number } =>
          typeof metric.usedPercent === 'number' && Number.isFinite(metric.usedPercent),
      );
      if (!metrics.length) continue;
      const binding = metrics.reduce((best, metric) => (metric.usedPercent > best.usedPercent ? metric : best));
      const used = clampPercent(binding.usedPercent);
      const shade = shades.get(account.provider) || 0;
      shades.set(account.provider, shade + 1);
      const color = shade
        ? `color-mix(in srgb, ${providerColor(account.provider)} ${Math.max(44, 100 - shade * 28)}%, white)`
        : providerColor(account.provider);
      entries.push({ account, binding, used, plan: viewState.usage[account.id]?.plan, color, weight: 0, share: 0, width: 0 });
    }
  }
  const prices = entries
    .map(entry => entry.plan?.monthlyUsd)
    .filter((price): price is number => typeof price === 'number' && Number.isFinite(price) && price >= 0);
  const fallback = prices.length ? prices.reduce((sum, price) => sum + price, 0) / prices.length : 1;
  for (const entry of entries) {
    const price = entry.plan?.monthlyUsd;
    entry.weight = typeof price === 'number' && Number.isFinite(price) && price >= 0 ? price : fallback;
  }
  if (!entries.some(entry => entry.weight > 0)) for (const entry of entries) entry.weight = 1;
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  for (const entry of entries) {
    entry.share = (entry.weight / total) * 100;
    entry.width = (entry.used * entry.weight) / total;
  }
  const eligible = new Set(entries.map(entry => entry.account.id));
  const missing = viewState.accounts.filter(
    account => account.provider !== 'openai' && account.provider !== 'anthropic' && !eligible.has(account.id),
  ).length;
  return { entries, missing, combined: Math.round(entries.reduce((sum, entry) => sum + entry.width, 0)) };
}

export const usageSummary = createRoot(() => createMemo(computeUsageSummary));

/** "45m", "3h 12m", "2d 4h", or '' once the time has passed. */
export function resetIn(at: number | undefined): string {
  if (!at) return '';
  const minutes = Math.ceil((at - Date.now()) / 60000);
  if (minutes <= 0) return '';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}

/** Green when usage comes back soon, red when it is days away (log scale from 30 minutes to 5 days). */
export function resetColor(at: number): string {
  const hours = Math.max(0.5, Math.min(120, (at - Date.now()) / 3600000));
  return `hsl(${Math.round(130 * (1 - Math.log(hours / 0.5) / Math.log(240)))} 65% 55%)`;
}
