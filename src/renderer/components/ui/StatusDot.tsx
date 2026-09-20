import { statusVisual } from '../../../../shared/status.ts';
import type { Activity } from '../../../../shared/types.ts';

const COLOR = { green: 'bg-green border-green', amber: 'bg-amber border-amber', blue: 'bg-blue border-blue', grey: 'bg-muted border-muted', red: 'bg-red border-red' } as const;

export function StatusDot({ activity, size = 8 }: { activity: Activity; size?: number }) {
  const v = statusVisual(activity);
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" title={v.label} style={{ width: size + 6, height: size + 6 }}>
      <span
        className={`rounded-full border ${COLOR[v.color]} ${v.hollow ? '!bg-transparent' : ''} ${v.pulse ? 'pulse' : ''}`}
        style={{ width: size, height: size }}
      />
      {v.badge ? <span className="absolute -top-1 -right-1 rounded-full bg-amber px-[3px] text-[8px] leading-[10px] font-bold text-bg-0">{v.badge}</span> : null}
    </span>
  );
}
