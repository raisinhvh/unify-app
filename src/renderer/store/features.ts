/**
 * Feature toggles (shared contract — every screen reads from here, Settings writes).
 *
 * Unify is heavily customizable: every feature sits behind one of these ids from the start.
 * Source of truth is the engine: it persists values in ~/.unify/settings.json and mirrors them
 * as `viewState.unifyFeatures` (Record<FeatureId, FeatureValue>; separate from the engine's own
 * `viewState.features`). The renderer writes with post({ type: 'setUnifyFeature', id, value }). Until the engine sends a value, the default below applies.
 *
 * Adding a feature: add the id + default + label here (owner: main agent), then read it with feature(id).
 * Turning a feature off must hide its UI cleanly (no empty gaps) and take effect live.
 */
import { viewState } from './index';
import { post } from '../bridge';

export type FeatureValue = boolean | number | string;

export interface FeatureDefinition {
	group: 'Appearance' | 'Motion' | 'Agents' | 'Knowledge' | 'Chats' | 'Editor' | 'Usage' | 'Toolpacks' | 'Notifications' | 'Power';
	label: string;
	description: string;
	defaultValue: FeatureValue;
	/** For string features: the allowed values. */
	options?: readonly string[];
	/** Engine-side features change agent behaviour; renderer-only ones just change the UI. */
	scope: 'engine' | 'ui';
}

export const featureDefinitions = {
	// Motion
	'motion.organic': { group: 'Motion', label: 'Human-like edits', description: 'Agent edits look typed by a person (rename, create, delete, move).', defaultValue: true, scope: 'ui' },
	'motion.organic.rename': { group: 'Motion', label: 'Retype renames', description: 'Backspace and retype names the agent changes.', defaultValue: true, scope: 'ui' },
	'motion.organic.createDelete': { group: 'Motion', label: 'Type in / sweep out', description: 'New names type in; deleted names get a select-all sweep.', defaultValue: true, scope: 'ui' },
	'motion.organic.move': { group: 'Motion', label: 'Lift and move', description: 'Moved rows lift and travel to their new place.', defaultValue: true, scope: 'ui' },
	'motion.organic.counters': { group: 'Motion', label: 'Rolling counters', description: 'Numbers roll like an odometer.', defaultValue: true, scope: 'ui' },
	'motion.organic.codeEdits': { group: 'Motion', label: 'Animated code edits', description: 'Removed lines sweep out, added lines wipe in.', defaultValue: true, scope: 'ui' },
	'motion.bounce': { group: 'Motion', label: 'Bouncy springs', description: 'Pop-ins and presses overshoot slightly. Off = calm springs.', defaultValue: true, scope: 'ui' },
	'motion.loaders': { group: 'Motion', label: 'Animated loaders', description: 'Wood-block loaders animate while agents work.', defaultValue: true, scope: 'ui' },

	// Agents
	'agents.messaging': { group: 'Agents', label: 'Agent messaging', description: 'Running agents can message each other inside Unify.', defaultValue: true, scope: 'engine' },
	'agents.messaging.scope': { group: 'Agents', label: 'Who can message whom', description: 'Limit agent-to-agent messages.', defaultValue: 'everyone', options: ['everyone', 'same-chat', 'parent-child'], scope: 'engine' },
	'agents.messaging.showInChat': { group: 'Agents', label: 'Show agent messages', description: 'Show who → who messages in the chat timeline.', defaultValue: true, scope: 'ui' },
	'agents.blockNativeAgents': { group: 'Agents', label: 'Block provider agent tools', description: "Disable each provider's own subagent system so Unify's is the only one.", defaultValue: true, scope: 'engine' },
	'agents.codexRuntime': { group: 'Agents', label: 'Use Codex with DeepSeek Harness', description: 'ChatGPT (Codex) uses DeepSeek Harness for tools and subagents. On uses DeepSeek Harness; off uses Codex CLI. Applies to new chats.', defaultValue: true, scope: 'engine' },
	'agents.maxParallel': { group: 'Agents', label: 'Parallel subagents', description: 'Most subagents running at once.', defaultValue: 4, scope: 'engine' },
	'agents.imagesToParent': { group: 'Agents', label: 'Subagents send real images', description: 'Images a subagent sends reach the main agent as images, not file paths.', defaultValue: true, scope: 'engine' },
	'agents.explorerRanges': { group: 'Agents', label: 'Explorer returns code ranges', description: 'The explorer ends with the exact file ranges it found, so the main agent reads only those lines.', defaultValue: true, scope: 'engine' },
	'agents.stuckCommandMinutes': { group: 'Agents', label: 'Stop stuck commands after (minutes)', description: 'A command an agent runs that shows no CPU or disk activity for this long is stopped, so the agent never waits on it forever. 0 turns this off.', defaultValue: 5, scope: 'engine' },
	'tools.rangeEdits': { group: 'Agents', label: 'Range reads and edits', description: 'Agents can read several line ranges in one call and replace just those lines, with a check that the lines have not changed.', defaultValue: true, scope: 'engine' },
	'chats.showYourWork': { group: 'Agents', label: 'Show your work', description: 'Agents send screenshots, renders and before/after images of what they made. Images you have already seen are never sent twice.', defaultValue: true, scope: 'engine' },

	// Knowledge
	'knowledge.agentWrites': { group: 'Knowledge', label: 'Agents save skills and memory', description: 'Agents can add and edit knowledge; each change shows in chat with undo.', defaultValue: true, scope: 'engine' },
	'knowledge.audiences': { group: 'Knowledge', label: 'Rule audiences', description: 'Rules target Everyone, Main agent, Subagents or a profile.', defaultValue: true, scope: 'engine' },

	// Chats
	'chats.layoutPicker': { group: 'Chats', label: 'Layout picker on drag', description: 'Hold-drag a pane header to pick a layout.', defaultValue: true, scope: 'ui' },
	'chats.maxPerProject': { group: 'Chats', label: 'Chats shown per project', description: 'Before "Show N more".', defaultValue: 5, scope: 'ui' },
	'chats.imagesInBubble': { group: 'Chats', label: 'Images in my messages', description: 'Show attached images in your own bubble.', defaultValue: true, scope: 'ui' },
	'chats.toolImages': { group: 'Chats', label: 'Images agents look at', description: 'Show a thumbnail on any tool call that gave an agent an image (screenshots, renders, image files).', defaultValue: true, scope: 'ui' },
	'chats.liveEditPreview': { group: 'Chats', label: 'Live edit preview', description: 'While an agent edits a file, its row shows the change streaming in as a small diff. Off shows plain tool rows.', defaultValue: true, scope: 'ui' },
	'chats.subagentImageStrip': { group: 'Chats', label: 'Subagent images in the main chat', description: 'When a subagent finishes, its row shows the images it sent to the main agent.', defaultValue: true, scope: 'ui' },
	'chat.friendlyInternalRows': { group: 'Chats', label: 'Plain-language memory rows', description: 'When an agent reads or saves memory or earlier conversation with a file tool, the row says so instead of showing a file path.', defaultValue: true, scope: 'engine' },

	// Editor
	'editor.enabled': { group: 'Editor', label: 'Code editor', description: 'Files screen with the Monaco editor.', defaultValue: true, scope: 'ui' },
	'editor.minimap': { group: 'Editor', label: 'Minimap', description: 'Show the editor minimap.', defaultValue: false, scope: 'ui' },

	// Usage
	'usage.railMeter': { group: 'Usage', label: 'Usage meter in rail', description: 'Slim usage meter above Settings.', defaultValue: true, scope: 'ui' },

	// Toolpacks
	'toolpacks.hub': { group: 'Toolpacks', label: 'Toolpack Hub', description: 'Browse and publish toolpacks.', defaultValue: true, scope: 'ui' },

	// Notifications
	'notifications.desktop': { group: 'Notifications', label: 'Desktop notifications', description: 'Notify when an agent finishes or needs you while Unify is in the background.', defaultValue: true, scope: 'engine' },
	'notifications.sound': { group: 'Notifications', label: 'Sound', description: 'Play a soft sound when an agent needs you.', defaultValue: false, scope: 'ui' },

	// Power
	'power.shutdownWhenIdle': { group: 'Power', label: 'Shut down when all tasks finish', description: 'One-shot: after every chat and subagent is idle, count down 60 s, then shut the PC down.', defaultValue: false, scope: 'engine' },
	'power.rememberArmed': { group: 'Power', label: 'Stay armed after restart', description: 'Keep "shut down when done" armed if Unify restarts.', defaultValue: false, scope: 'engine' },
} as const satisfies Record<string, FeatureDefinition>;

export type FeatureId = keyof typeof featureDefinitions;

/** Reactive read: use inside JSX / effects. */
export function feature<T extends FeatureValue = boolean>(id: FeatureId): T {
	const engineValues = (viewState as unknown as { unifyFeatures?: Partial<Record<FeatureId, FeatureValue>> }).unifyFeatures;
	const value = engineValues?.[id];
	return (value === undefined ? featureDefinitions[id].defaultValue : value) as T;
}

export function setFeature(id: FeatureId, value: FeatureValue): void {
	post({ type: 'setUnifyFeature', id, value } as never);
}
