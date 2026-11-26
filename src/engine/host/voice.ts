/** Voice dictation: commands, the whisper engine, start and stop. */
import type { Host as ExtensionHost } from '../extension';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { Dictation, normalizeVoiceCommands, VoiceCommand } from '../voice/dictation';
import { installedWhisper, installWhisper, WHISPER_DOWNLOAD_BYTES, WhisperEngine } from '../voice/whisperInstall';

export function voiceCommands(this: ExtensionHost): VoiceCommand[] {
  return normalizeVoiceCommands(vscode.workspace.getConfiguration('unify').get<unknown>('voice.commands'));
}

/** Downloads local Whisper once, with a progress notification; shared by overlapping starts. */
export function whisperEngine(this: ExtensionHost): Promise<WhisperEngine> {
  const root = join(this.context.globalStorageUri.fsPath, 'whisper');
  const installed = installedWhisper(root);
  if (installed) return Promise.resolve(installed);
  this.whisperInstall ??= Promise.resolve(vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Downloading local Whisper for voice input (${Math.round(WHISPER_DOWNLOAD_BYTES / 1_000_000)} MB, one time)`,
  }, async progress => {
    let reported = 0;
    return installWhisper(root, fraction => {
      const percent = Math.floor(fraction * 100);
      if (percent > reported) {
        progress.report({ increment: percent - reported, message: `${percent}%` });
        reported = percent;
      }
    });
  })).finally(() => { this.whisperInstall = undefined; });
  return this.whisperInstall;
}

/** Stops dictation, or cancels a start that is still downloading Whisper. */
export function stopVoice(this: ExtensionHost): void {
  this.voiceSession++;
  if (this.dictation) this.dictation.stop();
  else void this.sidebar.postMessage({ type: 'voiceState', listening: false });
}

/** Starts dictation into the composer; a newer start replaces a running one. */
export async function startVoice(this: ExtensionHost): Promise<void> {
  const session = ++this.voiceSession;
  const previous = this.dictation;
  this.dictation = undefined;
  previous?.stop();
  previous?.stop();
  let engine: WhisperEngine;
  try {
    engine = await this.whisperEngine();
  } catch (error) {
    const message = `Could not download local Whisper: ${error instanceof Error ? error.message : String(error)}`;
    this.output.appendLine(`Voice input stopped: ${message}`);
    if (session === this.voiceSession) void this.sidebar.postMessage({ type: 'voiceState', listening: false, error: message });
    return;
  }
  if (session !== this.voiceSession) return;
  const dictation = new Dictation(this.voiceCommands(), engine, {
    onListening: () => { if (this.dictation === dictation) void this.sidebar.postMessage({ type: 'voiceState', listening: true }); },
    onHypothesis: text => { if (this.dictation === dictation) void this.sidebar.postMessage({ type: 'voiceHypothesis', text }); },
    onResult: parts => { if (this.dictation === dictation) void this.sidebar.postMessage({ type: 'voiceResult', parts }); },
    onStopped: error => {
      if (this.dictation !== dictation) return;
      this.dictation = undefined;
      if (error) this.output.appendLine(`Voice input stopped: ${error}`);
      void this.sidebar.postMessage({ type: 'voiceState', listening: false, error });
    },
  });
  this.dictation = dictation;
  await dictation.start();
}
