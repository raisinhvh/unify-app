/**
 * The status glyph in front of a chat row: the loader for what the chat is doing, a check once a turn finished
 * unread, nothing when idle. Changes between them morph (loaders) or pop (check), never swap instantly.
 */
import type { JSX } from 'solid-js';
import { Presence } from '../../motion';
import { unread } from '../../store';
import { Icon } from '../Icon';
import { actionLabel, actionLoader, chatAction } from './actions';
import { Loader } from './Loader';

export function ChatLoader(props: { sessionId: string; size?: number }): JSX.Element {
  const action = () => chatAction(props.sessionId);
  const done = () => !action() && props.sessionId in unread();
  const size = () => props.size ?? 12;
  return (
    <span class="chat-loader" style={{ width: `${size()}px`, height: `${size()}px` }} title={action() ? actionLabel[action()!] : undefined}>
      <Loader id={action() ? actionLoader[action()!] : undefined} size={size()} />
      <Presence when={done()} from={0.6}>
        <span class="chat-loader-done">
          <Icon name="check" size={size()} />
        </span>
      </Presence>
    </span>
  );
}
