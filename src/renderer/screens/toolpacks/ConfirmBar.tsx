/**
 * Inline confirmation for destructive actions (remove a toolpack, remove an account). It reveals under the
 * header with <Collapse>, so the page below slides down instead of a modal interrupting.
 *
 *   <ConfirmBar open={confirming()} message="Remove Roblox Studio?" action="Remove" onConfirm={…} onCancel={…} />
 */
import type { JSX } from 'solid-js';
import { Button } from '../../components';
import { Collapse } from '../../motion';
import './confirm.css';

export interface ConfirmBarProps {
  open: boolean;
  message: JSX.Element;
  action: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmBar(props: ConfirmBarProps): JSX.Element {
  return (
    <Collapse open={props.open}>
      <div class="confirm-bar" role="alertdialog">
        <span class="confirm-message">{props.message}</span>
        <Button variant="text" onClick={() => props.onCancel()}>Cancel</Button>
        <Button variant="secondary" class="confirm-danger" onClick={() => props.onConfirm()}>{props.action}</Button>
      </div>
    </Collapse>
  );
}
