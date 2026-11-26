/** Customize-page switches, accessibility and Unify feature settings. */
import type { Host as ExtensionHost } from '../extension';
import * as vscode from 'vscode';
import { SidebarAccessibility, SidebarFeatureKey, SidebarFeatures, defaultFeatures, normalizeAccessibility, normalizeCompactTokens, normalizeProcessPriority } from '../sidebar/view';
import { allUnifyFeatures } from '../unify/settings';
import { FEATURE_SETTINGS } from './constants';

export function feature(this: ExtensionHost, key: SidebarFeatureKey): boolean {
  return vscode.workspace.getConfiguration('unify').get<boolean>(FEATURE_SETTINGS[key], defaultFeatures()[key]) !== false;
}

export function refreshCustomize(this: ExtensionHost): void {
  const features = Object.fromEntries((Object.keys(FEATURE_SETTINGS) as SidebarFeatureKey[]).map(key => [key, this.feature(key)])) as SidebarFeatures;
  this.sidebar.postMessage({ type: 'customizeState', features, nameModel: this.modelSetting('nameModel'), reviewModel: this.modelSetting('reviewModel'), summaryModel: this.modelSetting('summaryModel'),
    deciderModel: this.modelSetting('deciderModel'), explorerModel: this.modelSetting('explorerModel'), smartAutoRanks: this.smartAutoRanks(),
    accessibility: normalizeAccessibility(vscode.workspace.getConfiguration('unify').get<unknown>('accessibility')),
    autoCompactTokens: normalizeCompactTokens(vscode.workspace.getConfiguration('unify').get<unknown>('experimental.autoCompactTokens')),
    voiceCommands: this.voiceCommands(), voiceAvailable: process.platform === 'win32',
    processPriority: normalizeProcessPriority(vscode.workspace.getConfiguration('unify').get<unknown>('runtime.processPriority')),
    unifyFeatures: allUnifyFeatures() });
}

/** Pushes every Unify feature value (engine defaults and UI-only ones) for the Customize page. */
export function postUnifyFeatures(this: ExtensionHost): void {
  this.sidebar.postMessage({ type: 'unifyFeaturesState', features: allUnifyFeatures() });
}

export async function saveAccessibility(this: ExtensionHost, value: SidebarAccessibility): Promise<void> {
  await vscode.workspace.getConfiguration('unify').update('accessibility', normalizeAccessibility(value), vscode.ConfigurationTarget.Global);
  this.refreshCustomize();
}

export async function setFeature(this: ExtensionHost, key: SidebarFeatureKey, enabled: boolean): Promise<void> {
  if (!Object.hasOwn(FEATURE_SETTINGS, key)) throw new Error('Unknown feature.');
  await vscode.workspace.getConfiguration('unify').update(FEATURE_SETTINGS[key], enabled === true, vscode.ConfigurationTarget.Global);
  this.refreshCustomize();
}
