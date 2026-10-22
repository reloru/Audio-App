import { useEffect, useRef } from 'preact/hooks';
import { peakRange } from '../dsp/analysis';
import { fadeGain } from '../dsp/fades';
import { activeLayers } from '../engine/render';
import { clipStarts, seamExtent, isContiguous } from '../model/timeline';
import type { EditorStore } from './editorStore';
import { fmtTime } from './format';

interface Colors {
  wave: string;
  waveDim: string;
  select: string;
  selectEdge: string;
  playhead: string;
  gridBar: string;
  gridBeat: string;
  seam: string;
  fade: string;
  text: string;
  surface: string;
}

function readColors(el: Element): Colors {
  const cs = getComputedStyle(el);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    wave: v('--wave'),
    waveDim: v('--wave-dim'),
    select: v('--select'),
    selectEdge: v('--select-edge'),
    playhead: v('--playhead'),
    gridBar: v('--grid-bar'),
    gridBeat: v('--grid-beat'),
    seam: v('--seam'),
    fade: v('--fade'),
    text: v('--text-faint'),
    surface: v('--surface'),
  };
}

const RULER = 18;
const HANDLE_HIT = 26;

/** Combined min/max of all audible layers over timeline frames [t0, t1). */
export function makeColumnPeak(store: EditorStore) {
  const p = store.project;
  const starts = clipStarts(p.clips);
  const sources = new Map(p.sources.map((s) => [s.id, s]));
  const layerSets = p.clips.map((c) => {
    const src = sources.get(c.sourceId);
    return src ? activeLayers(src).map((a) => ({ peaks: store.layers.get(a.layer.id)?.peaks, g: Math.max(a.gl, a.gr) })) : [];
  });
  let ci = 0;
  return (t0: number, t1: number): [number, number] => {
    while (ci > 0 && starts[ci] > t0) ci--;
    let lo = 0,
      hi = 0;
    for (let i = ci; i < p.clips.length; i++) {
      const T = starts[i];
      const c = p.clips[i];
      const n = c.end - c.start;
      if (T >= t1) break;
      if (T + n <= t0) {
        ci = i + 1;
        continue;
      }
      const a = c.start + Math.max(0, t0 - T);
      const b = c.start + Math.min(n, t1 - T);
      let l = 0,
        h = 0;
      for (const { peaks, g } of layerSets[i]) {
        if (!peaks) continue;
        const [pl, ph] = peakRange(peaks, a, Math.max(a + 1, b));
        l += pl * g;
        h += ph * g;
      }
      if (l < lo) lo = l;
      if (h > hi) hi = h;
    }
    return [Math.max(-1, lo), Math.min(1, hi)];
  };
}

function niceStep(secPerPx: number): number {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  for (const s of steps) if (s / secPerPx >= 64) return s;
  return 600;
}

export function Waveform({ store }: { store: EditorStore }) {
  const wrap = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const colors = useRef<Colors | null>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });

  const drawBase = () => {
    const cv = base.current;
    if (!cv || !size.current.w) return;
    const { w, h, dpr } = size.current;
    const ctx = cv.getContext('2d')!;
    const c = (colors.current ??= readColors(cv));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { start, fpp } = store.view;
    const len = store.length;
    const p = store.project;
    const toX = (t: number) => (t - start) / fpp;
    const top = RULER;
    const bottom = h - 4;
    const mid = (top + bottom) / 2;
    const amp = ((bottom - top) / 2) * 0.96;

    // beat grid
    const beats = store.beats();
    if (beats.length > 1) {
      const spacingPx = (beats[1].t - beats[0].t) / fpp;
      for (const b of beats) {
        const x = toX(b.t);
        if (x < -1 || x > w + 1) continue;
        if (!b.bar && spacingPx < 7) continue;
        if (b.bar && spacingPx * 4 < 6) continue;
        ctx.fillStyle = b.bar ? c.gridBar : c.gridBeat;
        ctx.fillRect(Math.round(x), top, 1, bottom - top);
      }
    }

    // ruler
    ctx.fillStyle = c.text;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const secPerPx = store.sec(fpp);
    const step = niceStep(secPerPx);
    const firstSec = Math.ceil(store.sec(start) / step) * step;
    for (let s = firstSec; ; s += step) {
      const t = s * store.sr * p.speed;
      const x = toX(t);
      if (x > w) break;
      ctx.fillRect(Math.round(x), 0, 1, 5);
      ctx.fillText(fmtTime(s, step < 1 ? 1 : 0), Math.round(x) + 3, 10);
    }

    // waveform
    const sel = store.selection;
    const peak = makeColumnPeak(store);
    const endX = Math.min(w, toX(len));
    for (let x = 0; x < endX; x++) {
      const t0 = start + x * fpp;
      const [lo, hi] = peak(t0, t0 + Math.max(1, fpp));
      const inSel = sel && t0 >= sel.start && t0 < sel.end;
      ctx.fillStyle = sel && !inSel ? c.waveDim : c.wave;
      const y0 = mid - hi * amp;
      const y1 = mid - lo * amp;
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }

    // output fades (relative to the export range)
    const R = store.project.exportSettings.range === 'selection' && sel ? sel : { start: 0, end: len };
    const perSec = store.sr * p.speed;
    const drawFade = (a: number, b: number, fadeIn: boolean, curve: typeof p.fadeIn.curve) => {
      if (b <= a) return;
      ctx.fillStyle = c.fade;
      ctx.beginPath();
      ctx.moveTo(toX(a), top);
      const N = 48;
      for (let k = 0; k <= N; k++) {
        const u = k / N;
        const g = fadeGain(curve, fadeIn ? u : 1 - u);
        ctx.lineTo(toX(a + (b - a) * u), top + (1 - g) * (bottom - top));
      }
      ctx.lineTo(toX(b), top);
      ctx.closePath();
      ctx.fill();
    };
    drawFade(R.start, R.start + Math.min(R.end - R.start, p.fadeIn.seconds * perSec), true, p.fadeIn.curve);
    drawFade(R.end - Math.min(R.end - R.start, p.fadeOut.seconds * perSec), R.end, false, p.fadeOut.curve);

    // clip seams
    const starts = clipStarts(p.clips);
    const srcMap = new Map(p.sources.map((s) => [s.id, s]));
    for (let i = 1; i < p.clips.length; i++) {
      if (isContiguous(p.clips[i - 1], p.clips[i])) continue;
      const x = toX(starts[i]);
      if (x < -20 || x > w + 20) continue;
      const ext = seamExtent(p.clips, srcMap, i);
      const selected = store.selectedSeam === i;
      ctx.fillStyle = c.seam;
      ctx.globalAlpha = selected ? 0.35 : 0.18;
      const xa = toX(starts[i] - ext.pre);
      const xb = toX(starts[i] + ext.post);
      if (xb - xa >= 1) ctx.fillRect(xa, top, xb - xa, bottom - top);
      ctx.globalAlpha = 1;
      ctx.fillRect(Math.round(x), top, selected ? 2 : 1, bottom - top);
      ctx.beginPath();
      ctx.moveTo(x - 6, top);
      ctx.lineTo(x + 6, top);
      ctx.lineTo(x, top + 8);
      ctx.closePath();
      ctx.fill();
    }

    // selection
    if (sel) {
      const xa = toX(sel.start);
      const xb = toX(sel.end);
      ctx.fillStyle = c.select;
      ctx.fillRect(xa, top, xb - xa, bottom - top);
      ctx.fillStyle = c.selectEdge;
      ctx.fillRect(Math.round(xa) - 1, top, 2, bottom - top);
      ctx.fillRect(Math.round(xb) - 1, top, 2, bottom - top);
      for (const x of [xa, xb]) {
        ctx.beginPath();
        ctx.roundRect(x - 9, bottom - 30, 18, 26, 6);
        ctx.fill();
        ctx.fillStyle = c.surface;
        ctx.fillRect(x - 3, bottom - 22, 1.5, 10);
        ctx.fillRect(x + 1.5, bottom - 22, 1.5, 10);
        ctx.fillStyle = c.selectEdge;
      }
    }
    // end of song
    if (endX < w) {
      ctx.fillStyle = c.gridBar;
      ctx.fillRect(Math.round(endX), top, 1, bottom - top);
    }
  };

  const drawOverlay = () => {
    const cv = over.current;
    if (!cv || !size.current.w) return;
    const { w, h, dpr } = size.current;
    const ctx = cv.getContext('2d')!;
    const c = (colors.current ??= readColors(cv));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const x = (store.currentPosition() - store.view.start) / store.view.fpp;
    if (x < -2 || x > w + 2) return;
    ctx.fillStyle = c.playhead;
    ctx.fillRect(Math.round(x) - 1, 0, 2, h);
    ctx.beginPath();
    ctx.moveTo(x - 6, 0);
    ctx.lineTo(x + 6, 0);
    ctx.lineTo(x, 8);
    ctx.closePath();
    ctx.fill();
  };

  // sizing
  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      size.current = { w: r.width, h: r.height, dpr };
      for (const cv of [base.current!, over.current!]) {
        cv.width = Math.round(r.width * dpr);
        cv.height = Math.round(r.height * dpr);
      }
      const first = store.viewWidth === 360 && r.width !== 360;
      store.viewWidth = r.width;
      if (first || store.view.fpp > store.maxFpp()) store.fit();
      drawBase();
      drawOverlay();
    });
    ro.observe(el);
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onScheme = () => {
      colors.current = null;
      drawBase();
      drawOverlay();
    };
    mq.addEventListener('change', onScheme);
    return () => {
      ro.disconnect();
      mq.removeEventListener('change', onScheme);
    };
  }, [store]);

  // redraw on state changes; follow the playhead while playing
  useEffect(() => {
    const unsub = store.subscribe(() => {
      drawBase();
      drawOverlay();
    });
    const unframe = store.onFrame(() => {
      if (store.follow(store.player.position())) drawBase();
      drawOverlay();
    });
    return () => {
      unsub();
      unframe();
    };
  }, [store]);

  // gestures
  useEffect(() => {
    const el = wrap.current!;
    const pointers = new Map<number, { x: number; y: number }>();
    type Mode = 'none' | 'pending' | 'select' | 'handleStart' | 'handleEnd' | 'pinch' | 'pan';
    let mode: Mode = 'none';
    let downX = 0;
    let anchor = 0;
    let pinch = { d0: 1, fpp0: 1, frame: 0 };
    let lastTap = { t: 0, x: 0 };
    let raf = 0;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const xToFrame = (x: number) => Math.max(0, Math.min(store.length, store.view.start + x * store.view.fpp));
    const frameToX = (t: number) => (t - store.view.start) / store.view.fpp;
    const redraw = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        store.emit();
      });
    };
    const autoScroll = (x: number) => {
      const w = size.current.w;
      const edge = 28;
      if (x < edge) store.view.start = store.clampStart(store.view.start - (edge - x) * store.view.fpp * 0.5);
      else if (x > w - edge) store.view.start = store.clampStart(store.view.start + (x - (w - edge)) * store.view.fpp * 0.5);
    };
    const pinchInfo = () => {
      const [a, b] = [...pointers.values()];
      return { d: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), cx: (a.x + b.x) / 2 };
    };

    const onDown = (e: PointerEvent) => {
      if (e.button > 0) return;
      el.setPointerCapture(e.pointerId);
      const pos = local(e);
      pointers.set(e.pointerId, pos);
      if (pointers.size === 2) {
        const { d, cx } = pinchInfo();
        pinch = { d0: d, fpp0: store.view.fpp, frame: store.view.start + cx * store.view.fpp };
        mode = 'pinch';
        return;
      }
      if (pointers.size > 2) return;
      downX = pos.x;
      const sel = store.selection;
      if (sel) {
        const ds = Math.abs(pos.x - frameToX(sel.start));
        const de = Math.abs(pos.x - frameToX(sel.end));
        if (Math.min(ds, de) < HANDLE_HIT) {
          mode = ds <= de ? 'handleStart' : 'handleEnd';
          return;
        }
      }
      mode = e.pointerType === 'mouse' && e.shiftKey ? 'pan' : 'pending';
    };

    const onMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const pos = local(e);
      const prev = pointers.get(e.pointerId)!;
      pointers.set(e.pointerId, pos);
      if (mode === 'pinch' && pointers.size === 2) {
        const { d, cx } = pinchInfo();
        const fpp = Math.max(store.minFpp(), Math.min(store.maxFpp(), (pinch.fpp0 * pinch.d0) / d));
        store.view = { fpp, start: store.clampStart(pinch.frame - cx * fpp, fpp) };
        redraw();
        return;
      }
      if (mode === 'pan') {
        store.view.start = store.clampStart(store.view.start - (pos.x - prev.x) * store.view.fpp);
        redraw();
        return;
      }
      if (mode === 'pending' && Math.abs(pos.x - downX) > 8) {
        mode = 'select';
        anchor = store.snapFrame(xToFrame(downX));
      }
      if (mode === 'select') {
        autoScroll(pos.x);
        const cur = store.snapFrame(xToFrame(pos.x));
        store.selection = { start: Math.min(anchor, cur), end: Math.max(anchor, cur) };
        store.selectedSeam = null;
        redraw();
      } else if (mode === 'handleStart' || mode === 'handleEnd') {
        autoScroll(pos.x);
        const sel = store.selection!;
        const cur = store.snapFrame(xToFrame(pos.x));
        let s = mode === 'handleStart' ? cur : sel.start;
        let en = mode === 'handleEnd' ? cur : sel.end;
        if (s > en) {
          [s, en] = [en, s];
          mode = mode === 'handleStart' ? 'handleEnd' : 'handleStart';
        }
        store.selection = { start: s, end: en };
        redraw();
      }
    };

    const onUp = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const pos = local(e);
      pointers.delete(e.pointerId);
      if (mode === 'pinch') {
        if (pointers.size === 0) mode = 'none';
        return;
      }
      if (mode === 'pending') {
        const t = xToFrame(pos.x);
        const now = performance.now();
        const dbl = now - lastTap.t < 320 && Math.abs(pos.x - lastTap.x) < 24;
        lastTap = { t: now, x: pos.x };
        // seam marker?
        const p = store.project;
        const starts = clipStarts(p.clips);
        let seam: number | null = null;
        if (pos.y < RULER + 24) {
          for (let i = 1; i < p.clips.length; i++) {
            if (!isContiguous(p.clips[i - 1], p.clips[i]) && Math.abs(frameToX(starts[i]) - pos.x) < 16) seam = i;
          }
        }
        if (seam !== null) {
          store.set({ selectedSeam: seam, tab: 'edit' });
        } else if (dbl) {
          selectBarAt(store, t);
        } else {
          const sel = store.selection;
          if (sel && (t < sel.start || t > sel.end)) store.selection = null;
          store.selectedSeam = null;
          store.setPlayhead(store.snapFrame(t));
          store.syncPlayer();
        }
      } else if (mode === 'select' || mode === 'handleStart' || mode === 'handleEnd') {
        const sel = store.selection;
        if (sel && sel.end - sel.start < store.sr * 0.01) store.selection = null;
        store.set({ selection: store.selection });
      }
      mode = 'none';
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x } = local(e);
      if (e.ctrlKey || e.metaKey) store.zoomAt(Math.exp(-e.deltaY * 0.01), x);
      else store.scrollTo(store.view.start + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * store.view.fpp);
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [store]);

  return (
    <div class="wave-wrap" ref={wrap} role="application" aria-label="Waveform. Drag to select, tap to move the playhead, pinch to zoom.">
      <canvas ref={base} />
      <canvas ref={over} />
      {!store.selection && store.length > 0 && <div class="wave-hint">Drag to select · tap to place playhead · pinch to zoom</div>}
    </div>
  );
}

/** Selects the bar containing t (or 2 s around it without a beat grid). */
export function selectBarAt(store: EditorStore, t: number): void {
  const bars = store.beats().filter((b) => b.bar);
  let s = Math.max(0, t - store.sr);
  let e = Math.min(store.length, t + store.sr);
  if (bars.length > 1) {
    let i = bars.findIndex((b) => b.t > t);
    if (i === -1) i = bars.length;
    s = i > 0 ? bars[i - 1].t : 0;
    e = i < bars.length ? bars[i].t : store.length;
  }
  store.set({ selection: { start: s, end: e }, selectedSeam: null });
}

export function Overview({ store }: { store: EditorStore }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });

  const draw = () => {
    const c = cv.current;
    if (!c || !size.current.w) return;
    const { w, h, dpr } = size.current;
    const ctx = c.getContext('2d')!;
    const cs = getComputedStyle(c);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const len = Math.max(1, store.length);
    const fpp = len / w;
    const peak = makeColumnPeak(store);
    ctx.fillStyle = cs.getPropertyValue('--wave-dim').trim();
    for (let x = 0; x < w; x++) {
      const [lo, hi] = peak(x * fpp, (x + 1) * fpp);
      const y0 = h / 2 - hi * (h / 2 - 3);
      const y1 = h / 2 - lo * (h / 2 - 3);
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
    const sel = store.selection;
    if (sel) {
      ctx.fillStyle = cs.getPropertyValue('--select').trim();
      ctx.fillRect(sel.start / fpp, 0, (sel.end - sel.start) / fpp, h);
    }
    const vs = store.view.start / fpp;
    const vw = Math.max(4, (store.viewWidth * store.view.fpp) / fpp);
    ctx.strokeStyle = cs.getPropertyValue('--text-dim').trim();
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vs + 0.75, 0.75, Math.min(w - vs, vw) - 1.5, h - 1.5);
    ctx.fillStyle = cs.getPropertyValue('--playhead').trim();
    ctx.fillRect(store.currentPosition() / fpp - 0.5, 0, 1.5, h);
  };

  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      size.current = { w: r.width, h: r.height, dpr };
      cv.current!.width = Math.round(r.width * dpr);
      cv.current!.height = Math.round(r.height * dpr);
      draw();
    });
    ro.observe(el);
    const unsub = store.subscribe(draw);
    const unframe = store.onFrame(draw);
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const frame = ((e.clientX - r.left) / r.width) * store.length;
      store.scrollTo(frame - (store.viewWidth * store.view.fpp) / 2);
    };
    let down = false;
    const onDown = (e: PointerEvent) => {
      down = true;
      el.setPointerCapture(e.pointerId);
      move(e);
    };
    const onMove = (e: PointerEvent) => down && move(e);
    const onUp = () => (down = false);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    return () => {
      ro.disconnect();
      unsub();
      unframe();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
  }, [store]);

  return (
    <div class="overview" ref={wrap} aria-label="Song overview: drag to scroll">
      <canvas ref={cv} />
    </div>
  );
}
