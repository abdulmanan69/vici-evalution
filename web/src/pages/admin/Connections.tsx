import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Plus, RefreshCw, Save, Send, Trash2, Upload, Webhook } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { Company } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { useCompanyScope } from '../../components/Layout';
import { Chip, EmptyState, ErrorState, Field, Loading, Modal, PageHeader, fmtDateTime } from '../../components/ui';

/**
 * Connections: API keys other apps read QA data with, webhooks that tell
 * them when something happens, and the state of the links this platform
 * pushes to (HRMS, CRM). Server side: server/src/integrations/connections.
 */

interface CatalogItem {
  id: string;
  description: string;
}

interface ApiKeyRow {
  id: string;
  companyId: string | null;
  companyName: string | null;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
  createdByName: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface WebhookRow {
  id: string;
  companyId: string | null;
  companyName: string | null;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveryAt: string | null;
  failingSince: string | null;
  createdAt: string;
}

interface DeliveryRow {
  id: string;
  event: string;
  eventKey: string;
  attempts: number;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: string;
}

interface JobState {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  ms: number;
  result?: unknown;
  error?: string;
  lastOkAt?: string | null;
}

interface Links {
  hrms: {
    url: string | null;
    companies: Array<{ slug: string; name: string; configured: boolean }>;
    /** some company has a link set up from the web */
    web?: boolean;
    jobs: Record<string, JobState | null>;
    enabled: Record<string, boolean>;
  };
  crm: { url: string | null; configured: boolean; web?: boolean; jobs: Record<string, JobState | null>; enabled: Record<string, boolean> };
  webhooks: { jobs: Record<string, JobState | null> };
}

const JOB_LABELS: Record<string, string> = {
  'hrms-qa-scores': 'QA scores → HRMS',
  'hrms-attendance': 'Dialer attendance → HRMS',
  'hrms-sales': 'Closed sales → HRMS',
  'crm-qa-scores': 'QA scores → CRM',
  webhooks: 'Webhook dispatcher',
};

const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

function CopyBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 break-all rounded-md bg-bg px-2.5 py-2 font-mono text-2xs">{value}</code>
      <button
        className="btn-secondary px-2 py-1 text-2xs"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => setCopied(true));
        }}
      >
        <Copy size={13} /> {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** One-time secret, shown right after it is made. */
function SecretModal({ title, secret, hint, onClose }: { title: string; secret: string | null; hint: string; onClose: () => void }) {
  return (
    <Modal title={title} open={!!secret} onClose={onClose}>
      {secret && (
        <div className="space-y-3">
          <p className="text-sm text-ink-2">{hint}</p>
          <CopyBox value={secret} />
          <div className="rounded-md bg-amber-soft px-3 py-2 text-sm text-amber-line">This is shown only once. Store it now.</div>
          <button className="btn-primary w-full justify-center" onClick={onClose}>
            Done
          </button>
        </div>
      )}
    </Modal>
  );
}

/** Company for a new key or webhook: super admins choose one or all; everyone else uses their own. */
function CompanyPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { isSuperAdmin } = useAuth();
  const { data } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ companies: Company[] }>('/companies'),
    enabled: isSuperAdmin,
  });
  if (!isSuperAdmin) return null;
  return (
    <Field label="Company" hint="All companies: the app sees every company's data. Only super admins can make these.">
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        <option value="*">All companies</option>
        {data?.companies
          .filter((c) => c.status === 'active')
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
      </select>
    </Field>
  );
}

const companyBody = (isSuperAdmin: boolean, v: string) =>
  !isSuperAdmin ? {} : v === '*' ? { allCompanies: true } : { companyId: v || undefined };

function relative(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.max(0, s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return fmtDateTime(iso);
}

/** A one-line summary of a job result, without dumping the whole object. */
function summarize(result: unknown): string {
  if (result == null) return '';
  const r = (result as { sent?: unknown }).sent ?? result;
  if (Array.isArray(r)) {
    if (r.length === 0) return 'nothing to send';
    return r
      .map((x: Record<string, unknown>) => {
        const parts = ['received', 'saved', 'inserted', 'updated', 'removed', 'voided', 'locked']
          .filter((k) => typeof x[k] === 'number' && (x[k] as number) > 0)
          .map((k) => `${x[k]} ${k}`);
        const unknown = Array.isArray(x.unknown) && x.unknown.length ? `${x.unknown.length} not linked` : '';
        if (x.error) return `${x.company}: failed: ${x.error}`;
        return `${x.company}: ${x.skipped ?? ([...parts, unknown].filter(Boolean).join(', ') || 'no changes')}`;
      })
      .join(' · ');
  }
  if (typeof r === 'object') {
    const o = r as Record<string, unknown>;
    if (o.skipped) return String(o.skipped);
    return Object.entries(o)
      .filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => `${v} ${k}`)
      .concat(Array.isArray(o.unknown) && o.unknown.length ? [`${o.unknown.length} not linked`] : [])
      .join(', ');
  }
  return String(r);
}

function JobRows({ jobs, enabled }: { jobs: Record<string, JobState | null>; enabled?: Record<string, boolean> }) {
  return (
    <>
      {Object.entries(jobs).map(([name, s]) => {
        const on = enabled ? enabled[name] : true;
        return (
          <tr key={name} className="hover:bg-bg/60">
            <td className="td font-medium">{JOB_LABELS[name] ?? name}</td>
            <td className="td">{on ? <Chip value="active" label="on" /> : <Chip value="disabled" label="off" />}</td>
            <td className="td font-mono text-2xs">{s ? relative(s.finishedAt) : '—'}</td>
            <td className="td">{!s ? <span className="text-ink-3">not run yet</span> : s.ok ? <Chip value="success" label="ok" /> : <Chip value="failed" />}</td>
            <td className="td max-w-md whitespace-normal text-2xs text-ink-2">
              {s ? (s.ok ? summarize(s.result) : <span className="text-bad">{s.error}</span>) : ''}
              {s && !s.ok && s.lastOkAt && <span className="ml-1 text-ink-3">(last ok {relative(s.lastOkAt)})</span>}
            </td>
          </tr>
        );
      })}
    </>
  );
}

function OutgoingLinks() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['connections', 'links'],
    queryFn: () => api<Links>('/connections/links'),
    refetchInterval: 30_000,
  });
  if (isLoading) return <Loading />;
  if (isError || !data) return <ErrorState message="Link status could not load." onRetry={() => void refetch()} />;
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-ink/10">
          <tr>
            <th className="th">Job</th>
            <th className="th">Schedule</th>
            <th className="th">Last run</th>
            <th className="th">Result</th>
            <th className="th">Details</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink/5">
          <tr>
            <td className="td bg-bg/60 text-2xs font-semibold uppercase tracking-wider text-ink-2" colSpan={5}>
              HRMS {data.hrms.url ? <span className="ml-1 font-mono normal-case tracking-normal text-ink-3">{data.hrms.url}</span> : <span className="ml-1 normal-case tracking-normal text-ink-3">{data.hrms.web ? 'set up per company below' : 'not set up'}</span>}
              {(data.hrms.url || data.hrms.web) && (
                <span className="ml-2 inline-flex flex-wrap gap-1 align-middle normal-case tracking-normal">
                  {data.hrms.companies.map((c) => (
                    <Chip key={c.slug} value={c.configured ? 'active' : 'disabled'} label={`${c.name}${c.configured ? '' : ': no key'}`} />
                  ))}
                </span>
              )}
            </td>
          </tr>
          <JobRows jobs={data.hrms.jobs} enabled={data.hrms.enabled} />
          <tr>
            <td className="td bg-bg/60 text-2xs font-semibold uppercase tracking-wider text-ink-2" colSpan={5}>
              CRM {data.crm.url ? <span className="ml-1 font-mono normal-case tracking-normal text-ink-3">{data.crm.url}</span> : <span className="ml-1 normal-case tracking-normal text-ink-3">{data.crm.web ? 'set up per company below' : 'not set up'}</span>}
            </td>
          </tr>
          <JobRows jobs={data.crm.jobs} enabled={data.crm.enabled} />
          <tr>
            <td className="td bg-bg/60 text-2xs font-semibold uppercase tracking-wider text-ink-2" colSpan={5}>
              Webhooks
            </td>
          </tr>
          <JobRows jobs={data.webhooks.jobs} />
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------ one company's links */

type LinkKind = 'hrms' | 'crm';
type LinkSource = 'web' | 'env' | 'off' | 'none';

interface LinkRun {
  job: string;
  switchedOn: boolean;
  run: { ok: boolean; finishedAt: string; manual: boolean; result: unknown; error?: string | null; lastOkAt?: string | null } | null;
}

interface LinkView {
  source: LinkSource;
  url: string | null;
  defaultUrl: string;
  enabled: boolean | null;
  hasKey: boolean;
  keyLast4: string | null;
  error: string | null;
  updatedAt: string | null;
  env: { url: string | null; hasKey: boolean };
  jobs: LinkRun[];
  hasWebhookSecret?: boolean;
  webhookSecretFromEnv?: boolean;
  webhookPath?: string;
}

interface CompanyLinksView {
  company: { id: string; name: string; slug: string };
  hrms: LinkView;
  crm: LinkView;
}

interface LinkTest {
  ok: boolean;
  status: number | null;
  message: string;
}

const SOURCE_CHIP: Record<LinkSource, { value: string; label: string }> = {
  web: { value: 'active', label: 'Set here' },
  env: { value: 'transfer', label: 'From server settings' },
  off: { value: 'disabled', label: 'Switched off' },
  none: { value: 'unknown', label: 'Not connected' },
};

const LINK_TEXT: Record<LinkKind, { title: string; keyHelp: string; what: string }> = {
  hrms: {
    title: 'HR system (hr.vertexpakistan.com)',
    keyHelp: 'Get the key in the HR system: Admin → Integrations → VICIdial → Create key. Give it metrics.write and attendance.write.',
    what: 'Sends QA scores and dialer attendance for this company every hour.',
  },
  crm: {
    title: 'CRM (crm.vertexpakistan.com)',
    keyHelp: 'Get the key in the CRM: Admin → Connections → Keys → New key, with the scope metrics.write.',
    what: "Sends this company's QA scores every hour.",
  },
};

function LinkCard({ kind, companyId, view, onSaved }: { kind: LinkKind; companyId: string; view: LinkView; onSaved: (v: CompanyLinksView) => void }) {
  const text = LINK_TEXT[kind];
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [pushedAt, setPushedAt] = useState<number | null>(null);
  const queryClient = useQueryClient();

  // the form starts from what is saved whenever the company or the saved link changes
  useEffect(() => {
    setUrl(view.source === 'web' || view.source === 'off' ? (view.url ?? view.defaultUrl) : view.defaultUrl);
    setApiKey('');
    setWebhookSecret('');
    setEnabled(view.enabled ?? true);
    setStatus(null);
  }, [companyId, view.updatedAt, view.source, view.url, view.defaultUrl, view.enabled]);

  const savedHere = view.source === 'web' || view.source === 'off';
  const body = { companyId: companyId || undefined };

  const test = useMutation({
    mutationFn: () => api<{ result: LinkTest }>(`/connections/links/${kind}/test`, { method: 'POST', body: { ...body, url, apiKey: apiKey || undefined } }),
    onSuccess: (r) => setStatus({ ok: r.result.ok, text: r.result.message }),
    onError: (err) => setStatus({ ok: false, text: errMsg(err, 'The test could not run.') }),
  });
  const save = useMutation({
    mutationFn: () =>
      api<CompanyLinksView>(`/connections/links/${kind}`, {
        method: 'PUT',
        body: { ...body, url, apiKey: apiKey || undefined, enabled, ...(kind === 'hrms' ? { webhookSecret: webhookSecret || undefined } : {}) },
      }),
    onSuccess: (v) => {
      onSaved(v);
      setStatus({ ok: true, text: enabled ? 'Saved. The next hourly run uses this link; press Push now to send at once.' : 'Saved. This link is switched off for the company.' });
      void queryClient.invalidateQueries({ queryKey: ['connections', 'links'] });
    },
    onError: (err) => setStatus({ ok: false, text: errMsg(err, 'The link could not be saved.') }),
  });
  const remove = useMutation({
    mutationFn: () => api<CompanyLinksView>(`/connections/links/${kind}`, { method: 'DELETE', query: body }),
    onSuccess: (v) => {
      onSaved(v);
      setStatus({ ok: true, text: v[kind].source === 'env' ? 'Removed. The server settings apply again.' : 'Removed. This link is not connected now.' });
      void queryClient.invalidateQueries({ queryKey: ['connections', 'links'] });
    },
    onError: (err) => setStatus({ ok: false, text: errMsg(err, 'The link could not be removed.') }),
  });
  const push = useMutation({
    mutationFn: () => api<{ queued: string[] }>(`/connections/links/${kind}/push`, { method: 'POST', body }),
    onSuccess: (r) => {
      setPushedAt(Date.now());
      setStatus({ ok: true, text: `Queued: ${r.queued.map((n) => JOB_LABELS[n] ?? n).join(', ')}. Results appear below in a moment.` });
    },
    onError: (err) => setStatus({ ok: false, text: errMsg(err, 'Could not queue the push.') }),
  });

  // poll while a push just queued is running
  useEffect(() => {
    if (!pushedAt) return;
    const t = setInterval(() => {
      if (Date.now() - pushedAt > 120_000) {
        setPushedAt(null);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ['connections', 'links'] });
    }, 4000);
    return () => clearInterval(t);
  }, [pushedAt, queryClient]);

  const chip = SOURCE_CHIP[view.source];
  const busy = test.isPending || save.isPending || remove.isPending || push.isPending;
  const canSave = url.trim().length > 0 && (apiKey.length > 0 || (savedHere && view.hasKey));

  return (
    <div className="card space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-display text-sm font-bold">{text.title}</h3>
          <p className="text-2xs text-ink-3">{text.what}</p>
        </div>
        <Chip value={chip.value} label={chip.label} />
      </div>

      {view.source === 'env' && (
        <p className="rounded-md bg-bg px-3 py-2 text-2xs text-ink-2">
          Now using the server settings: <span className="font-mono">{view.url}</span>, key …{view.keyLast4}. Saving here replaces them for this company only.
        </p>
      )}
      {view.error && <div className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">{view.error}</div>}

      <Field label="Address">
        <input className="input font-mono text-2xs" value={url} placeholder={view.defaultUrl} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <Field label="API key" hint={text.keyHelp}>
        <input
          className="input font-mono text-2xs"
          type="password"
          autoComplete="new-password"
          value={apiKey}
          placeholder={savedHere && view.hasKey ? `Saved (…${view.keyLast4 ?? ''}). Leave empty to keep it.` : 'Paste the key'}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </Field>
      {kind === 'hrms' && (
        <Field
          label="Webhook secret (optional)"
          hint={`Only if the HR system sends changes to this platform, to ${window.location.origin}${view.webhookPath ?? ''}. ${
            view.hasWebhookSecret ? 'A secret is saved; leave empty to keep it.' : view.webhookSecretFromEnv ? 'The server settings have one for this company.' : ''
          }`}
        >
          <input
            className="input font-mono text-2xs"
            type="password"
            autoComplete="new-password"
            value={webhookSecret}
            placeholder={view.hasWebhookSecret ? 'Saved. Leave empty to keep it.' : ''}
            onChange={(e) => setWebhookSecret(e.target.value)}
          />
        </Field>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
        <span className="text-2xs text-ink-3">(off = nothing is sent for this company, not even with the server settings)</span>
      </label>

      {status && <div className={`rounded-md px-3 py-2 text-sm ${status.ok ? 'bg-good-soft text-good' : 'bg-bad-soft text-bad'}`}>{status.text}</div>}

      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary" disabled={busy || !url.trim()} onClick={() => test.mutate()}>
          <RefreshCw size={14} className={test.isPending ? 'animate-spin' : ''} /> Test
        </button>
        <button className="btn-primary" disabled={busy || !canSave} onClick={() => save.mutate()}>
          <Save size={14} /> Save
        </button>
        <button className="btn-secondary" disabled={busy || view.source === 'none' || view.source === 'off'} onClick={() => push.mutate()}>
          <Upload size={14} /> Push now
        </button>
        {savedHere && (
          <button
            className="btn-secondary text-bad hover:bg-bad-soft"
            disabled={busy}
            onClick={() => {
              if (window.confirm('Remove the link set here? The server settings apply again, if they cover this company.')) remove.mutate();
            }}
          >
            <Trash2 size={14} /> Remove
          </button>
        )}
      </div>

      <div className="border-t border-ink/5 pt-2">
        <div className="mb-1 text-2xs font-semibold text-ink-2">Last pushes</div>
        <ul className="space-y-1 text-2xs">
          {view.jobs.map((j) => (
            <li key={j.job} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{JOB_LABELS[j.job] ?? j.job}</span>
              {!j.switchedOn ? (
                <span className="text-ink-3">switched off in server settings</span>
              ) : !j.run ? (
                <span className="text-ink-3">not run yet</span>
              ) : (
                <>
                  <span className="font-mono text-ink-3">
                    {relative(j.run.finishedAt)}
                    {j.run.manual ? ' (push now)' : ''}
                  </span>
                  {j.run.ok ? <Chip value="success" label="ok" /> : <Chip value="failed" />}
                  <span className={j.run.ok ? 'text-ink-2' : 'text-bad'}>
                    {j.run.ok ? (j.run.result == null ? 'nothing sent for this company' : summarize(j.run.result) || 'no changes') : j.run.error}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function CompanyLinks() {
  const { isSuperAdmin } = useAuth();
  const { companyId: scopeId } = useCompanyScope();
  const [picked, setPicked] = useState('');
  const queryClient = useQueryClient();
  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ companies: Company[] }>('/companies'),
    enabled: isSuperAdmin,
  });
  const active = companies.data?.companies.filter((c) => c.status === 'active') ?? [];
  const companyId = isSuperAdmin ? picked || scopeId || active[0]?.id || '' : '';

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['connections', 'links', 'company', companyId],
    queryFn: () => api<CompanyLinksView>('/connections/links/company', { query: { companyId: companyId || undefined } }),
    enabled: !isSuperAdmin || !!companyId,
    refetchInterval: 30_000,
  });
  const onSaved = (v: CompanyLinksView) => queryClient.setQueryData(['connections', 'links', 'company', companyId], v);

  return (
    <div className="mb-2">
      {isSuperAdmin && (
        <div className="mb-3 max-w-sm">
          <Field label="Company">
            <select className="input" value={companyId} onChange={(e) => setPicked(e.target.value)}>
              {active.length === 0 && <option value="">No companies</option>}
              {active.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      {isSuperAdmin && !companyId ? null : isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <ErrorState message="The links could not load." onRetry={() => void refetch()} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <LinkCard kind="hrms" companyId={companyId} view={data.hrms} onSaved={onSaved} />
          <LinkCard kind="crm" companyId={companyId} view={data.crm} onSaved={onSaved} />
        </div>
      )}
    </div>
  );
}

function KeysPanel({ scopes }: { scopes: CatalogItem[] }) {
  const queryClient = useQueryClient();
  const { isSuperAdmin } = useAuth();
  const { companyId } = useCompanyScope();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['connections', 'keys', companyId],
    queryFn: () => api<{ keys: ApiKeyRow[] }>('/connections/keys', { query: { companyId: companyId || undefined } }),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['connections', 'keys'] });

  const create = useMutation({
    mutationFn: () =>
      api<{ secret: string }>('/connections/keys', {
        method: 'POST',
        body: { name, scopes: [...picked], ...companyBody(isSuperAdmin, company || companyId) },
      }),
    onSuccess: (r) => {
      setOpen(false);
      setName('');
      setPicked(new Set());
      setError(null);
      setSecret(r.secret);
      refresh();
    },
    onError: (err) => setError(errMsg(err, 'The key could not be made.')),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/connections/keys/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-display text-base font-bold">API keys</h2>
        <button className="btn-primary" onClick={() => setOpen(true)}>
          <Plus size={14} /> New key
        </button>
      </div>
      <p className="mb-3 text-sm text-ink-2">
        Other apps read QA data from <code className="font-mono text-2xs">/api/v1/ext/…</code> with <code className="font-mono text-2xs">Authorization: Bearer qa_…</code>. See docs/CONNECTIONS.md.
      </p>
      {isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <ErrorState message="Keys could not load." onRetry={() => void refetch()} />
      ) : data.keys.length === 0 ? (
        <EmptyState title="No API keys yet" hint="Make one for each app that should read QA data." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink/10">
              <tr>
                <th className="th">Name</th>
                <th className="th">Key</th>
                <th className="th">Company</th>
                <th className="th">Scopes</th>
                <th className="th">Last used</th>
                <th className="th">Status</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {data.keys.map((k) => (
                <tr key={k.id} className={k.revokedAt ? 'opacity-60' : 'hover:bg-bg/60'}>
                  <td className="td font-medium">
                    {k.name}
                    <div className="text-2xs font-normal text-ink-3">
                      {k.createdByName ? `${k.createdByName}, ` : ''}
                      {fmtDateTime(k.createdAt)}
                    </div>
                  </td>
                  <td className="td font-mono text-2xs">{k.keyPrefix}…</td>
                  <td className="td">{k.companyName ?? <Chip value="closer" label="all companies" />}</td>
                  <td className="td whitespace-normal">
                    <div className="flex flex-wrap gap-1">
                      {k.scopes.map((s) => (
                        <span key={s} className="chip bg-bg font-mono text-ink-2">
                          {s}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="td font-mono text-2xs">{relative(k.lastUsedAt)}</td>
                  <td className="td">{k.revokedAt ? <Chip value="disabled" label="revoked" /> : <Chip value="active" />}</td>
                  <td className="td text-right">
                    {!k.revokedAt && (
                      <button
                        className="btn-secondary px-2 py-1 text-2xs text-bad hover:bg-bad-soft"
                        disabled={revoke.isPending}
                        onClick={() => {
                          if (window.confirm(`Revoke "${k.name}"? Apps using it stop working at once.`)) revoke.mutate(k.id);
                        }}
                      >
                        <Trash2 size={13} /> Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal title="New API key" open={open} onClose={() => setOpen(false)}>
        <div className="space-y-3">
          <Field label="Name" hint="Which app uses it, e.g. CRM.">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <CompanyPicker value={company} onChange={setCompany} />
          <div>
            <label className="label">Scopes</label>
            <div className="space-y-1">
              {scopes.map((s) => (
                <label key={s.id} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-bg">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={picked.has(s.id)}
                    onChange={() => {
                      const next = new Set(picked);
                      if (next.has(s.id)) next.delete(s.id);
                      else next.add(s.id);
                      setPicked(next);
                    }}
                  />
                  <span>
                    <span className="font-mono text-2xs font-semibold">{s.id}</span>
                    <span className="block text-2xs text-ink-2">{s.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          {error && <div className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">{error}</div>}
          <button
            className="btn-primary w-full justify-center"
            onClick={() => create.mutate()}
            disabled={name.trim().length < 2 || picked.size === 0 || create.isPending || (isSuperAdmin && !(company || companyId))}
          >
            <KeyRound size={14} /> Make key
          </button>
        </div>
      </Modal>

      <SecretModal title="Your new API key" secret={secret} hint="Give this key to the app. It is sent as Authorization: Bearer <key>." onClose={() => setSecret(null)} />
    </section>
  );
}

function DeliveriesModal({ hook, onClose }: { hook: WebhookRow | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['connections', 'deliveries', hook?.id],
    queryFn: () => api<{ deliveries: DeliveryRow[] }>(`/connections/webhooks/${hook!.id}/deliveries`),
    enabled: !!hook,
    refetchInterval: 10_000,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api(`/connections/deliveries/${id}/retry`, { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['connections', 'deliveries', hook?.id] }),
  });
  return (
    <Modal title={`Deliveries: ${hook?.name ?? ''}`} open={!!hook} onClose={onClose} wide>
      {isLoading ? (
        <Loading />
      ) : !data?.deliveries.length ? (
        <p className="text-sm text-ink-2">Nothing sent yet.</p>
      ) : (
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink/10">
              <tr>
                <th className="th">Event</th>
                <th className="th">Created</th>
                <th className="th">Tries</th>
                <th className="th">Result</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {data.deliveries.map((d) => {
                const pending = !d.deliveredAt && !!d.nextAttemptAt;
                return (
                  <tr key={d.id}>
                    <td className="td font-mono text-2xs">{d.event}</td>
                    <td className="td font-mono text-2xs">{fmtDateTime(d.createdAt)}</td>
                    <td className="td tabular-nums">{d.attempts}</td>
                    <td className="td whitespace-normal text-2xs">
                      {d.deliveredAt ? (
                        <Chip value="success" label={`delivered ${d.lastStatus ?? ''}`} />
                      ) : pending ? (
                        <span className="text-amber-line">
                          {d.lastError ?? 'queued'} · next try {fmtDateTime(d.nextAttemptAt)}
                        </span>
                      ) : (
                        <span className="text-bad">{d.lastError ?? 'failed'}</span>
                      )}
                    </td>
                    <td className="td text-right">
                      {!d.deliveredAt && d.event !== 'ping' && (
                        <button className="btn-secondary px-2 py-1 text-2xs" disabled={retry.isPending} onClick={() => retry.mutate(d.id)}>
                          <RefreshCw size={13} /> Retry now
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function WebhooksPanel({ events }: { events: CatalogItem[] }) {
  const queryClient = useQueryClient();
  const { isSuperAdmin } = useAuth();
  const { companyId } = useCompanyScope();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [company, setCompany] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set(['*']));
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [deliveriesOf, setDeliveriesOf] = useState<WebhookRow | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['connections', 'webhooks', companyId],
    queryFn: () => api<{ webhooks: WebhookRow[] }>('/connections/webhooks', { query: { companyId: companyId || undefined } }),
    refetchInterval: 30_000,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['connections', 'webhooks'] });

  const create = useMutation({
    mutationFn: () =>
      api<{ secret: string }>('/connections/webhooks', {
        method: 'POST',
        body: { name, url, events: [...picked], ...companyBody(isSuperAdmin, company || companyId) },
      }),
    onSuccess: (r) => {
      setOpen(false);
      setName('');
      setUrl('');
      setPicked(new Set(['*']));
      setError(null);
      setSecret(r.secret);
      refresh();
    },
    onError: (err) => setError(errMsg(err, 'The webhook could not be added.')),
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; active: boolean }) => api(`/connections/webhooks/${v.id}`, { method: 'PATCH', body: { active: v.active } }),
    onSuccess: refresh,
  });
  const ping = useMutation({
    mutationFn: (id: string) => api<{ result: { ok: boolean; status: number | null; error: string | null; ms: number } }>(`/connections/webhooks/${id}/ping`, { method: 'POST' }),
    onSuccess: (r) => {
      setNotice(r.result.ok ? { ok: true, text: `Test delivered: HTTP ${r.result.status} in ${r.result.ms} ms.` } : { ok: false, text: `Test failed: ${r.result.error}` });
      refresh();
    },
    onError: (err) => setNotice({ ok: false, text: errMsg(err, 'Test could not be sent.') }),
  });
  const rotate = useMutation({
    mutationFn: (id: string) => api<{ secret: string }>(`/connections/webhooks/${id}/rotate`, { method: 'POST' }),
    onSuccess: (r) => setSecret(r.secret),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/connections/webhooks/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const toggleEvent = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-display text-base font-bold">Webhooks</h2>
        <button className="btn-primary" onClick={() => setOpen(true)}>
          <Plus size={14} /> New webhook
        </button>
      </div>
      <p className="mb-3 text-sm text-ink-2">Signed POSTs to another app when an evaluation is completed or a sale closes or reopens. Failed deliveries are retried for about 24 hours.</p>
      {notice && <div className={`mb-3 rounded-md px-3 py-2 text-sm ${notice.ok ? 'bg-good-soft text-good' : 'bg-bad-soft text-bad'}`}>{notice.text}</div>}
      {isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <ErrorState message="Webhooks could not load." onRetry={() => void refetch()} />
      ) : data.webhooks.length === 0 ? (
        <EmptyState title="No webhooks yet" hint="Add one to tell another app about new evaluations and sales." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink/10">
              <tr>
                <th className="th">Name</th>
                <th className="th">Events</th>
                <th className="th">Company</th>
                <th className="th">Last delivery</th>
                <th className="th">Status</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {data.webhooks.map((w) => (
                <tr key={w.id} className={w.active ? 'hover:bg-bg/60' : 'opacity-70'}>
                  <td className="td font-medium">
                    {w.name}
                    <div className="max-w-xs truncate font-mono text-2xs font-normal text-ink-3" title={w.url}>
                      {w.url}
                    </div>
                  </td>
                  <td className="td whitespace-normal">
                    <div className="flex flex-wrap gap-1">
                      {w.events.map((e) => (
                        <span key={e} className="chip bg-bg font-mono text-ink-2">
                          {e}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="td">{w.companyName ?? <Chip value="closer" label="all companies" />}</td>
                  <td className="td font-mono text-2xs">
                    {relative(w.lastDeliveryAt)}
                    {w.lastStatus != null && <span className="ml-1 text-ink-3">HTTP {w.lastStatus}</span>}
                  </td>
                  <td className="td whitespace-normal">
                    {!w.active ? (
                      <Chip value="disabled" label="paused" />
                    ) : w.failingSince ? (
                      <span title={w.lastError ?? ''}>
                        <Chip value="failed" label={`failing since ${relative(w.failingSince)}`} />
                      </span>
                    ) : (
                      <Chip value="active" />
                    )}
                  </td>
                  <td className="td text-right">
                    <div className="flex justify-end gap-1">
                      <button className="btn-secondary px-2 py-1 text-2xs" disabled={ping.isPending} onClick={() => ping.mutate(w.id)}>
                        <Send size={13} /> Test
                      </button>
                      <button className="btn-secondary px-2 py-1 text-2xs" onClick={() => setDeliveriesOf(w)}>
                        Deliveries
                      </button>
                      <button className="btn-secondary px-2 py-1 text-2xs" onClick={() => patch.mutate({ id: w.id, active: !w.active })}>
                        {w.active ? 'Pause' : 'Resume'}
                      </button>
                      <button
                        className="btn-secondary px-2 py-1 text-2xs"
                        onClick={() => {
                          if (window.confirm(`Make a new signing secret for "${w.name}"? The old one stops working at once.`)) rotate.mutate(w.id);
                        }}
                      >
                        <RefreshCw size={13} /> Secret
                      </button>
                      <button
                        className="btn-secondary px-2 py-1 text-2xs text-bad hover:bg-bad-soft"
                        onClick={() => {
                          if (window.confirm(`Delete "${w.name}" and its delivery history?`)) remove.mutate(w.id);
                        }}
                        aria-label={`Delete ${w.name}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal title="New webhook" open={open} onClose={() => setOpen(false)}>
        <div className="space-y-3">
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="URL" hint="Receives a POST with a JSON body for each event.">
            <input className="input font-mono" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value.trim())} />
          </Field>
          <CompanyPicker value={company} onChange={setCompany} />
          <div>
            <label className="label">Events</label>
            <div className="space-y-1">
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-bg">
                <input type="checkbox" checked={picked.has('*')} onChange={() => toggleEvent('*')} />
                <span className="font-mono text-2xs font-semibold">*</span>
                <span className="text-2xs text-ink-2">every event, including ones added later</span>
              </label>
              {events
                .filter((e) => e.id !== 'ping')
                .map((e) => (
                  <label key={e.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-bg">
                    <input type="checkbox" checked={picked.has(e.id)} disabled={picked.has('*')} onChange={() => toggleEvent(e.id)} />
                    <span className="font-mono text-2xs font-semibold">{e.id}</span>
                    <span className="text-2xs text-ink-2">{e.description}</span>
                  </label>
                ))}
            </div>
          </div>
          {error && <div className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">{error}</div>}
          <button
            className="btn-primary w-full justify-center"
            onClick={() => create.mutate()}
            disabled={name.trim().length < 2 || !/^https?:\/\/./.test(url) || picked.size === 0 || create.isPending || (isSuperAdmin && !(company || companyId))}
          >
            <Webhook size={14} /> Add webhook
          </button>
        </div>
      </Modal>

      <SecretModal
        title="Webhook signing secret"
        secret={secret}
        hint="The receiver checks x-qa-signature: hex HMAC-SHA256 of '<x-qa-timestamp>.<raw body>' with this secret."
        onClose={() => {
          setSecret(null);
          refresh();
        }}
      />
      <DeliveriesModal hook={deliveriesOf} onClose={() => setDeliveriesOf(null)} />
    </section>
  );
}

export function ConnectionsPage() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['connections', 'catalog'],
    queryFn: () => api<{ scopes: CatalogItem[]; events: CatalogItem[] }>('/connections/catalog'),
    staleTime: Infinity,
  });
  return (
    <div>
      <PageHeader title="Connections" subtitle="Let other apps read QA data and hear about new evaluations and sales" />
      {isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <ErrorState message="Connections could not load." onRetry={() => void refetch()} />
      ) : (
        <>
          <KeysPanel scopes={data.scopes} />
          <WebhooksPanel events={data.events} />
        </>
      )}
      <section>
        <h2 className="mb-2 font-display text-base font-bold">Outgoing links</h2>
        <p className="mb-3 text-sm text-ink-2">
          What this platform sends to the HR system and the CRM every hour. Connect them for a company here; a link set here wins over the server settings, which still cover every
          company without one.
        </p>
        <CompanyLinks />
        <h3 className="mb-2 mt-6 text-sm font-semibold text-ink-2">All companies: last runs</h3>
        <OutgoingLinks />
      </section>
    </div>
  );
}
