import { X } from 'lucide-react';
import { useUi } from '../stores/ui.ts';
import { IconButton } from './ui/Button.tsx';

const STYLE = { info: 'bg-bg-3 text-fg', warn: 'bg-amber/15 text-amber', error: 'bg-red/15 text-red' } as const;

/**
 * Spec §12.7's banner surface: the conditions that outlive a toast, at the top of the pane grid.
 * Today `bootstrap.ts` is the only writer (the host being down or outdated); "corrupt workspace
 * file recovered" and "low disk" have no renderer-side source yet — main reports the first as a
 * `toast` event and nothing measures the second — so this renders whatever the store holds rather
 * than knowing about any particular banner.
 *
 * Both selectors return the STORED reference. A `.filter(...)`, `.map(...)` or `?? []` here would
 * be the G59/G61 render loop; the store's own `setBanner` is what keeps `banners` stable between
 * changes. Auto-dismiss is deliberately absent: a banner stays until its condition clears (or the
 * user closes it), which is the whole difference from a toast.
 */
export function Banners() {
  const banners = useUi((s) => s.banners);
  const clearBanner = useUi((s) => s.clearBanner);
  if (banners.length === 0) return null;
  return (
    <div className="shrink-0">
      {banners.map((b) => (
        // Keyed by the banner's own id, which is also the replace key in `setBanner` — so a host
        // banner changing level or text updates in place instead of remounting.
        <div key={b.id} role="status" className={`flex items-center gap-2 border-b border-line px-3 py-1.5 text-[12px] ${STYLE[b.level]}`}>
          <span className="min-w-0 flex-1 truncate" title={b.text}>{b.text}</span>
          {b.action ? <button type="button" className="shrink-0 underline hover:no-underline" onClick={b.action.onClick}>{b.action.label}</button> : null}
          <IconButton title="Dismiss" onClick={() => clearBanner(b.id)}>
            <X size={12} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
