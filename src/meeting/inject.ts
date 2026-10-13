/**
 * 注入 Meet 頁面的瀏覽器端腳本（addInitScript，在任何頁面 JS 之前跑）。
 * 1. 包住 RTCPeerConnection，攔所有遠端 audio track → AudioContext 混音 → MediaRecorder(webm/opus)
 *    每秒把 chunk 經 window.__rec_chunk(base64) 丟回 Node。
 * 2. 覆寫 getUserMedia：給 Meet 一條靜音麥克風、拒絕攝影機（避免 fake device 的嗶聲外洩）。
 * 3. 觀察 DOM toast（「X 已加入」等）→ window.__rec_event。
 */
export const INJECT = String.raw`
(() => {
  const W = window;
  if (W.__rec_installed) return;
  W.__rec_installed = true;

  let ctx = null, dest = null, recorder = null, stopResolve = null, pending = Promise.resolve();
  const sources = new Map();
  const log = (...a) => { try { W.__rec_log && W.__rec_log(a.join(' ')); } catch {} };

  function ensureCtx() {
    if (ctx) return;
    ctx = new AudioContext({ sampleRate: 48000 });
    if (ctx.setSinkId) ctx.setSinkId({ type: 'none' }).catch(() => {});
    dest = ctx.createMediaStreamDestination();
    ctx.resume().catch(() => {});
  }

  function addRemoteTrack(track) {
    if (track.kind !== 'audio' || sources.has(track.id)) return;
    ensureCtx();
    const ms = new MediaStream([track]);
    // Chrome 怪癖：遠端 track 要掛在 <audio> 上 WebAudio 才拿得到資料
    const el = document.createElement('audio');
    el.srcObject = ms; el.volume = 0; el.muted = false; el.autoplay = true;
    el.play().catch(() => {});
    const src = ctx.createMediaStreamSource(ms);
    src.connect(dest);
    sources.set(track.id, { src, el });
    ctx.resume().catch(() => {});
    log('track+', track.id);
    track.addEventListener('ended', () => {
      const s = sources.get(track.id); if (!s) return;
      try { s.src.disconnect(); } catch {}
      s.el.srcObject = null; sources.delete(track.id);
      log('track-', track.id);
    });
  }

  const Orig = W.RTCPeerConnection;
  function Patched(...args) {
    const pc = new Orig(...args);
    pc.addEventListener('track', (e) => { try { addRemoteTrack(e.track); } catch (err) { log('track err', err.message); } });
    return pc;
  }
  Patched.prototype = Orig.prototype;
  Object.setPrototypeOf(Patched, Orig);
  W.RTCPeerConnection = Patched;
  W.webkitRTCPeerConnection = Patched;

  // 靜音麥克風 / 無攝影機
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) md.getUserMedia = async (c) => {
    if (c && c.video && !c.audio) throw new DOMException('no camera', 'NotFoundError');
    ensureCtx();
    const silent = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator(); const g = ctx.createGain(); g.gain.value = 0;
    osc.connect(g); g.connect(silent); osc.start();
    return silent.stream;
  };

  W.__rec_start = () => {
    ensureCtx();
    if (recorder) return 'already';
    recorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 96000 });
    recorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      const blob = e.data;
      // 串起來：確保順序，且 onstop 等最後一塊寫完才 resolve
      pending = pending.then(async () => {
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        try { await W.__rec_chunk(btoa(bin)); } catch (err) { log('chunk err', err.message); }
      });
    };
    recorder.onstop = () => { pending.then(() => { if (stopResolve) stopResolve(); }); };
    recorder.start(1000);
    log('recorder started, tracks=' + sources.size);
    return 'ok';
  };
  W.__rec_stop = () => new Promise((resolve) => {
    if (!recorder || recorder.state === 'inactive') return resolve();
    stopResolve = resolve;
    recorder.stop();
  });
  W.__rec_stats = () => ({ tracks: sources.size, state: recorder ? recorder.state : 'none', ctx: ctx ? ctx.state : 'none' });

  // toast 觀察：加入/離開
  const seen = new Set();
  const RE = /^(.{1,60}?)\s*(已加入|已離開|has joined|has left|joined|left)\b/;
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      const t = (n.textContent || '').trim();
      if (!t || t.length > 120 || seen.has(t)) continue;
      const mm = RE.exec(t);
      if (mm) { seen.add(t); setTimeout(() => seen.delete(t), 5000); try { W.__rec_event && W.__rec_event(mm[2], mm[1]); } catch {} }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
`;
