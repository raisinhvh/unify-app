/**
 * A question the agent asks (Figma 12: numbered options on a guide line). Port of DSH's question card
 * (media/sidebar.js ~1012-1111), behaviour unchanged:
 *   - every question needs an answer before Submit enables; single choice replaces, multi-select toggles
 *   - "Other…" is always the last choice and reveals a text field; multi-select may combine it with options
 *   - arrow keys move between options (and select, for single choice); Enter in "Other" submits when ready
 *   - answers: the chosen label, or for multi-select the picked labels in option order then the Other text,
 *     joined with ", "; Skip answers null
 *   - drafts survive re-renders and pane moves (kept per chat + question id)
 */
import { createSignal, For, Show, type JSX } from 'solid-js';
import { Button } from '../../components';
import { Collapse } from '../../motion';
import { post } from '../../bridge';
import type { SidebarQuestion } from '../../protocol';
import './timeline.css';
import './question-row.css';

interface Draft {
  option?: number;
  picked?: number[];
  other?: string;
}

const drafts = new Map<string, Draft[]>();
const noteDrafts = new Map<string, string>();

/** Grows a notes textarea to fit its content (capped by CSS max-height). */
const fitHeight = (element: HTMLTextAreaElement) => {
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
};

interface QuestionItem {
  id: string;
  questions: SidebarQuestion[];
  status: 'pending' | 'answered' | 'skipped';
  answers?: string[];
}

const otherText = (draft: Draft | undefined) => (typeof draft?.other === 'string' ? draft.other.trim() : '');

export function QuestionRow(props: { chatId: string; item: QuestionItem }): JSX.Element {
  const questionId = () => props.item.id.slice('question:'.length);
  const draftKey = () => `${props.chatId}\0${questionId()}`;
  const [answers, setAnswers] = createSignal<Draft[]>(drafts.get(draftKey()) || []);
  const [notes, setNotes] = createSignal(noteDrafts.get(draftKey()) || '');

  const update = (index: number, draft: Draft) => {
    const next = [...answers()];
    next[index] = draft;
    drafts.set(draftKey(), next);
    setAnswers(next);
  };

  const ready = () =>
    props.item.questions.every((question, index) => {
      const draft = answers()[index];
      if (!draft) return false;
      return question.multiSelect ? !!(draft.picked?.length || otherText(draft)) : draft.option !== undefined || !!otherText(draft);
    });

  const submit = () => {
    if (!ready()) return;
    const result = props.item.questions.map((question, index) => {
      const draft = answers()[index] || {};
      if (question.multiSelect) {
        const picked = [...(draft.picked || [])].sort((first, second) => first - second).map(at => question.options[at]?.label);
        return [...picked, otherText(draft)].filter(Boolean).join(', ');
      }
      return draft.option !== undefined ? question.options[draft.option]?.label || '' : otherText(draft);
    });
    // Notes travel inside the last answer so the message protocol (string[] answers) stays unchanged.
    const note = notes().trim();
    if (note && result.length) result[result.length - 1] = `${result[result.length - 1]}\n\nNotes: ${note}`;
    drafts.delete(draftKey());
    noteDrafts.delete(draftKey());
    post({ type: 'questionResponse', id: questionId(), answers: result, chatId: props.chatId });
  };

  const skip = () => {
    drafts.delete(draftKey());
    noteDrafts.delete(draftKey());
    post({ type: 'questionResponse', id: questionId(), answers: null, chatId: props.chatId });
  };

  return (
    <div class="feed-entry interrupt-row question-row" classList={{ resolved: props.item.status !== 'pending' }}>
      <Show
        when={props.item.status === 'pending'}
        fallback={
          <>
            <div class="interrupt-title">{props.item.status === 'answered' ? 'Questions answered' : 'Questions skipped'}</div>
            <For each={props.item.questions}>
              {(question, index) => (
                <div class="question-summary">
                  <div class="question-summary-prompt">{question.question}</div>
                  <div class="question-answer">{props.item.answers?.[index()] || ''}</div>
                </div>
              )}
            </For>
          </>
        }
      >
        <For each={props.item.questions}>
          {(question, questionIndex) => {
            const multi = question.multiSelect === true;
            const choices = () => [...(question.options || []), { label: 'Other…', description: undefined }];
            const otherIndex = () => choices().length - 1;
            const draft = () => answers()[questionIndex()] || {};
            const isSelected = (index: number) => {
              const current = draft();
              if (index === otherIndex()) return current.other !== undefined;
              return multi ? (current.picked || []).includes(index) : current.option === index;
            };
            const optionButtons: HTMLButtonElement[] = [];
            let otherInput: HTMLInputElement | undefined;
            const select = (index: number, focusInput: boolean) => {
              const isOther = index === otherIndex();
              const current = draft();
              if (multi) {
                const picked = new Set(current.picked || []);
                let other = current.other;
                if (isOther) other = other === undefined ? '' : undefined;
                else if (picked.has(index)) picked.delete(index);
                else picked.add(index);
                update(questionIndex(), { picked: [...picked], other });
              } else {
                update(questionIndex(), isOther ? { other: current.other || '' } : { option: index });
              }
              if (isOther && draft().other !== undefined && focusInput) queueMicrotask(() => otherInput?.focus());
            };
            return (
              <section class="question-block">
                <Show when={question.header}>
                  <div class="question-header type-caption">{question.header}</div>
                </Show>
                <div class="question-prompt">{question.question}</div>
                <Show when={multi}>
                  <div class="question-hint type-caption">Select all that apply</div>
                </Show>
                <div class="question-options" role={multi ? 'group' : 'radiogroup'} aria-label={question.question}>
                  <For each={choices()}>
                    {(option, optionIndex) => (
                      <button
                        type="button"
                        ref={element => (optionButtons[optionIndex()] = element)}
                        class="question-option"
                        classList={{ selected: isSelected(optionIndex()) }}
                        role={multi ? 'checkbox' : 'radio'}
                        aria-checked={isSelected(optionIndex())}
                        onClick={() => select(optionIndex(), true)}
                        onKeyDown={event => {
                          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                          event.preventDefault();
                          const count = choices().length;
                          const target = (optionIndex() + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
                          optionButtons[target]?.focus();
                          if (!multi) select(target, false);
                        }}
                      >
                        <span class="question-number">{optionIndex() + 1}</span>
                        <span class="question-option-label">{option.label}</span>
                        <Show when={option.description}>
                          <span class="question-option-description">{option.description}</span>
                        </Show>
                      </button>
                    )}
                  </For>
                  <Collapse open={draft().other !== undefined}>
                    <input
                      ref={otherInput}
                      class="question-other-input"
                      type="text"
                      aria-label="Your answer"
                      placeholder="Type your answer"
                      value={draft().other || ''}
                      disabled={draft().other === undefined}
                      onInput={event => {
                        const value = event.currentTarget.value;
                        update(questionIndex(), multi ? { picked: draft().picked || [], other: value } : { other: value });
                      }}
                      onKeyDown={event => {
                        if (event.key === 'Enter' && ready()) {
                          event.preventDefault();
                          submit();
                        }
                      }}
                    />
                  </Collapse>
                </div>
              </section>
            );
          }}
        </For>
        <div class="question-notes">
          <label class="question-notes-label type-caption" for={`question-notes-${props.item.id}`}>Notes</label>
          <textarea
            id={`question-notes-${props.item.id}`}
            ref={element => queueMicrotask(() => fitHeight(element))}
            class="question-notes-input"
            rows={1}
            maxLength={1000}
            placeholder="Notes for the agent (optional)"
            value={notes()}
            onInput={event => {
              const value = event.currentTarget.value;
              fitHeight(event.currentTarget);
              setNotes(value);
              if (value) noteDrafts.set(draftKey(), value);
              else noteDrafts.delete(draftKey());
            }}
            onKeyDown={event => {
              // Enter inserts a newline; Ctrl/Cmd+Enter submits when every question is answered.
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && ready()) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>
        <div class="interrupt-actions">
          <Button variant="primary" disabled={!ready()} onClick={submit}>Submit</Button>
          <Button variant="secondary" onClick={skip}>Skip</Button>
        </div>
      </Show>
    </div>
  );
}
