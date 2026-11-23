/**
 * Hub registry selection. The local fixture is the default, so dev builds and tests never need the network;
 * pass `'github'` to read the public registry repository instead.
 */
import { GithubHubRegistry } from './githubRegistry';
import { LocalHubRegistry } from './localRegistry';
import { HubRegistry } from './types';

export type HubRegistryKind = 'local' | 'github';

export function createHubRegistry(kind: HubRegistryKind = 'local'): HubRegistry {
  return kind === 'github' ? new GithubHubRegistry() : new LocalHubRegistry();
}

export * from './types';
export { installHubPack } from './install';
export { GithubHubRegistry, HUB_PUBLISHERS_URL } from './githubRegistry';
export { LocalHubRegistry } from './localRegistry';
export { PUBLISH_NOT_APPROVED, PUBLISH_NOT_WIRED, PUBLISH_SIGNED_OUT } from './publishing';
