import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export type Leg = 'fronter' | 'closer' | 'sale';

/** one recording as the live endpoint returns it */
export interface RecordingItem {
  id: string;
  callId: string | null;
  filename: string;
  status: string;
  lengthSec: number | null;
  startTime: string | null;
  /** verified on the dialer's final MP3 (a .wav is the live, partial file) */
  final: boolean;
  /** 'other' = another call on the same lead (callback, earlier attempt) */
  leg: Leg | 'other';
  callStatus: string | null;
  callSource: string | null;
  callUser: string | null;
  agentName: string | null;
  termReason: string | null;
}

export interface LegState {
  callId: string;
  status: string | null;
  lengthSec: number | null;
  termReason: string | null;
  inProgress: boolean;
  endedAt: string | null;
}

export interface LiveRecordings {
  items: RecordingItem[];
  legs: Partial<Record<Leg, LegState>>;
  /** the server keeps this true while a call is up or a file is still being prepared */
  live: boolean;
  checkedAt: string;
  fronterFromLead: boolean;
}

/**
 * A call's recordings, re-checked against the dialer by the server on each
 * request. Polls every 8 s only while the server says something can still
 * change, so an open page shows a recording the moment the dialer has it
 * and goes quiet once everything is final.
 */
export function useLiveRecordings(transferId: string | null | undefined) {
  return useQuery({
    queryKey: ['transfer-recordings', transferId],
    queryFn: () => api<LiveRecordings>(`/queues/detail/${transferId}/recordings`),
    enabled: !!transferId,
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.live ? 8_000 : false),
    refetchIntervalInBackground: false,
  });
}
