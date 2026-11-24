/**
 * The message composer (Figma 12 Chat pane bottom, 13 Composer menus 306:3748, Home 306:1556).
 *
 * Behaviour follows DSH (media/sidebar.js): Enter sends, Shift+Enter is a newline; while the chat runs, Enter
 * opens the send menu (send now = interrupt, or queue). Attachments: up to 8 files, 10 MB each, 20 MB total;
 * paste and drop add files. Queued messages show as chips above the input with a remove button.
 *
 *   <Composer chatId={id} placeholder="Reply, @ to mention a file" />            posts sendPrompt for that chat
 *   <Composer placeholder="…" onSubmit={(prompt, images) => …} />                 Home decides what sending means
 *
 * Slash commands: "/" at the start opens SlashMenu above the composer (commands, the approval-mode picker for
 * /permissions, quick times for /schedule). "@" at a word start opens MentionMenu (workspace file search); a
 * picked file stays plain "@path" text. Only one menu is open at a time; the input keeps focus and the open menu
 * reads the text and caret and gets first look at each keydown.
 *
 * Attach: the paperclip opens the system file picker directly (any file type).
 *
 * Dev screenshots: a fixture may persist `devComposer: { target: '<chatId>' | 'home', text }`; that composer
 * starts with the text typed (and its menus open), since tools/shot.mjs cannot type.
 */
import { batch, createSignal, For, onMount, Show, type JSX } from 'solid-js';
import { Button, Icon, IconButton, Menu, type MenuEntry } from '../../components';
import { ModelPicker } from '../../components/ModelPicker';
import { EffortPicker } from '../../components/EffortPicker';
import { Collapse, Presence } from '../../motion';
import { post } from '../../bridge';
import { readPersisted } from '../../persist';
import type { SidebarImage } from '../../protocol';
import { rememberSentImages, setEngineError, viewState } from '../../store';
import type { VoiceAction, VoicePart } from '../../../engine/voice/dictation';
import { MentionMenu, type MentionMenuApi } from './MentionMenu';
import { SlashMenu, type SlashMenuApi } from './SlashMenu';
import { createVoiceSession, VoiceButton, VoiceHint } from './VoiceButton';
import './composer.css';

const maxAttachments = 8;
const maxAttachmentBytes = 10 * 1024 * 1024;
const maxTotalBytes = 20 * 1024 * 1024;
const isImageMime = (mime: string) => /^image\/(png|jpeg|gif|webp)$/.test(mime);
const isTextMime = (mime: string) => mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml';

/** Numbers composers, so each slash menu's option ids are unique on the page. */
let composerCount = 0;

interface Attachment extends SidebarImage {
  size: number;
}

export interface ComposerProps {
  /** The chat this composer sends to. Omit on Home. */
  chatId?: string;
  placeholder: string;
  /** Replaces the default send (Home starts a new chat first). */
  onSubmit?: (prompt: string, images: SidebarImage[]) => void;
  autofocus?: boolean;
  class?: string;
}

function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

export function Composer(props: ComposerProps): JSX.Element {
  const [text, setText] = createSignal('');
  const [attachments, setAttachments] = createSignal<Attachment[]>([]);
  const [reading, setReading] = createSignal(0);
  const [sendMenuOpen, setSendMenuOpen] = createSignal(false);
  const [dragOver, setDragOver] = createSignal(false);
  const [sendButton, setSendButton] = createSignal<HTMLButtonElement>();
  const [form, setForm] = createSignal<HTMLFormElement>();
  const [caret, setCaret] = createSignal(0);
  composerCount += 1;
  const composerId = `composer-${composerCount}`;
  const [slashMenu, setSlashMenu] = createSignal<SlashMenuApi>();
  const [mentionMenu, setMentionMenu] = createSignal<MentionMenuApi>();
  /** The menu that owns the keys and the combobox state right now, if any. */
  const openMenu = () => (slashMenu()?.open() ? slashMenu() : mentionMenu()?.open() ? mentionMenu() : undefined);
  let input: HTMLTextAreaElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  let attachmentQueue: Promise<void> = Promise.resolve();

  const run = () => (props.chatId ? viewState.runStates[props.chatId] : undefined);
  const running = () => (run()?.state || 'idle') !== 'idle';
  const queue = () => (props.chatId ? viewState.queues[props.chatId] || [] : []);
  const canSend = () => reading() === 0 && (text().trim().length > 0 || attachments().length > 0);

  const resize = () => {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
  };

  async function readFiles(files: File[]): Promise<void> {
    if (!files.length) return;
    setEngineError(undefined);
    for (const file of files) {
      const current = attachments();
      if (current.length >= maxAttachments) {
        setEngineError(`Attach up to ${maxAttachments} files.`);
        break;
      }
      if (file.size > maxAttachmentBytes) {
        setEngineError(`${file.name} must be under 10 MB.`);
        continue;
      }
      const total = current.reduce((sum, item) => sum + item.size, 0);
      if (total + file.size > maxTotalBytes) {
        setEngineError('Total attachments must stay under 20 MB.');
        break;
      }
      try {
        const data = await readFileBase64(file);
        setAttachments([...attachments(), { name: file.name, mimeType: file.type || 'application/octet-stream', data, size: file.size }]);
      } catch {
        setEngineError(`Could not read ${file.name}.`);
      }
    }
  }

  function addFiles(files: File[]): void {
    setReading(count => count + 1);
    attachmentQueue = attachmentQueue
      .then(() => readFiles(files))
      .catch(error => {
        setEngineError(String(error));
      })
      .finally(() => setReading(count => count - 1));
  }

  function clear(): void {
    setText('');
    setCaret(0);
    setAttachments([]);
    resize();
  }

  const readCaret = () => {
    if (input) setCaret(input.selectionStart ?? input.value.length);
  };

  /** Replaces the text (a picked slash command) and keeps typing at the end. */
  function insertText(value: string): void {
    if (input) {
      input.value = value;
      input.focus();
      input.setSelectionRange(value.length, value.length);
    }
    // One update: the slash menu never sees the new text with the old caret.
    batch(() => {
      setText(value);
      setCaret(value.length);
    });
    resize();
  }

  /** Replaces text[start, end) (an "@query") and puts the caret after the new text. */
  function replaceRange(start: number, end: number, value: string): void {
    const current = text();
    const next = current.slice(0, start) + value + current.slice(end);
    const caretAt = start + value.length;
    if (input) {
      input.value = next;
      input.focus();
      input.setSelectionRange(caretAt, caretAt);
    }
    batch(() => {
      setText(next);
      setCaret(caretAt);
    });
    resize();
  }

  onMount(() => {
    if (!import.meta.env.DEV) return;
    const preset = readPersisted<{ target?: string; text?: string } | undefined>('devComposer', undefined);
    // `?compose=<text>` overrides the fixture's text; `?slash=<text>` types "/<text>" (a "/" can't be in a
    // tools/shot.mjs query, it lands in the file name).
    const query = new URLSearchParams(window.location.search);
    const slashText = query.get('slash');
    const presetText = query.get('compose') ?? (slashText !== null ? `/${slashText}` : preset?.text);
    if (!presetText || preset?.target !== (props.chatId ?? 'home')) return;
    window.setTimeout(() => insertText(presetText), 300);
  });

  function send(mode?: 'interrupt' | 'queue'): void {
    const prompt = text().trim();
    if (reading() || (!prompt && !attachments().length)) return;
    const images: SidebarImage[] = attachments().map(({ name, mimeType, data }) => ({ name, mimeType, data }));
    if (props.onSubmit) {
      props.onSubmit(prompt, images);
    } else {
      if (props.chatId) rememberSentImages(props.chatId, images);
      post({ type: 'sendPrompt', prompt, images, ...(mode ? { mode } : {}), chatId: props.chatId });
    }
    clear();
    input?.focus();
  }

  function submit(): void {
    if (!canSend()) return;
    if (running()) {
      setSendMenuOpen(!sendMenuOpen());
      return;
    }
    send();
  }

  /** The last dictated text and where it starts, so "scratch that" can remove it while it is still unchanged. */
  let lastDictation: { start: number; value: string } | undefined;

  /** Dictation parts arrive in spoken order: text goes in at the caret, keywords run as editing actions. */
  function applyDictation(parts: VoicePart[]): void {
    for (const part of parts) {
      if ('text' in part) insertDictated(part.text);
      else applyVoiceAction(part.action);
    }
  }

  function insertDictated(spoken: string): void {
    const words = spoken.trim();
    if (!words) return;
    const current = text();
    const start = input?.selectionStart ?? current.length;
    const end = input?.selectionEnd ?? start;
    // A space separates the new words from whatever is before the caret, unless it's already whitespace.
    const before = current.slice(0, start);
    const value = (before && !/\s$/.test(before) ? ' ' : '') + words;
    replaceRange(start, end, value);
    lastDictation = { start, value };
  }

  function applyVoiceAction(action: VoiceAction): void {
    const caret = input?.selectionStart ?? text().length;
    switch (action) {
      case 'newLine':
        insertNewline(caret);
        break;
      case 'send':
        submit();
        break;
      case 'stop':
        voice.stop();
        break;
      case 'clear':
        lastDictation = undefined;
        replaceRange(0, text().length, '');
        break;
      case 'deleteWord': {
        // Drops trailing spaces and the word before the caret.
        const cut = text().slice(0, caret).replace(/\s*\S+\s*$/, '');
        lastDictation = undefined;
        replaceRange(cut.length, caret, '');
        break;
      }
      case 'deletePhrase': {
        const last = lastDictation;
        lastDictation = undefined;
        if (last && text().slice(last.start, last.start + last.value.length) === last.value) {
          replaceRange(last.start, last.start + last.value.length, '');
        }
        break;
      }
    }
  }

  function insertNewline(caret: number): void {
    const end = input?.selectionEnd ?? caret;
    lastDictation = undefined;
    replaceRange(caret, end, '\n');
  }

  // Unmounting while listening stops the microphone (createVoiceSession's cleanup).
  const voice = createVoiceSession(applyDictation);

  const sendMenuItems: MenuEntry[] = [
    { id: 'interrupt', label: 'Send now', hint: 'stops this turn' },
    { id: 'queue', label: 'Queue', hint: 'after this turn' },
  ];

  return (
    <div class={props.class ? `composer-stack ${props.class}` : 'composer-stack'}>
      <Collapse open={queue().length > 0}>
        <div class="composer-queue">
          <For each={queue()}>
            {(queued, index) => (
              <div class="composer-queue-item">
                <Icon name="arrowUp" size={12} />
                <span class="composer-queue-text" title={queued}>{queued}</span>
                <IconButton
                  icon="close"
                  label="Remove queued message"
                  size="small"
                  onClick={() => props.chatId && post({ type: 'unqueue', sessionId: props.chatId, index: index(), chatId: props.chatId })}
                />
              </div>
            )}
          </For>
        </div>
      </Collapse>
      <form
        ref={setForm}
        class="composer"
        classList={{ 'drag-over': dragOver() }}
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}
        onDragOver={event => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false);
        }}
        onDrop={event => {
          event.preventDefault();
          setDragOver(false);
          addFiles([...(event.dataTransfer?.files || [])]);
        }}
      >
        <Show when={attachments().length > 0}>
          <div class="composer-attachments">
            <For each={attachments()}>
              {(file, index) => (
                <div class="composer-attachment" title={file.name}>
                  <Show
                    when={isImageMime(file.mimeType)}
                    fallback={
                      <span class="composer-attachment-file">
                        <span class="type-caption">{isTextMime(file.mimeType) ? 'Text' : 'Binary'}</span>
                        <span class="composer-attachment-name">{file.name}</span>
                      </span>
                    }
                  >
                    <img src={`data:${file.mimeType};base64,${file.data}`} alt={file.name} />
                  </Show>
                  <IconButton
                    icon="close"
                    label={`Remove ${file.name}`}
                    size="small"
                    class="composer-attachment-remove"
                    onClick={() => setAttachments(attachments().filter((_, at) => at !== index()))}
                  />
                </div>
              )}
            </For>
          </div>
        </Show>
        <textarea
          ref={element => {
            input = element;
            if (props.autofocus) queueMicrotask(() => element.focus());
          }}
          class="composer-input"
          rows={1}
          aria-label="Message"
          role={openMenu() ? 'combobox' : undefined}
          aria-autocomplete={openMenu() ? 'list' : undefined}
          aria-expanded={openMenu() ? true : undefined}
          aria-activedescendant={openMenu()?.activeId()}
          placeholder={props.placeholder}
          value={text()}
          onInput={event => {
            setText(event.currentTarget.value);
            readCaret();
            resize();
          }}
          onKeyUp={readCaret}
          onPointerUp={readCaret}
          onKeyDown={event => {
            if (event.ctrlKey && event.shiftKey && (event.key === ' ' || event.code === 'Space')) {
              event.preventDefault();
              if (voice.enabled()) voice.toggle();
              return;
            }
            if (slashMenu()?.handleKey(event)) return;
            if (mentionMenu()?.handleKey(event)) return;
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
              event.preventDefault();
              if (running() && event.altKey) send('queue');
              else submit();
            }
          }}
          onPaste={event => {
            const files = [...(event.clipboardData?.files || [])];
            if (files.length) {
              event.preventDefault();
              addFiles(files);
            }
          }}
        />
        <VoiceHint voice={voice} />
        <div class="composer-bar">
          <IconButton
            icon="paperclip"
            label="Attach files"
            onClick={() => fileInput?.click()}
          />
          <ModelPicker
            class="composer-choice"
            chatId={props.chatId}
            variant="compact"
            placement="top-start"
            title="Model"
          />
          <EffortPicker
            class="composer-choice"
            chatId={props.chatId}
            placement="top-start"
          />
          <span class="composer-spacer" />
          <Presence when={running()}>
            <IconButton
              icon="stop"
              label="Stop"
              disabled={run()?.state === 'cancelling'}
              onClick={() => post({ type: 'cancel', chatId: props.chatId })}
            />
          </Presence>
          <Show when={voice.enabled()}>
            <VoiceButton voice={voice} />
          </Show>
          <Button
            ref={setSendButton}
            type="submit"
            variant="primary"
            class="composer-send"
            aria-label={running() ? 'Send options' : 'Send'}
            aria-haspopup={running() ? 'menu' : undefined}
            aria-expanded={running() ? sendMenuOpen() : undefined}
            disabled={reading() > 0}
            icon="arrowUp"
          />
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={event => {
            const files = [...(event.currentTarget.files || [])];
            event.currentTarget.value = '';
            addFiles(files);
          }}
        />
      </form>
      <SlashMenu
        anchor={form()}
        text={text()}
        caret={caret()}
        idPrefix={composerId}
        onInsert={insertText}
        onApplied={() => {
          clear();
          input?.focus();
        }}
        ref={setSlashMenu}
      />
      <MentionMenu
        anchor={form()}
        text={text()}
        caret={caret()}
        idPrefix={composerId}
        disabled={!!slashMenu()?.open()}
        onReplace={replaceRange}
        ref={setMentionMenu}
      />
      <Menu
        anchor={sendButton()}
        open={sendMenuOpen() && running()}
        onClose={() => setSendMenuOpen(false)}
        placement="top-end"
        items={sendMenuItems}
        onSelect={id => {
          setSendMenuOpen(false);
          send(id as 'interrupt' | 'queue');
        }}
      />
    </div>
  );
}
