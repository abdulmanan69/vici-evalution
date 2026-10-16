import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { candidateUrls, isFinalMp3, isHttpUrl, linkRecordingToCall, mp3Variant, recordingBaseName } = await import(
  './recordingUrl.js'
);

// cases seen on the live dialer (times shortened to seconds of one day)
const at = (hms: string) => new Date(`2026-10-15T${hms}Z`);
const call = (id: string, hms: string, lengthSec: number) => ({ id, callDate: at(hms), lengthSec });

describe('recording → call linking', () => {
  it('picks the XFER call over a 3 s no-answer that started 1 s nearer', () => {
    const calls = [call('noanswer', '12:01:58', 3), call('xfer', '12:02:17', 253), call('closer', '12:06:30', 184)];
    expect(linkRecordingToCall(at('12:02:07'), 263, calls)).toBe('xfer');
    expect(linkRecordingToCall(at('12:01:54'), 7, calls)).toBe('noanswer');
    expect(linkRecordingToCall(at('12:06:30'), 184, calls)).toBe('closer');
  });

  it('keeps a short closer recording on the long closer call (hold time)', () => {
    const calls = [call('xfer', '13:37:33', 249), call('closer', '13:41:43', 1272)];
    expect(linkRecordingToCall(at('13:41:43'), 506, calls)).toBe('closer');
    expect(linkRecordingToCall(at('13:37:33'), 249, calls)).toBe('xfer');
  });

  it('a fronter recording ending at the handoff beats a 2 s machine call', () => {
    const calls = [call('machine', '19:27:02', 2), call('xfer', '19:27:32', 25), call('closer', '19:27:57', 465)];
    expect(linkRecordingToCall(at('19:27:11'), 46, calls)).toBe('xfer');
    expect(linkRecordingToCall(at('19:27:57'), 463, calls)).toBe('closer');
  });

  it('links nothing beyond 15 minutes', () => {
    expect(linkRecordingToCall(at('10:00:00'), 60, [call('far', '10:16:00', 60)])).toBeNull();
  });
});

describe('recording URL repair', () => {
  it('maps the temporary wav to the converted MP3 location', () => {
    expect(mp3Variant('http://10.0.0.1/RECORDINGS/20261015-174854_2039013302-all.wav')).toBe(
      'http://10.0.0.1/RECORDINGS/MP3/20261015-174854_2039013302-all.mp3',
    );
    expect(mp3Variant('http://10.0.0.1/RECORDINGS/MP3/20261015-174854_2039013302-all.mp3')).toBeNull();
  });

  it('rejects shifted-column values as URLs', () => {
    expect(isHttpUrl('92')).toBe(false);
    expect(isHttpUrl('http://10.0.0.1/RECORDINGS/x.wav')).toBe(true);
  });

  it('derives the base name from any variant', () => {
    expect(recordingBaseName('20261015-164455_8652570707')).toBe('20261015-164455_8652570707');
    expect(recordingBaseName('20261015-164455_8652570707-all.wav')).toBe('20261015-164455_8652570707');
    expect(recordingBaseName('20261015-164455_8652570707-all.mp3')).toBe('20261015-164455_8652570707');
  });

  it('orders candidates: converted MP3, stored URL, then each known host', () => {
    const urls = candidateUrls(
      { locationUrl: 'http://10.0.0.2/RECORDINGS/20261015-174553_2016948873-all.wav', filename: '20261015-174553_2016948873-all.wav' },
      ['http://10.0.0.1', 'http://10.0.0.2'],
    );
    expect(urls).toEqual([
      'http://10.0.0.2/RECORDINGS/MP3/20261015-174553_2016948873-all.mp3',
      'http://10.0.0.2/RECORDINGS/20261015-174553_2016948873-all.wav',
      'http://10.0.0.1/RECORDINGS/MP3/20261015-174553_2016948873-all.mp3',
      'http://10.0.0.1/RECORDINGS/20261015-174553_2016948873-all.wav',
    ]);
  });

  it('guesses every host when no URL is known yet, final MP3 before the live wav', () => {
    expect(candidateUrls({ locationUrl: null, filename: '20261015-164455_8652570707' }, ['http://a', 'http://b'])).toEqual([
      'http://a/RECORDINGS/MP3/20261015-164455_8652570707-all.mp3',
      'http://b/RECORDINGS/MP3/20261015-164455_8652570707-all.mp3',
      'http://a/RECORDINGS/20261015-164455_8652570707-all.wav',
      'http://b/RECORDINGS/20261015-164455_8652570707-all.wav',
    ]);
    expect(isFinalMp3('http://a/RECORDINGS/MP3/x-all.mp3')).toBe(true);
  });

  it('never guesses a path from a placeholder or numeric name', () => {
    expect(candidateUrls({ locationUrl: null, filename: 'pending-680777' }, ['http://a'])).toEqual([]);
    expect(candidateUrls({ locationUrl: '192', filename: '192' }, ['http://a'])).toEqual([]);
  });
});
