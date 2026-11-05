import { actuallyDisabled } from './form-disabled.js';

// Click listeners may change type, disabledness, connectivity or form owner.
// Evaluate the submit/reset default action only after dispatch has completed.
export function activateSubmitOrReset(control) {
  if (actuallyDisabled(control)) return;
  const type = control.type;
  if (type !== 'submit' && type !== 'reset') return;
  const form = control.form;
  if (!form) return;
  if (type === 'reset') form.reset();
  else if (control.isConnected) form.requestSubmit(control);
}
