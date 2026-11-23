/**
 * The Hub's publishing rule, shared by the GitHub and local registries.
 *
 * Browsing and installing are open to everyone. Publishing is limited to the logins listed in
 * `publishers.json` in the registry repository. Publishing itself (uploading the pack) is not implemented yet:
 * an approved account gets an honest refusal rather than a fake success.
 */
import type { GithubAuth } from '../unify/github';
import type { HubPublishResult } from './types';

export const PUBLISH_SIGNED_OUT = 'Sign in to GitHub to publish.';
export const PUBLISH_NOT_APPROVED = 'Publishing is limited to approved accounts.';
export const PUBLISH_NOT_WIRED = 'Publishing is not wired yet: the Hub repository takes packs through a pull request.';

export function publishResultFor(auth: GithubAuth | undefined, publishers: string[]): HubPublishResult {
  if (!auth) return { ok: false, message: PUBLISH_SIGNED_OUT };
  const login = auth.login.trim().toLowerCase();
  const approved = publishers.some(publisher => publisher.trim().toLowerCase() === login);
  if (!approved) return { ok: false, message: PUBLISH_NOT_APPROVED };
  return { ok: false, message: PUBLISH_NOT_WIRED };
}
