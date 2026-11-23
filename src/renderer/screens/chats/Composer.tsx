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
 * @ mentions: the protocol has no file search yet, so "@" is plain text for now (see screens/README.md).
 */
import { createSignal, For, Show, type JSX } from 'solid-js';
import { Button, Icon, IconButton, Menu, Select, type MenuEntry } from '../../components';
import { Collapse, Presence } from '../../motion';
import { post } from '../../bridge';
import type { SidebarImage } from '../../protocol';
import { rememberSentImages, setEngineError, viewState } from '../../store';
import {
  effortOptions,
  modelOptions,
  selectedModelLabel,
  selectedModelValue,
  selectEffort,
  selectModel,
  selectSpeed,
  speedOptions,
} from './models';
import './composer.css';

const maxAttachments = 8;
const maxAttachmentBytes = 10 * 1024 * 1024;
const maxTotalBytes = 20 * 1024 * 1024;
const isImageMime = (mime: string) => /^image\/(png|jpeg|gif|webp)$/.test(mime);
const isTextMime = (mime: string) => mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml';

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
  const [attachMenuOpen, setAttachMenuOpen] = createSignal(false);
  const [dragOver, setDragOver] = createSignal(false);
  const [sendButton, setSendButton] = createSignal<HTMLButtonElement>();
  const [attachButton, setAttachButton] = createSignal<HTMLButtonElement>();
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
    setAttachments([]);
    resize();
  }

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

  const attachMenuItems: MenuEntry[] = [
    { id: 'image', label: 'Image' },
    { id: 'file', label: 'File' },
  ];

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
          placeholder={props.placeholder}
          value={text()}
          onInput={event => {
            setText(event.currentTarget.value);
            resize();
          }}
          onKeyDown={event => {
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
          <Select
            class="composer-choice"
            value={selectedModelValue()}
            display={selectedModelLabel()}
            options={modelOptions()}
            onChange={value => selectModel(value, props.chatId)}
            title="Choose model"
          />
          <Show when={speedOptions().length > 0}>
            <Select
              class="composer-choice"
              value={viewState.selectedSpeed || speedOptions()[0]?.value}
              options={speedOptions()}
              onChange={value => selectSpeed(value, props.chatId)}
              title="Response speed"
            />
          </Show>
          <Show when={effortOptions().length > 0}>
            <Select
              class="composer-choice"
              value={viewState.selectedEffort || ''}
              options={effortOptions()}
              onChange={value => selectEffort(value, props.chatId)}
              title="Reasoning effort"
            />
          </Show>
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
        items={attachMenuItems}
        onSelect={id => {
          setAttachMenuOpen(false);
          openPicker(id === 'image' ? 'image/png,image/jpeg,image/gif,image/webp' : '');
        }}
      />
    </div>
  );
}
