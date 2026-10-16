import { DispoChip } from './DispoChip';
import { fmtDateTime } from './ui';

/**
 * Every field the dialer holds for a lead, grouped and labelled, empty ones
 * hidden. Call centres repurpose VICIdial's address/province fields (vehicle
 * make, model, year…), so nothing is dropped and each value's tooltip shows
 * the dialer's own field name.
 */
export type LeadInfo = Record<string, string | number | null>;

const LABELS: Record<string, string> = {
  lead_id: 'Lead ID',
  entry_date: 'Entered',
  modify_date: 'Last modified',
  status: 'Lead status',
  user: 'Last agent',
  vendor_lead_code: 'Vendor code',
  source_id: 'Source ID',
  list_id: 'List ID',
  list_name: 'List',
  list_campaign: 'Campaign',
  list_active: 'List active',
  gmt_offset_now: 'GMT offset',
  called_since_last_reset: 'Called since reset',
  phone_code: 'Country code',
  phone_number: 'Phone',
  title: 'Title',
  first_name: 'First name',
  middle_initial: 'Middle initial',
  last_name: 'Last name',
  address1: 'Address 1',
  address2: 'Address 2',
  address3: 'Address 3',
  city: 'City',
  state: 'State',
  province: 'Province',
  postal_code: 'Postal code',
  country_code: 'Country',
  gender: 'Gender',
  date_of_birth: 'Date of birth',
  alt_phone: 'Alt phone',
  email: 'Email',
  security_phrase: 'Security phrase',
  comments: 'Comments',
  called_count: 'Times called',
  last_local_call_time: 'Last call',
  rank: 'Rank',
  owner: 'Owner',
  entry_list_id: 'Entry list ID',
};
const NAME = ['title', 'first_name', 'middle_initial', 'last_name'];
const CONTACT = ['phone_number', 'phone_code', 'alt_phone', 'email', 'address1', 'address2', 'address3', 'city', 'state', 'province', 'postal_code', 'country_code'];
const LEAD = ['list_name', 'list_campaign', 'list_id', 'lead_id', 'vendor_lead_code', 'source_id', 'owner', 'user', 'rank', 'gender', 'date_of_birth', 'gmt_offset_now', 'called_count', 'called_since_last_reset', 'last_local_call_time', 'entry_date', 'modify_date', 'entry_list_id', 'list_active'];
const MONO = new Set(['phone_number', 'alt_phone', 'email', 'lead_id', 'list_id', 'vendor_lead_code', 'source_id', 'postal_code', 'phone_code', 'entry_list_id', 'gmt_offset_now']);
const HIDDEN = new Set(['comments', 'status', ...NAME]);

const isEmpty = (v: unknown) => v == null || v === '' || v === '0000-00-00' || v === '0000-00-00 00:00:00';
const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v);
const labelOf = (k: string) => LABELS[k] ?? k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function Field({ k, v }: { k: string; v: string | number | null }) {
  const shown = isIso(v) ? fmtDateTime(v) : String(v);
  return (
    <div className="min-w-0" title={`${k}: ${String(v)}`}>
      <dt className="label">{labelOf(k)}</dt>
      <dd className={`truncate ${MONO.has(k) || isIso(v) ? 'font-mono text-[13px]' : ''}`}>{shown}</dd>
    </div>
  );
}

export function LeadCard({ lead, custom, compact }: { lead: LeadInfo; custom?: LeadInfo | null; compact?: boolean }) {
  const name = NAME.map((k) => lead[k])
    .filter((v) => !isEmpty(v))
    .join(' ');
  const taken = new Set<string>();
  const pick = (src: LeadInfo, keys: string[]) =>
    keys.filter((k) => k in src && !isEmpty(src[k])).map((k) => {
      taken.add(k);
      return k;
    });
  const contact = pick(lead, CONTACT);
  const details = pick(lead, LEAD);
  const rest = Object.keys(lead).filter((k) => !taken.has(k) && !HIDDEN.has(k) && !isEmpty(lead[k]));
  const comments = isEmpty(lead.comments) ? '' : String(lead.comments);
  const customKeys = custom ? Object.keys(custom).filter((k) => k !== 'lead_id' && !isEmpty(custom[k])) : [];
  const grid = compact
    ? 'grid grid-cols-2 gap-x-4 gap-y-2 text-sm'
    : 'grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3 lg:grid-cols-4';

  const Section = ({ title, src, keys }: { title: string; src: LeadInfo; keys: string[] }) =>
    keys.length === 0 ? null : (
      <div className="mt-3">
        <h3 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-3">{title}</h3>
        <dl className={grid}>
          {keys.map((k) => (
            <Field key={k} k={k} v={src[k]} />
          ))}
        </dl>
      </div>
    );

  return (
    <div className={compact ? 'mt-4' : 'card mt-4 p-4'}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-sm font-bold">Lead details</h2>
        {name && <span className="font-medium">{name}</span>}
        {!isEmpty(lead.status) && <DispoChip code={String(lead.status)} title="Current lead status on the dialer" />}
        <span className="ml-auto font-mono text-2xs text-ink-3">
          lead {lead.lead_id}
          {!isEmpty(lead.list_name) ? ` · ${lead.list_name}` : !isEmpty(lead.list_id) ? ` · list ${lead.list_id}` : ''}
        </span>
      </div>
      <Section title="Contact" src={lead} keys={contact} />
      {comments && (
        <div className="mt-3 rounded-md bg-bg px-3 py-2 text-sm">
          <span className="label">Comments</span>
          <p className="whitespace-pre-wrap break-words">{comments}</p>
        </div>
      )}
      <Section title="Lead" src={lead} keys={details} />
      {custom && <Section title="Custom fields" src={custom} keys={customKeys} />}
      <Section title="Other fields" src={lead} keys={rest} />
      <p className="mt-3 text-2xs text-ink-3">
        Every field the dialer holds for this lead; empty fields are hidden. Hover a value for the dialer's field name.
      </p>
    </div>
  );
}
