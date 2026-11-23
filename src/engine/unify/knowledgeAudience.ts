/**
 * Audience rules for knowledge items (rules, skills and memory).
 *
 * The Knowledge screen stores audiences as Unify metadata in `<unifyHome>/knowledge.json`, keyed by the same
 * item ids the request handlers use (`rule:global:<slug>`, `skill:...`, `memory:...`). The store format is
 * `{ "items": { "<id>": { "audiences": ["main", ...] } } }`; a missing or empty list means "everyone", which
 * keeps rules written before audiences existed visible to every agent.
 *
 * `requests/knowledge.ts` owns the writer and keeps `DEFAULT_AUDIENCES` private, so the small read below mirrors
 * that store rather than importing the request module (which would also pull in UI request handlers).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getUnifyFeature, unifyHome } from './settings';
import type { Audience } from './requests/types';

/** Who is about to receive a piece of knowledge. */
export interface MainAudienceTarget {
  kind: 'main';
}

export interface SubagentAudienceTarget {
  kind: 'subagent';
  /** The `unify.subagents` profile name, without the `profile:` prefix. */
  profile: string;
}

export type AudienceTarget = MainAudienceTarget | SubagentAudienceTarget;

export interface AudienceApplyOptions {
  /** Overrides `knowledge.audiences` (tests use this instead of writing settings). */
  enabled?: boolean;
}

export interface KnowledgeAudienceReadOptions {
  /** Absolute path to `knowledge.json`; defaults to `<unifyHome>/knowledge.json`. */
  knowledgeFile?: string;
}

/** Rules with no audience metadata apply to every agent. */
export const DEFAULT_AUDIENCES: Audience[] = ['everyone'];

const PROFILE_PREFIX = 'profile:';

interface KnowledgeMetadata {
  audiences?: unknown;
}

interface KnowledgeStore {
  items?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Whether a stored value is one of the audience strings the Knowledge screen writes. */
export function isAudience(value: unknown): value is Audience {
  if (value === 'everyone' || value === 'main' || value === 'subagents') return true;
  return typeof value === 'string'
    && value.startsWith(PROFILE_PREFIX)
    && value.length > PROFILE_PREFIX.length;
}

/** The metadata store the Knowledge screen uses, for callers that already know the data home. */
export function knowledgeAudienceFile(home = unifyHome()): string {
  return path.join(home, 'knowledge.json');
}

function metadataItems(knowledgeFile: string): Record<string, KnowledgeMetadata> {
  try {
    const parsed = JSON.parse(fs.readFileSync(knowledgeFile, 'utf8')) as KnowledgeStore;
    return isRecord(parsed.items) ? parsed.items as Record<string, KnowledgeMetadata> : {};
  } catch {
    return {};
  }
}

function audiencesOfMetadata(metadata: KnowledgeMetadata | undefined): Audience[] {
  const stored = metadata?.audiences;
  const audiences = Array.isArray(stored) ? stored.filter(isAudience) : [];
  return audiences.length ? audiences : [...DEFAULT_AUDIENCES];
}

/** Audiences for one knowledge item id, defaulting to everyone when the metadata is missing or unreadable. */
export function audiencesFor(id: string, options?: KnowledgeAudienceReadOptions): Audience[] {
  return audiencesForMany([id], options)[0];
}

/** Audiences for several ids from a single read, for filtering a whole rules file at once. */
export function audiencesForMany(ids: readonly string[], options?: KnowledgeAudienceReadOptions): Audience[][] {
  const items = metadataItems(options?.knowledgeFile ?? knowledgeAudienceFile());
  return ids.map(id => audiencesOfMetadata(items[id]));
}

/**
 * Whether a rule targeting `audiences` should reach `target`.
 *
 * `everyone` reaches both kinds; `main` only the main agent; `subagents` every subagent; `profile:X` only the
 * subagent whose profile is exactly `X`. With the `knowledge.audiences` feature off, every rule applies to
 * every target (the legacy behaviour before audiences were enforced).
 */
export function appliesTo(
  audiences: readonly Audience[] | undefined,
  target: AudienceTarget,
  options?: AudienceApplyOptions,
): boolean {
  if (!(options?.enabled ?? getUnifyFeature('knowledge.audiences'))) return true;
  if (!audiences?.length || audiences.includes('everyone')) return true;
  if (target.kind === 'main') return audiences.includes('main');
  if (audiences.includes('subagents')) return true;
  return audiences.includes(`${PROFILE_PREFIX}${target.profile}`);
}
