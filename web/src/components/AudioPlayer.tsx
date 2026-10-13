import { useEffect, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, RotateCw } from 'lucide-react';
import { fmtDuration } from './ui';

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

/**
 * Streams through the authenticated proxy (/api/v1/recordings/:id/stream).
 * The session cookie rides along — recordings never have public URLs.
 */
export function AudioPlayer({ recordingId, label }: { recordingId: string; label?: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setTime(a.currentTime);
    const onMeta = () => setDuration(a.duration || 0);
    const onEnd = () => setPlaying(false);
    const onErr = () => setError('Recording could not be loaded — it may be missing on the dialer.');
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('ended', onEnd);
    a.addEventListener('error', onErr);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('ended', onEnd);
      a.removeEventListener('error', onErr);
    };
  }, []);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      void a.play().then(() => setPlaying(true)).catch(() => setError('Playback failed.'));
    }
  };

  const seek = (t: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min(t, duration || t));
  };

  const changeSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  if (error) {
    return <div className="rounded-md bg-bad-soft px-3 py-2 text-2xs text-bad">{error}</div>;
  }

  return (
    <div className="flex items-center gap-2 rounded-md bg-bg px-3 py-2">
      <audio ref={audioRef} src={`/api/v1/recordings/${recordingId}/stream`} preload="metadata" />
      <button
        onClick={toggle}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-white hover:bg-brand-dark"
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
      </button>
      <button onClick={() => seek(time - 10)} className="text-ink-2 hover:text-ink" aria-label="Back 10 seconds">
        <RotateCcw size={14} />
      </button>
      <button onClick={() => seek(time + 10)} className="text-ink-2 hover:text-ink" aria-label="Forward 10 seconds">
        <RotateCw size={14} />
      </button>
      <span className="w-12 shrink-0 text-right font-mono text-2xs text-ink-2">{fmtDuration(Math.floor(time))}</span>
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={1}
        value={time}
        onChange={(e) => seek(Number(e.target.value))}
        className="h-1 w-full flex-1 accent-brand"
        aria-label="Seek"
      />
      <span className="w-12 shrink-0 font-mono text-2xs text-ink-2">{fmtDuration(Math.floor(duration))}</span>
      <button onClick={changeSpeed} className="w-10 shrink-0 rounded bg-surface px-1 py-0.5 font-mono text-2xs shadow-card">
        {speed}×
      </button>
      {label && <span className="hidden truncate font-mono text-2xs text-ink-3 md:block">{label}</span>}
    </div>
  );
}
