import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Satellite, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { Dialer } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { useCompanyScope } from '../../components/Layout';
import { Chip, EmptyState, ErrorState, Field, Loading, Modal, PageHeader, fmtDateTime } from '../../components/ui';
import { DeleteConfirmModal, DeletingChip } from '../../components/DeleteConfirm';

interface DialerForm {
  name: string;
  baseUrl: string;
  sourceMode: 'api' | 'db' | 'hybrid';
  timezone: string;
  active: boolean;
  apiUser: string;
  apiPass: string;
  dbHost: string;
  dbPort: string;
  dbName: string;
  dbUser: string;
  dbPass: string;
  recordingBaseUrl: string;
  recordingAuthUser: string;
  recordingAuthPass: string;
}

interface TestResult {
  api: { ok: boolean; detail: string };
  db: { ok: boolean; detail: string };
  time: null | {
    dialerLocalTime: string | null;
    platformUtc: string;
    measuredOffsetMin: number | null;
    configuredOffsetMin: number;
    driftSec: number | null;
    timezoneMatches: boolean;
  };
}

const EMPTY: DialerForm = {
  name: '',
  baseUrl: '',
  sourceMode: 'hybrid',
  timezone: 'America/New_York',
  active: true,
  apiUser: '',
  apiPass: '',
  dbHost: '',
  dbPort: '3306',
  dbName: 'asterisk',
  dbUser: '',
  dbPass: '',
  recordingBaseUrl: '',
  recordingAuthUser: '',
  recordingAuthPass: '',
};

// Every IANA zone the browser knows, with the common call-centre ones first.
// Typing a zone by hand was error-prone, and a wrong zone shifts every count.
const COMMON_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'Asia/Karachi',
  'Asia/Dubai',
  'Asia/Manila',
  'Asia/Kolkata',
  'Europe/London',
  'UTC',
];
const ALL_ZONES: string[] = (() => {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    return intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
})();
function zoneOffset(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date());
    return parts.find((x) => x.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}
export function DialersPage() {
  const { companyId } = useCompanyScope();
  const { isSuperAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Dialer | 'new' | null>(null);
  const [form, setForm] = useState<DialerForm>(EMPTY);
  const zoneOptions = useMemo(() => {
    const all = ALL_ZONES.filter((z) => !COMMON_ZONES.includes(z));
    const offsets: Record<string, string> = {};
    for (const z of [...COMMON_ZONES, ...all]) offsets[z] = zoneOffset(z);
    return { all, offsets };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, TestResult>>({});
  const [deleting, setDeleting] = useState<Dialer | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['dialers', companyId, 'admin'],
    queryFn: () =>
      api<{ dialers: Dialer[] }>('/dialers', { query: { companyId: companyId || undefined, includeDeleting: true } }),
    // while a dialer is being removed, follow it until it is gone
    refetchInterval: (q) => (q.state.data?.dialers.some((d) => d.deletingAt) ? 5_000 : false),
  });

  const openEditor = (d: Dialer | 'new') => {
    setError(null);
    setEditing(d);
    setForm(
      d === 'new'
        ? EMPTY
        : {
            ...EMPTY,
            name: d.name,
            baseUrl: d.baseUrl,
            sourceMode: d.sourceMode,
            timezone: d.timezone,
            active: d.active,
          },
    );
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: form.name,
        baseUrl: form.baseUrl,
        sourceMode: form.sourceMode,
        timezone: form.timezone,
        active: form.active,
      };
      // credentials only sent when (re)entered — blank keeps the stored secret
      if (form.apiUser) body.apiUser = form.apiUser;
      if (form.apiPass) body.apiPass = form.apiPass;
      if (form.dbHost) {
        body.dbHost = form.dbHost;
        body.dbPort = Number(form.dbPort) || 3306;
        body.dbName = form.dbName;
      }
      if (form.dbUser) body.dbUser = form.dbUser;
      if (form.dbPass) body.dbPass = form.dbPass;
      if (form.recordingBaseUrl) body.recordingBaseUrl = form.recordingBaseUrl;
      if (form.recordingAuthUser) body.recordingAuthUser = form.recordingAuthUser;
      if (form.recordingAuthPass) body.recordingAuthPass = form.recordingAuthPass;
      if (editing === 'new') {
        if (companyId) body.companyId = companyId;
        return api('/dialers', { method: 'POST', body });
      }
      return api(`/dialers/${(editing as Dialer).id}`, { method: 'PATCH', body });
    },
    onSuccess: () => {
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ['dialers'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  const test = useMutation({
    mutationFn: (id: string) => api<TestResult>(`/dialers/${id}/test`, { method: 'POST' }),
    onSuccess: (res, id) => setTestResult((prev) => ({ ...prev, [id]: res })),
  });

  const sync = useMutation({
    mutationFn: (id: string) => api(`/dialers/${id}/sync?full=true`, { method: 'POST' }),
  });

  return (
    <div>
      <PageHeader
        title="Dialer servers"
        subtitle="VICIdial clusters this platform syncs calls, transfers and recordings from"
        actions={
          <button
            className="btn-primary"
            onClick={() => openEditor('new')}
            disabled={isSuperAdmin && !companyId}
            title={isSuperAdmin && !companyId ? 'Pick a company scope first' : undefined}
          >
            <Plus size={14} /> Add dialer
          </button>
        }
      />

      {isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <ErrorState message="Dialers could not load." onRetry={() => void refetch()} />
      ) : data.dialers.length === 0 ? (
        <EmptyState title="No dialer servers" hint="Add your VICIdial server with its API user and read-only DB credentials." />
      ) : (
        <div className="space-y-3">
          {data.dialers.map((d) => {
            const t = testResult[d.id];
            if (d.deletingAt) {
              return (
                <div key={d.id} className="card p-4 opacity-70">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-display font-bold">{d.name}</span>
                    <DeletingChip />
                  </div>
                  <p className="mt-1 text-2xs text-ink-3">
                    Sync stopped. Its calls, recordings and evaluations are being removed in the background — it
                    disappears from this list when that is done.
                  </p>
                </div>
              );
            }
            return (
              <div key={d.id} className="card p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-display font-bold">{d.name}</span>
                      <Chip value={d.active ? 'active' : 'disabled'} label={d.active ? 'active' : 'inactive'} />
                      <span className="chip bg-bg text-ink-2">{d.sourceMode}</span>
                    </div>
                    <div className="mt-0.5 font-mono text-2xs text-ink-3">
                      {d.baseUrl} · {d.timezone} · last seen {fmtDateTime(d.lastSeenAt)}
                    </div>
                    <div className="mt-1 flex gap-2 text-2xs">
                      <Chip value={d.hasApiCredentials ? 'available' : 'missing'} label={d.hasApiCredentials ? 'API creds' : 'no API creds'} />
                      <Chip value={d.hasDbCredentials ? 'available' : 'missing'} label={d.hasDbCredentials ? 'DB creds' : 'no DB creds'} />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button className="btn-secondary" onClick={() => test.mutate(d.id)} disabled={test.isPending}>
                      <Satellite size={14} /> Test connection
                    </button>
                    <button className="btn-secondary" onClick={() => sync.mutate(d.id)} disabled={sync.isPending || !d.active}>
                      <RefreshCw size={14} /> Full sync
                    </button>
                    <button className="btn-primary" onClick={() => openEditor(d)}>
                      Edit
                    </button>
                    <button
                      className="btn-secondary text-bad hover:bg-bad-soft"
                      onClick={() => setDeleting(d)}
                      aria-label={`Delete ${d.name}`}
                      title="Delete this dialer and its data"
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                  </div>
                </div>
                {t && (
                  <div className="mt-3 grid gap-2 text-2xs md:grid-cols-2">
                    <div className={`rounded-md px-3 py-2 ${t.api.ok ? 'bg-good-soft text-good' : 'bg-bad-soft text-bad'}`}>
                      <strong>Non-Agent API:</strong> {t.api.detail}
                    </div>
                    <div className={`rounded-md px-3 py-2 ${t.db.ok ? 'bg-good-soft text-good' : 'bg-bad-soft text-bad'}`}>
                      <strong>Read-only MySQL:</strong> {t.db.detail}
                    </div>
                    {t.time && (
                      <div
                        className={`rounded-md px-3 py-2 md:col-span-2 ${
                          t.time.timezoneMatches && (t.time.driftSec == null || Math.abs(t.time.driftSec) <= 90)
                            ? 'bg-good-soft text-good'
                            : 'bg-amber-soft text-amber-line'
                        }`}
                      >
                        <strong>Clock check:</strong> dialer time{' '}
                        <span className="font-mono">{t.time.dialerLocalTime ?? '?'}</span> · platform (UTC){' '}
                        <span className="font-mono">{t.time.platformUtc.slice(0, 19).replace('T', ' ')}</span>
                        {t.time.driftSec != null && <> · drift {t.time.driftSec}s</>}
                        {!t.time.timezoneMatches &&
                          ' · configured timezone does not match the dialer clock — sync auto-corrects using the measured offset'}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Modal title={editing === 'new' ? 'Add dialer server' : 'Edit dialer server'} open={!!editing} onClose={() => setEditing(null)} wide>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Dialer 1 (fronters)" />
          </Field>
          <Field label="Base URL" hint="https://your-dialer.example.com — hosts /vicidial/non_agent_api.php">
            <input className="input font-mono" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          </Field>
          <Field label="Source mode" hint="DB is the recommended source for call logs; API alone cannot export them.">
            <select className="input" value={form.sourceMode} onChange={(e) => setForm({ ...form, sourceMode: e.target.value as DialerForm['sourceMode'] })}>
              <option value="hybrid">Hybrid (DB logs + API recordings)</option>
              <option value="db">Read-only DB only</option>
              <option value="api">API only (limited)</option>
            </select>
          </Field>
          <Field label="Server timezone" hint="The zone the dialer logs its times in — every count here is per dialer day.">
            <select className="input font-mono" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {!zoneOptions.all.includes(form.timezone) && !COMMON_ZONES.includes(form.timezone) && (
                <option value={form.timezone}>{form.timezone}</option>
              )}
              <optgroup label="Common">
                {COMMON_ZONES.map((z) => (
                  <option key={z} value={z}>
                    {z} ({zoneOptions.offsets[z]})
                  </option>
                ))}
              </optgroup>
              {zoneOptions.all.length > 0 && (
                <optgroup label="All zones">
                  {zoneOptions.all.map((z) => (
                    <option key={z} value={z}>
                      {z} ({zoneOptions.offsets[z]})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Field>
          <Field label="API user">
            <input className="input" value={form.apiUser} onChange={(e) => setForm({ ...form, apiUser: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="API password" hint={editing !== 'new' ? 'Leave blank to keep the stored secret.' : undefined}>
            <input className="input" type="password" value={form.apiPass} onChange={(e) => setForm({ ...form, apiPass: e.target.value })} autoComplete="new-password" />
          </Field>
          <Field label="MySQL host">
            <input className="input font-mono" value={form.dbHost} onChange={(e) => setForm({ ...form, dbHost: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Port">
              <input className="input font-mono" value={form.dbPort} onChange={(e) => setForm({ ...form, dbPort: e.target.value })} />
            </Field>
            <Field label="Database">
              <input className="input font-mono" value={form.dbName} onChange={(e) => setForm({ ...form, dbName: e.target.value })} />
            </Field>
          </div>
          <Field label="MySQL user" hint="Grant SELECT only.">
            <input className="input" value={form.dbUser} onChange={(e) => setForm({ ...form, dbUser: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="MySQL password" hint={editing !== 'new' ? 'Leave blank to keep the stored secret.' : undefined}>
            <input className="input" type="password" value={form.dbPass} onChange={(e) => setForm({ ...form, dbPass: e.target.value })} autoComplete="new-password" />
          </Field>
          <Field label="Recording base URL" hint="Fallback when recording_log has no absolute URL.">
            <input className="input font-mono" value={form.recordingBaseUrl} onChange={(e) => setForm({ ...form, recordingBaseUrl: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Recording auth user">
              <input className="input" value={form.recordingAuthUser} onChange={(e) => setForm({ ...form, recordingAuthUser: e.target.value })} autoComplete="off" />
            </Field>
            <Field label="Recording auth password">
              <input className="input" type="password" value={form.recordingAuthPass} onChange={(e) => setForm({ ...form, recordingAuthPass: e.target.value })} autoComplete="new-password" />
            </Field>
          </div>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
          Active (included in scheduled sync)
        </label>
        {error && <div className="mt-3 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">{error}</div>}
        <button
          className="btn-primary mt-4 w-full justify-center"
          onClick={() => saveMutation.mutate()}
          disabled={form.name.length < 2 || !/^https?:\/\//.test(form.baseUrl) || saveMutation.isPending}
        >
          {editing === 'new' ? 'Add dialer' : 'Save changes'}
        </button>
      </Modal>

      {deleting && (
        <DeleteConfirmModal
          open={!!deleting}
          onClose={() => setDeleting(null)}
          kind="dialer"
          name={deleting.name}
          usagePath={`/dialers/${deleting.id}/usage`}
          deletePath={`/dialers/${deleting.id}`}
          consequences="It stops syncing right away and leaves every list and filter. Its calls, recordings, transfers and their evaluations are then removed in the background. QA forms stay."
          onDeleted={() => {
            void queryClient.invalidateQueries({ queryKey: ['dialers'] });
          }}
        />
      )}
    </div>
  );
}
