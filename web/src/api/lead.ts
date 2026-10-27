import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { LeadInfo } from '../components/LeadCard';

export interface LeadResponse {
  lead: LeadInfo | null;
  /** the list's custom_<id> fields, when the dialer has them */
  leadCustom: LeadInfo | null;
}

/**
 * The lead's record, read from the dialer. Loaded on its own so a call or
 * evaluation page never waits on the dialer to appear, and shared by both
 * pages (same key), so opening an evaluation from a call shows it at once.
 */
export function leadQueryOptions(transferId: string | null | undefined) {
  return {
    queryKey: ['transfer-lead', transferId] as const,
    queryFn: () => api<LeadResponse>(`/queues/detail/${transferId}/lead`),
    staleTime: 60_000,
  };
}

export function useLeadInfo(transferId: string | null | undefined) {
  return useQuery({ ...leadQueryOptions(transferId), enabled: !!transferId });
}
