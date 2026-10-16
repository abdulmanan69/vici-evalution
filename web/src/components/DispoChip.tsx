/**
 * Dispositions and hangup reasons as pills, the same everywhere: colour says
 * what the code means at a glance (sale, transfer, callback, DNC, dropped,
 * still on the call), the code itself stays visible for the exact value.
 */

type Tone = 'good' | 'brand' | 'amber' | 'bad' | 'info' | 'neutral' | 'live';

const TONE_CLS: Record<Tone, string> = {
  good: 'bg-good-soft text-good',
  brand: 'bg-brand-soft text-brand',
  amber: 'bg-amber-soft text-amber-line',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-info-soft text-info',
  neutral: 'bg-bg text-ink-2',
  live: 'bg-info-soft text-info animate-pulse',
};

/** colour rule for VICIdial status codes — exact codes first, then families */
export function dispoTone(code: string | null | undefined): Tone {
  const c = (code ?? '').toUpperCase().trim();
  if (!c) return 'neutral';
  if (c.startsWith('SALE')) return 'good';
  if (/^(A?XFER|XFERA?|TRANSFER)/.test(c)) return 'brand';
  if (/^(CALLBK|CBHOLD|CB)$/.test(c)) return 'amber';
  if (c.startsWith('DNC')) return 'bad';
  if (/^(DROP|PDROP|ABANDON|TIMEOT|XDROP|AFTHRS)$/.test(c)) return 'bad';
  if (/^(INCALL|QUEUE|DISPO|DONEM|PARK|3-WAY|DIAL|RING)$/.test(c)) return 'live';
  return 'neutral';
}

export function DispoChip({ code, title }: { code: string | null | undefined; title?: string }) {
  if (!code) return <span className="text-ink-3">—</span>;
  const tone = dispoTone(code);
  const upper = code.toUpperCase();
  const label = tone === 'live' ? (upper === 'INCALL' ? 'In call' : upper === 'QUEUE' ? 'In queue' : upper) : upper;
  return (
    <span className={`chip font-mono ${TONE_CLS[tone]}`} title={title ?? `Dialer disposition: ${code}`}>
      {label}
    </span>
  );
}

/** VICIdial term_reason → who ended the call */
export function hangupInfo(termReason: string | null | undefined): { label: string; tone: Tone } | null {
  const t = (termReason ?? '').toUpperCase().trim();
  if (!t || t === 'NONE') return null;
  if (t === 'CALLER') return { label: 'Customer hung up', tone: 'good' };
  if (t === 'AGENT') return { label: 'Agent hung up', tone: 'bad' };
  if (t === 'ABANDON') return { label: 'Abandoned in queue', tone: 'amber' };
  if (t === 'QUEUETIMEOUT') return { label: 'Queue timeout', tone: 'amber' };
  if (t === 'AFTERHOURS') return { label: 'After hours', tone: 'neutral' };
  if (t === 'LOGOUT') return { label: 'Agent logged out', tone: 'bad' };
  return { label: `Ended: ${t}`, tone: 'neutral' };
}

export function HangupChip({
  termReason,
  inProgress,
  status,
}: {
  termReason: string | null | undefined;
  inProgress?: boolean;
  /** the call's disposition — a transfer's fronter leg ends by handoff, not a hangup */
  status?: string | null;
}) {
  if (inProgress) return <span className={`chip ${TONE_CLS.live}`}>Call in progress</span>;
  let h = hangupInfo(termReason);
  if (!h) return null;
  if (h.tone === 'bad' && (termReason ?? '').toUpperCase() === 'AGENT' && dispoTone(status) === 'brand') {
    h = { label: 'Handed off to closer', tone: 'brand' };
  }
  return (
    <span className={`chip ${TONE_CLS[h.tone]}`} title={`Dialer term_reason: ${termReason}`}>
      {h.label}
    </span>
  );
}
