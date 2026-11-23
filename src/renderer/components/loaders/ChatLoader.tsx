/**
 * The status glyph in front of a chat row: the loader for what the chat is doing, a check once a turn finished
 * unread, nothing when idle. All of them are drawn by one <Loader>, so every change between them (loader to
 * loader, loader to check, loader to idle, idle to loader) is a cell-to-cell morph, never a swap.
 */
import type { JSX } from 'solid-js';
import { unread } from '../../store';
import { actionLabel, actionLoader, chatAction } from './actions';
import type { LoaderShape } from './definitions';
import { Loader } from './Loader';

export function ChatLoader(props: { sessionId: string; size?: number }): JSX.Element {
  const action = () => chatAction(props.sessionId);
  const done = () => !action() && props.sessionId in unread();
  const size = () => props.size ?? 12;
  const shape = (): LoaderShape | undefined => {
    const current = action();
    if (current) return actionLoader[current];
    return done() ? 'done' : undefined;
  };
  return (
    <span class="chat-loader" style={{ width: `${size()}px`, height: `${size()}px` }} title={action() ? actionLabel[action()!] : undefined}>
      <Loader id={shape()} size={size()} />
    </span>
  );
}
