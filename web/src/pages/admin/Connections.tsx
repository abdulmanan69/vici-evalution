import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Plus, RefreshCw, Send, Trash2, Webhook } from 'lucide-react';
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
    jobs: Record<string, JobState | null>;
    enabled: Record<string, boolean>;
  };
  crm: { url: string | null; configured: boolean; jobs: Record<string, JobState | null>; enabled: Record<string, boolean> };
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
              HRMS {data.hrms.url ? <span className="ml-1 font-mono normal-case tracking-normal text-ink-3">{data.hrms.url}</span> : <span className="ml-1 normal-case tracking-normal text-ink-3">not set up (HRMS_URL)</span>}
              {data.hrms.url && (
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
              CRM {data.crm.url ? <span className="ml-1 font-mono normal-case tracking-normal text-ink-3">{data.crm.url}</span> : <span className="ml-1 normal-case tracking-normal text-ink-3">not set up (CRM_URL, CRM_API_KEY)</span>}
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
        <p className="mb-3 text-sm text-ink-2">What this platform sends to the HRMS and the CRM every hour, and how the last run went. Set up through server settings.</p>
        <OutgoingLinks />
      </section>
    </div>
  );
}
