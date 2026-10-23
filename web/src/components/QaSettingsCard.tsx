import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useCompanyScope } from './Layout';

interface QaSettings {
  evaluationEditWindowMinutes: number;
}

/**
 * Manager settings for evaluations: how long after completing one the
 * reviewer may still change it. Rendered only for managers.
 */
export function QaSettingsCard() {
  const { hasPerm, isSuperAdmin } = useAuth();
  const { companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [hours, setHours] = useState('');
  const canManage = hasPerm('qa.forms.manage');
  const needsCompany = isSuperAdmin && !companyId;

  const settings = useQuery({
    queryKey: ['qa-settings', companyId],
    queryFn: () => api<{ settings: QaSettings }>('/qa/settings', { query: { companyId: companyId || undefined } }),
    enabled: canManage && !needsCompany,
  });
  useEffect(() => {
    if (settings.data) setHours(String(settings.data.settings.evaluationEditWindowMinutes / 60));
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      api<{ settings: QaSettings }>('/qa/settings', {
        method: 'PATCH',
        body: { companyId: companyId || undefined, evaluationEditWindowMinutes: Math.round(Number(hours) * 60) },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['qa-settings'] }),
  });

  if (!canManage) return null;
  const minutes = Math.round(Number(hours) * 60);
  const valid = hours !== '' && Number.isFinite(Number(hours)) && minutes >= 0 && minutes <= 30 * 24 * 60;
  const dirty = settings.data ? minutes !== settings.data.settings.evaluationEditWindowMinutes : false;

  return (
    <div className="card mb-4 p-4">
      <h2 className="mb-1 flex items-center gap-2 font-display text-sm font-bold">
        <Lock size={14} className="text-brand" /> Evaluation edit window
      </h2>
      {needsCompany ? (
        <p className="text-sm text-ink-2">Pick a company in the scope selector above to change its settings.</p>
      ) : (
        <>
          <p className="text-sm text-ink-2">
            After a reviewer completes an evaluation they can still correct it for this long. After that it is locked
            and only the score remains. Reviewers see the deadline before they complete and on the finished evaluation.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span>Reviewers can edit for</span>
            <input
              type="number"
              min={0}
              max={720}
              step={0.5}
              className="input w-24"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              aria-label="Hours"
            />
            <span>hours after completing</span>
            <span className="text-2xs text-ink-3">(0 = locked the moment it is completed)</span>
            <button className="btn-primary" onClick={() => save.mutate()} disabled={!valid || !dirty || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            {save.isSuccess && !dirty && <span className="text-2xs text-good">Saved.</span>}
            {save.isError && (
              <span className="text-2xs text-bad">{save.error instanceof ApiError ? save.error.message : 'Could not save.'}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
