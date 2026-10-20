import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWav } from '../src/io/wav';
import { musicLike, silence, concat, sine } from '../tests/helpers';

export const FIXTURES = join(process.cwd(), 'e2e', '.fixtures');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

/** Creates test songs: a tagged MP3 with silence at both ends, and two stems. */
export function makeFixtures(): { mp3: string; wav: string; stems: string[] } {
  mkdirSync(FIXTURES, { recursive: true });
  const fs = 48000;
  const wav = join(FIXTURES, 'Neon Rain.wav');
  const mp3 = join(FIXTURES, 'Neon Rain.mp3');
  const cover = join(FIXTURES, 'cover.png');
  if (!existsSync(mp3)) {
    const song = concat(silence(fs, 0.8), musicLike(fs, 20, 120, 3, 0.25), silence(fs, 2));
    writeFileSync(wav, encodeWav(fs, song, 'pcm16'));
    writeFileSync(cover, PNG);
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', '-i', wav, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-b:a', '192k', '-c:v', 'copy',
      '-id3v2_version', '3', '-metadata', 'title=Neon Rain', '-metadata', 'artist=Test Artist', '-metadata:s:v', 'comment=Cover (front)', mp3,
    ]);
  }
  const stems = [join(FIXTURES, 'Neon Rain (Vocals).wav'), join(FIXTURES, 'Neon Rain (Instrumental).wav')];
  if (!existsSync(stems[0])) {
    const n = 12;
    const vocal = concat(silence(fs, 1), sine(fs, n - 1, 440, -18));
    writeFileSync(stems[0], encodeWav(fs, vocal, 'pcm16'));
    writeFileSync(stems[1], encodeWav(fs, musicLike(fs, n, 120, 4, 0.2), 'pcm16'));
  }
  return { mp3, wav, stems };
}
