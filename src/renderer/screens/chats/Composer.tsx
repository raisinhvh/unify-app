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
 * Attach menu: Image, File, and (when the bridge offers them) Folder as context ("@folder/ " at the caret) and
 * Screenshot (a captured image attachment).
 *
 * Dev screenshots: a fixture may persist `devComposer: { target: '<chatId>' | 'home', text }`; that composer
 * starts with the text typed (and its menus open), since tools/shot.mjs cannot type.
 */
import { batch, createSignal, For, onMount, Show, type JSX } from 'solid-js';
import { Button, Icon, IconButton, Menu, type MenuEntry } from '../../components';
import { ModelPicker } from '../../components/ModelPicker';
import { Collapse, Presence } from '../../motion';
import { bridge, post } from '../../bridge';
import { readPersisted } from '../../persist';
import type { SidebarImage } from '../../protocol';
import { rememberSentImages, setEngineError, viewState } from '../../store';
import { MentionMenu, type MentionMenuApi } from './MentionMenu';
import { SlashMenu, type SlashMenuApi } from './SlashMenu';
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

/** A path for "@" mentions: project-relative inside the open project, else absolute, always with "/". */
function mentionPath(folder: string, projectPath: string | undefined): string {
  const path = folder.replace(/\\/g, '/').replace(/\/+$/, '');
  const project = projectPath?.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!project) return path;
  if (path.toLowerCase() === project.toLowerCase()) return '.';
  if (path.toLowerCase().startsWith(`${project.toLowerCase()}/`)) return path.slice(project.length + 1);
  return path;
}

/** "data:image/png;base64,…" → its mime type and base64 payload. */
function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  return match ? { mimeType: match[1], data: match[2] } : undefined;
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
  const [attachMenuOpen, setAttachMenuOpen] = createSignal(false);
  const [dragOver, setDragOver] = createSignal(false);
  const [sendButton, setSendButton] = createSignal<HTMLButtonElement>();
  const [attachButton, setAttachButton] = createSignal<HTMLButtonElement>();
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

  /** Inserts at the caret, with a space before it when the caret follows a word. */
  function insertAtCaret(value: string): void {
    const current = text();
    const at = input ? input.selectionStart ?? current.length : current.length;
    const needsSpace = at > 0 && !/\s/.test(current[at - 1]);
    replaceRange(at, input ? input.selectionEnd ?? at : at, (needsSpace ? ' ' : '') + value);
  }

  async function addFolderContext(): Promise<void> {
    const host = bridge();
    const folder = await host.pickContextFolder?.();
    if (!folder) return;
    insertAtCaret(`@${mentionPath(folder, host.projectPath)}/ `);
  }

  async function addScreenshot(): Promise<void> {
    setEngineError(undefined);
    try {
      const shot = await bridge().captureScreen?.();
      if (!shot) return;
      const parsed = parseDataUrl(shot.dataUrl);
      if (!parsed) throw new Error('unreadable capture');
      const size = Math.floor((parsed.data.length * 3) / 4);
      const current = attachments();
      if (current.length >= maxAttachments) {
        setEngineError(`Attach up to ${maxAttachments} files.`);
        return;
      }
      if (current.reduce((sum, item) => sum + item.size, 0) + size > maxTotalBytes) {
        setEngineError('Total attachments must stay under 20 MB.');
        return;
      }
      const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
      const extension = parsed.mimeType.split('/')[1] || 'png';
      setAttachments([...current, { name: `screenshot-${stamp}.${extension}`, ...parsed, size }]);
      input?.focus();
    } catch (error) {
      setEngineError(`Could not capture the screen: ${String(error)}`);
    }
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

  const sendMenuItems: MenuEntry[] = [
    { id: 'interrupt', label: 'Send now', hint: 'stops this turn' },
    { id: 'queue', label: 'Queue', hint: 'after this turn' },
  ];

  /** Folder and Screenshot only when the host can do them. */
  const attachMenuItems = (): MenuEntry[] => {
    const host = bridge();
    return [
      { id: 'image', label: 'Image' },
      { id: 'file', label: 'File' },
      ...(host.pickContextFolder ? [{ id: 'folder', label: 'Folder as context' }] : []),
      ...(host.captureScreen ? [{ id: 'screenshot', label: 'Screenshot' }] : []),
    ];
  };

  const openPicker = (accept: string) => {
    if (!fileInput) return;
    fileInput.accept = accept;
    fileInput.click();
  };

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
        <div class="composer-bar">
          <IconButton
            ref={setAttachButton}
            icon="paperclip"
            label="Attach"
            active={attachMenuOpen()}
            onClick={() => setAttachMenuOpen(!attachMenuOpen())}
          />
          <ModelPicker
            class="composer-choice"
            chatId={props.chatId}
            variant="compact"
            placement="top-start"
            title="Model"
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
      <Menu
        anchor={attachButton()}
        open={attachMenuOpen()}
        onClose={() => setAttachMenuOpen(false)}
        placement="top-start"
        items={attachMenuItems()}
        onSelect={id => {
          setAttachMenuOpen(false);
          if (id === 'folder') void addFolderContext();
          else if (id === 'screenshot') void addScreenshot();
          else openPicker(id === 'image' ? 'image/png,image/jpeg,image/gif,image/webp' : '');
        }}
      />
    </div>
  );
}
