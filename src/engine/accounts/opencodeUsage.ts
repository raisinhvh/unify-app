import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AccountUsage, AccountUsageMetric } from './usageTypes';

type Json = Record<string, unknown>;
const USAGE_URL = 'https://opencode.ai/inference/go/v1/usage';
const TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const SIGNED_OUT = "Unify can't find an OpenCode sign-in on this computer. Connect OpenCode Go in the OpenCode app, or check usage in the browser.";

const record = (value: unknown): Json | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const result = (status: AccountUsage['status'], metrics: AccountUsageMetric[] = [], detail?: string, fix?: AccountUsage['fix']): AccountUsage =>
	({ status, metrics, ...(detail ? { detail } : {}), ...(fix ? { fix } : {}), fetchedAt: Date.now() });

/** OpenCode keeps its credentials in the XDG data directory on every platform. */
function authFile(): string {
	return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode', 'auth.json');
}

/** OpenCode stores provider credentials as { "<provider>": { "type": "api", "key": "..." } }. */
async function storedKey(): Promise<string | undefined> {
	try {
		const entry = record(record(JSON.parse(await readFile(authFile(), 'utf8')))?.['opencode-go']);
		const key = entry?.type === 'api' ? entry.key : undefined;
		return typeof key === 'string' && key.trim() ? key.trim() : undefined;
	} catch { return undefined; }
}

const METERS: ReadonlyArray<readonly [string, string]> = [['rolling', '5-hour'], ['weekly', 'Weekly'], ['monthly', 'Monthly']];

/** One meter per plan limit: rolling is the 5-hour window, then weekly and monthly. */
function parseMeters(value: unknown): AccountUsageMetric[] {
	const usage = record(value);
	if (!usage) return [];
	const metrics: AccountUsageMetric[] = [];
	for (const [field, label] of METERS) {
		const meter = record(usage[field]);
		if (!meter) continue;
		// `rate-limited` means the window is used up even if a percent is omitted.
		const percent = finite(meter.percent) ? Math.min(100, Math.max(0, meter.percent)) : meter.status === 'rate-limited' ? 100 : NaN;
		if (!Number.isFinite(percent)) continue;
		const reset = typeof meter.resetsAt === 'string' ? Date.parse(meter.resetsAt) : NaN;
		metrics.push({ label, value: `${Math.round(percent)}% used`, usedPercent: percent, ...(Number.isFinite(reset) ? { resetsAt: reset } : {}) });
	}
	return metrics;
}

/**
 * Read OpenCode Go plan usage with the account's API key, or with the key the OpenCode CLI
 * saved during browser sign-in. Uses the documented Go usage endpoint; never returns fake meters.
 */
export async function readOpenCodeUsage(apiKey?: string): Promise<AccountUsage> {
	const key = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : await storedKey();
	if (!key) return result('unavailable', [], SIGNED_OUT, 'browser');
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(USAGE_URL, {
			method: 'GET', redirect: 'error', signal: controller.signal,
			headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
		});
		if (response.status === 401) return result('error', [], 'OpenCode rejected this API key. Replace it to see usage.', 'key');
		if (response.status === 403) return result('unavailable', [], 'This API key has no active OpenCode Go subscription. Subscribe in the OpenCode console to see usage.', 'browser');
		if (!response.ok) return result('error', [], 'Could not read OpenCode usage. Try again later.', 'retry');
		const text = await response.text();
		if (text.length > MAX_RESPONSE_BYTES) throw new Error('response too large');
		const data = record(JSON.parse(text));
		if (!data) throw new Error('invalid response');
		const metrics = parseMeters(data.usage);
		if (!metrics.length) return result('unavailable', [], 'OpenCode did not report usage for this account.', 'browser');
		return result('ready', metrics);
	} catch {
		return result('error', [], controller.signal.aborted
			? 'OpenCode usage request timed out. Check your connection and try again.'
			: 'Could not reach OpenCode usage service. Check your connection and try again.', 'retry');
	} finally {
		clearTimeout(timeout);
	}
}
