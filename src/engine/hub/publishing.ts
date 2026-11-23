/**
 * The Hub's publishing access rule.
 *
 * Browsing and installing are open to everyone. Publishing is limited to the GitHub logins listed in
 * `publishers.json` in the Hub repository.
 */
import type { GithubAuth } from '../unify/github';
import type { HubPublishResult } from './types';

export const PUBLISH_SIGNED_OUT = 'Sign in to GitHub to publish.';
export const PUBLISH_NOT_APPROVED = 'Publishing is limited to approved accounts.';

/** Returns a refusal if `auth` is missing or not in `publishers`, or undefined when publishing is allowed. */
export function publishAccessError(
  auth: GithubAuth | undefined,
  publishers: string[],
): HubPublishResult | undefined {
  if (!auth) return { ok: false, message: PUBLISH_SIGNED_OUT };
  const login = auth.login.trim().toLowerCase();
  const approved = publishers.some(publisher => publisher.trim().toLowerCase() === login);
  if (!approved) return { ok: false, message: PUBLISH_NOT_APPROVED };
  return undefined;
}
