/**
 * The Toolpack Hub reads the public `raisinhvh/unify-hub` repository. Tests pass their own `HubRegistry`
 * through the request context instead of a built-in fake.
 */
import { GithubHubRegistry } from './githubRegistry';
import { HubRegistry } from './types';

export function createHubRegistry(): HubRegistry {
  return new GithubHubRegistry();
}

export * from './types';
export { installHubPack, packScriptHash } from './install';
export { findHubUpdates } from './updates';
export { toolpackIdFor } from './ids';
export { GithubHubRegistry, HUB_BRANCH, HUB_INDEX_URL, HUB_PUBLISHERS_URL, HUB_REPOSITORY } from './githubRegistry';
export { PUBLISH_NOT_APPROVED, PUBLISH_SIGNED_OUT, publishAccessError } from './publishing';
export { nextPackVersion, publishHubPack, scanPublishFiles, validateToolpackSource } from './publish';
export type { PublishHubPackOptions, SafetyFinding, ValidatedToolpack } from './publish';
