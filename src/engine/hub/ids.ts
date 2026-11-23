/**
 * Hub ids vs toolpack ids.
 *
 * Hub packs use ids such as `roblox-studio`, but a toolpack id may only contain lowercase letters, digits and
 * underscores. `toolpackIdFor` maps the Hub id to a valid pack id; installs write that id and keep the original
 * Hub id in `meta.json.hubId` so the extension can match the two lists.
 */
const TOOLPACK_NAME = /^[a-z][a-z0-9_]{0,31}$/;

/** `roblox-studio` -> `roblox_studio`, `web-search` -> `web_search`. */
export function toolpackIdFor(hubId: string): string {
  const sanitized = hubId.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const withLetter = /^[a-z]/.test(sanitized) ? sanitized : `pack_${sanitized}`;
  const id = withLetter.slice(0, 32);
  if (!TOOLPACK_NAME.test(id)) throw new Error(`Cannot turn Hub id "${hubId}" into a toolpack id.`);
  return id;
}
