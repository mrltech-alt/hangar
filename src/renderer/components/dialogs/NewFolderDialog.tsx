import { useRef, useState } from 'react';
import { FolderNameSchema } from '../../../../shared/workspace-schema.ts';
import { run } from '../../lib/api.ts';
import { useUi } from '../../stores/ui.ts';
import { useFolders } from '../../stores/workspace.ts';
import { Button } from '../ui/Button.tsx';
import { Dialog, DialogActions } from '../ui/Dialog.tsx';
import { Field, Select, TextInput } from '../ui/Field.tsx';

export function NewFolderDialog({ parentId: initialParent }: { parentId: string | null }) {
  const close = useUi((s) => s.closeDialog);
  const folders = useFolders();
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string | null>(initialParent);
  // Named for `Dialog`, which focuses it after `showModal()`. `autoFocus` used to sit on this
  // input and did nothing: React focuses during commit, when the <dialog> is still closed and
  // therefore `display: none`, and `showModal()` afterwards took focus to the header's Close
  // button. See the measurements in `ui/Dialog.tsx`.
  const nameRef = useRef<HTMLInputElement>(null);
  // The SAME bounds `folder:create` validates with, not a hand-rolled `length > 0`. The schema is
  // not itself trimmed (`z.string().min(1).max(80)`), so the trim is applied here — matching the
  // payload actually sent below, which is what makes the disabled state honest.
  const valid = FolderNameSchema.safeParse(name.trim()).success;
  const submit = async (): Promise<void> => {
    if (!valid) return;
    const created = await run('folder:create', { name: name.trim(), parentId });
    if (created) close();
  };
  return (
    <Dialog open title="New folder" onClose={close} width={420} initialFocus={nameRef}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Name"><TextInput ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Inside">
          <Select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value === '' ? null : e.target.value)}>
            <option value="">Root</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </Field>
        <DialogActions>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!valid}>Create</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
