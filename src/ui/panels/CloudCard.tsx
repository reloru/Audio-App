import { useEffect, useRef, useState } from 'preact/hooks';
import type { CloudStage, EditorStore } from '../editorStore';
import { MAX_SECONDS, PITCH_MAX, PITCH_MIN, TEMPO_MAX, TEMPO_MIN, describeParams, validateParams, type StretchParams } from '../../cloud/params';
import { getKv, setKv } from '../../storage/db';
import type { CreatedProject } from '../importer';
import { Progress, Sheet, Slider, Toggle } from '../components/controls';
import { fmtTime } from '../format';
import { toast } from '../toast';

const STAGE_TEXT: Record<CloudStage, string> = {
  render: 'Preparing the song',
  upload: 'Uploading',
  process: 'Processing with Rubber Band',
  download: 'Downloading the result',
  import: 'Opening the result',
};

const CONSENT_KEY = 'cloudConsent';

export function CloudCard({ store, onOpen }: { store: EditorStore; onOpen: (c: CreatedProject) => void }) {
  const [params, setParams] = useState<StretchParams>({ tempo: 1, pitch: 0, formant: true });
  const [asking, setAsking] = useState(false);
  const p = store.project;
  const cloud = store.cloud;
  const grid = p.clips[0] ? p.grids[p.clips[0].sourceId] : undefined;
  const invalid = validateParams(params);
  const lengthSec = store.length / p.sampleRate;
  const tooLong = lengthSec > MAX_SECONDS;
  const busy = !!cloud && cloud.stage !== 'error';
  const set = (patch: Partial<StretchParams>) => setParams({ ...params, ...patch });

  const start = () => {
    void store.runCloudStretch(params, (created, clipped) => {
      onOpen(created);
      toast(clipped ? 'Opened the new version. Some peaks were clipped during processing; lower the level under Mix if you hear distortion.' : `Opened the new version (${describeParams(params)})`, clipped ? 'error' : 'info', 6000);
    });
  };
  const request = async () => {
    if (!navigator.onLine) return void toast('You are offline. Cloud processing needs a connection.', 'error');
    let remembered = false;
    try {
      remembered = (await getKv<boolean>(CONSENT_KEY)) === true;
    } catch {
      remembered = false;
    }
    if (remembered) start();
    else setAsking(true);
  };

  return (
    <div class="card stack">
      <h3>Tempo &amp; pitch (cloud)</h3>
      <p class="small dim" style={{ margin: 0 }}>
        Change the tempo without changing the pitch, or the key without changing the tempo. Runs Rubber Band on a server, so the song is uploaded; the
        result opens as a new project.
      </p>
      <Slider
        label="Tempo"
        value={params.tempo}
        min={TEMPO_MIN}
        max={TEMPO_MAX}
        step={0.01}
        reset={1}
        format={(v) => `${Math.round(v * 100)}%`}
        onInput={(v) => set({ tempo: v })}
        disabled={busy}
      />
      <Slider
        label="Pitch"
        value={params.pitch}
        min={PITCH_MIN}
        max={PITCH_MAX}
        step={1}
        reset={0}
        format={(v) => (v === 0 ? '0 st' : `${v > 0 ? '+' : '−'}${Math.abs(v)} st`)}
        onInput={(v) => set({ pitch: v })}
        disabled={busy}
      />
      <Toggle
        label="Keep vocal character"
        hint="Formant preservation when shifting pitch, so voices do not sound chipmunk-like or muffled."
        checked={params.formant}
        onChange={(formant) => set({ formant })}
      />
      <div class="small dim num">
        Length {fmtTime(store.sec(store.length) / params.tempo, 0)}
        {grid && grid.bpm > 0 && ` · ${(grid.bpm * p.speed * params.tempo).toFixed(1)} BPM`}
        {tooLong && ` · longer than the ${fmtTime(MAX_SECONDS, 0)} limit`}
      </div>
      {cloud ? (
        <CloudStatus store={store} />
      ) : (
        <button class="btn primary block" disabled={!!invalid || tooLong} onClick={() => void request()}>
          {invalid ?? 'Process in the cloud…'}
        </button>
      )}
      <p class="tiny faint" style={{ margin: 0 }}>
        Stems are mixed into one layer. EQ, width, speed, gain, fades and loudness settings are copied to the new project.
      </p>
      {asking && (
        <ConsentSheet
          bytesEstimate={Math.round(lengthSec * p.sampleRate * 4)}
          onCancel={() => setAsking(false)}
          onAccept={(remember) => {
            setAsking(false);
            if (remember) void setKv(CONSENT_KEY, true).catch(() => undefined);
            start();
          }}
        />
      )}
    </div>
  );
}

function CloudStatus({ store }: { store: EditorStore }) {
  const cloud = store.cloud!;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [cloud.stage]);
  if (cloud.stage === 'error') {
    return (
      <div class="stack" role="alert" ref={box}>
        <p class="small" style={{ margin: 0 }}>
          {cloud.error}
        </p>
        <button class="btn" onClick={() => store.dismissCloud()}>
          OK
        </button>
      </div>
    );
  }
  return (
    <div class="stack" aria-live="polite" ref={box}>
      <div class="small dim">{STAGE_TEXT[cloud.stage]}…</div>
      <Progress value={cloud.progress} />
      <button class="btn" onClick={() => store.cancelCloud()}>
        Cancel
      </button>
    </div>
  );
}

function ConsentSheet(props: { bytesEstimate: number; onCancel: () => void; onAccept: (remember: boolean) => void }) {
  const [remember, setRemember] = useState(false);
  return (
    <Sheet title="Upload this song for processing?" onClose={props.onCancel}>
      <ul class="small dim" style={{ margin: 0, paddingLeft: '18px' }}>
        <li>
          The arranged song is sent as a WAV file (about {Math.max(1, Math.round(props.bytesEstimate / 1e6))} MB) to Bounce’s server on Cloudflare. Tags, cover
          art and the rest of the project stay on this device.
        </li>
        <li>A container started for this job alone runs Rubber Band on it and sends the result back.</li>
        <li>
          The audio is deleted on the server once the result has downloaded, or when you cancel. If neither happens, the container stops about 5 minutes after
          the last request, and Cloudflare discards its disk when it stops.
        </li>
        <li>Your original project is not changed.</li>
      </ul>
      <div class="tiny faint">Source for the disk: Cloudflare Containers FAQ, “Is disk persistent?”</div>
      <Toggle label="Don’t ask again on this device" checked={remember} onChange={setRemember} />
      <div class="row">
        <button class="btn grow" onClick={props.onCancel}>
          Cancel
        </button>
        <button class="btn primary grow" onClick={() => props.onAccept(remember)}>
          Upload and process
        </button>
      </div>
    </Sheet>
  );
}
