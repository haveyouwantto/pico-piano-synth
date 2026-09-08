/*
 * PianoSynth - minimal ddsp-piano inspired synth built on PeriodicWave.
 *
 * Model: PIANO_NN v2 (midi + low/high bank -> 32 partial intensities at x*f0),
 * 8-bit quantised. The two banks cover up to 64 partials in total.
 * Envelope: decayTime + lowpass sweep (user formula):
 *   decayTime  = max(decay * 1.7 * 2^((60-pitch)/18), 0.5)
 *   filterStart/Target/Decay as in the pluck model, gain = setTargetAtTime.
 *
 * Usage:
 *   const synth = new PianoSynth(PIANO_NN, { audioContext });
 *   synth.ensure();            // after a user gesture
 *   synth.noteOn(60, 0.8);
 *   synth.noteOff(60);
 */

const ATTACK_SEC = 0.002;
const RELEASE_SEC = 0.3;

class PianoSynth {
  constructor(model, options = {}) {
    this.model = model;
    this.layers = null;

    this.ctx = options.audioContext || null;
    this._ownsContext = !this.ctx;
    this._disposed = false;
    this.master = null;
    this.output = null;
    this.compressor = null;
    this._autoConnect = options.autoConnect !== false;
    this._autoResume = options.autoResume !== false;

    this.dryGain = null;
    this.wetGain = null;
    this.convolver = null;
    this._reverbWet = 0.8;

    this._hammerNoiseBuffer = null;

    this.waveCache = new Map();
    this.envCache = new Map();
    this.active = new Map();
    this.sustain = false;
    this.sustained = new Set();
    this.decay = 1.0;               // base decay (s), used by the formula
    this._vol = 0.8;
    this.onNoteEnded = null;
    this._decodeModel();
  }

  static _parseBinary(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let off = 0;
    const magic = String.fromCharCode(...u8.subarray(0, 4));
    if (magic !== "DP8N") throw new Error("bad model magic: " + magic);
    off = 4;
    const version = u8[off++];
    if (version !== 1 && version !== 2) throw new Error("unsupported model version " + version);
    const nPartials = u8[off++];
    const nLayers = u8[off++];
    const inputDim = version >= 2 ? u8[off++] : 1;
    const mMin = dv.getFloat32(off, true); off += 4;
    const mSpan = dv.getFloat32(off, true); off += 4;
    let n;

    function readQ() {
      const scale = dv.getFloat32(off, true); off += 4;
      const zero = u8[off++];
      const q = u8.subarray(off, off + n);
      off += n;
      return { q, scale, zero };
    }

    const layers = [];
    for (let i = 0; i < nLayers; i++) {
      const wLen = dv.getUint16(off, true); off += 2;
      const bLen = dv.getUint16(off, true); off += 2;
      n = wLen; const w = readQ();
      n = bLen; const b = readQ();
      layers.push({ w, b });
    }
    return { n_partials: nPartials, input_dim: inputDim, m_min: mMin, m_span: mSpan, layers };
  }

  static _embeddedBuffer() {
    if (typeof PIANO_NN_B64 === "undefined") return null;
    const raw = atob(PIANO_NN_B64);
    const buf = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
    return buf;
  }

  static async load(url, options) {
    const opts = options || {};
    if (!url) {
      const buf = PianoSynth._embeddedBuffer();
      if (!buf) throw new Error("load() requires a model url when no embedded model is available");
      return PianoSynth.fromBinary(buf, opts);
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error("failed to load model from " + url + ": HTTP " + res.status);
    return PianoSynth.fromBinary(await res.arrayBuffer(), opts);
  }

  static fromBinary(buf, options) {
    return new PianoSynth(PianoSynth._parseBinary(buf), options);
  }

  _q8(obj) {
    const n = obj.q.length;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = (obj.q[i] - obj.zero) * obj.scale;
    return out;
  }

  _decodeModel() {
    this.layers = [];
    let prev = this.model.input_dim || 1;
    for (const raw of this.model.layers) {
      const wq = this._q8(raw.w);
      const bq = this._q8(raw.b);
      const rows = raw.w.q.length / prev;   // row-major, each row len=prev
      const w = [];
      for (let r = 0; r < rows; r++) {
        w.push(wq.subarray(r * prev, (r + 1) * prev));
      }
      this.layers.push({ w, b: bq });
      prev = rows;
    }
  }

  _midiHz(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  }

  _noteNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new TypeError("note must be a finite number, got: " + value);
    }
    return Math.max(0, Math.min(127, n));
  }

  midiToHz(note) {
    return this._midiHz(this._noteNumber(note));
  }

  hzToMidi(frequency) {
    if (!Number.isFinite(frequency) || frequency <= 0) {
      throw new TypeError("frequency must be a positive finite number, got: " + frequency);
    }
    return 69 + 12 * Math.log2(frequency / 440);
  }

  ensure() {
    if (this._disposed) throw new Error("PianoSynth has been disposed");
    if (this.ctx) {
      if (this.ctx.state === "closed") {
        throw new Error("AudioContext is closed");
      }
    } else {
      const AC = (typeof window !== "undefined" &&
        (window.AudioContext || window.webkitAudioContext)) ||
        (typeof AudioContext !== "undefined" ? AudioContext : null);
      if (!AC) throw new Error("Web Audio API is not available in this environment");
      this.ctx = new AC();
      this._ownsContext = true;
    }

    if (!this.master) {
      this.master = this.ctx.createGain();
      this.master.gain.value = this._vol;

      this.compressor = this.ctx.createDynamicsCompressor();
      this.output = this.ctx.createGain();
      this.master.connect(this.compressor);
      this.compressor.connect(this.output);
      if (this._autoConnect) this.output.connect(this.ctx.destination);

      this.dryGain = this.ctx.createGain();
      this.wetGain = this.ctx.createGain();
      this.convolver = this.ctx.createConvolver();

      this.setReverb(this._reverbWet);

      this.dryGain.connect(this.master);
      this.convolver.connect(this.wetGain);
      this.wetGain.connect(this.master);

      this._hammerNoiseBuffer = null;
      this._buildDefaultIR();
    }
    if (this._autoResume && this.ctx.state === "suspended") this.ctx.resume();
  }

  connect(destination) {
    this.ensure();
    if (!destination) {
      throw new TypeError("connect() expects an AudioNode or AudioParam destination");
    }
    if (this._autoConnect) {
      this.output.disconnect(this.ctx.destination); // 避免双路输出
      this._autoConnect = false;
    }
    this.output.connect(destination);
  }

  disconnect(destination) {
    if (!this.output) return;
    if (destination) this.output.disconnect(destination);
    else this.output.disconnect();
    if (!destination) this._autoConnect = false;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.sustain = false;
    this.sustained.clear();
    if (this.ctx && this.ctx.state !== "closed") {
      for (const m of [...this.active.keys()]) this._release(m);
      for (const node of [this.master, this.compressor, this.output,
        this.dryGain, this.wetGain, this.convolver]) {
        if (node) node.disconnect();
      }
      if (this._ownsContext) this.ctx.close();
    }
    this.active.clear();
    this.waveCache.clear();
    this.envCache.clear();
    this._hammerNoiseBuffer = null;
    this.master = null;
    this.compressor = null;
    this.output = null;
    this.dryGain = null;
    this.wetGain = null;
    this.convolver = null;
    this.ctx = null;
  }

  // 算法合成琴房模拟冲激响应 (IR)
  _buildDefaultIR(durationSeconds = 1.6, decay = 50.0) {
    if (!this.ctx) return;
    const rand = this._createPrng(411); // 固定 IR 采样种子
    const sampleRate = this.ctx.sampleRate;
    const length = Math.floor(sampleRate * durationSeconds);
    const buffer = this.ctx.createBuffer(2, length, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    for (let i = 0; i < length; i++) {
      const t = i / length;
      const env = Math.exp(-t * decay);
      left[i] = (rand() * 2 - 1) * env;
      right[i] = (rand() * 2 - 1) * env;
    }

    // 模拟木质琴箱的高频吸收
    for (let c = 0; c < 2; c++) {
      const channel = buffer.getChannelData(c);
      let last = 0;
      for (let i = 0; i < length; i++) {
        channel[i] = last + 0.22 * (channel[i] - last);
        last = channel[i];
      }
    }

    this.convolver.buffer = buffer;
  }

  _getHammerNoiseBuffer() {
    if (this._hammerNoiseBuffer) return this._hammerNoiseBuffer;

    const rand = this._createPrng(42); // 固定 Hammer 噪声种子
    const duration = 0.08;          // 足够长，后面用 gain 截断
    const sampleRate = this.ctx.sampleRate;
    const length = Math.floor(sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    // 白噪声 + 轻微粉红噪声倾向（更接近真实击弦）
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = rand() * 2 - 1;
      data[i] = (last + 0.02 * white) / 1.02;
      last = data[i];
    }
    this._hammerNoiseBuffer = buffer;
    return buffer;
  }

  async loadIR(url) {
    this.ensure();
    const res = await fetch(url);
    const arrayBuffer = await res.arrayBuffer();
    this.convolver.buffer = await this.ctx.decodeAudioData(arrayBuffer);
  }

  // Mulberry32 确定性伪随机数生成器 (返回 0 到 1 之间的浮点数)
  _createPrng(seed = 123456789) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), s | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  setReverb(wetRatio) {
    this._reverbWet = Math.max(0, Math.min(1, wetRatio));
    if (this.dryGain && this.wetGain) {
      this.dryGain.gain.value = Math.cos(this._reverbWet * Math.PI * 0.5);
      this.wetGain.gain.value = Math.sin(this._reverbWet * Math.PI * 0.5);
    }
  }

  setVolume(v) {
    this._vol = v;
    if (this.master) this.master.gain.value = v;
  }

  _forward(m, bank = 0) {
    const key = m + ":" + bank;
    if (this.envCache.has(key)) return this.envCache.get(key);
    let a = this.model.input_dim === 2
      ? Float32Array.of((m - this.model.m_min) / this.model.m_span, bank)
      : Float32Array.of((m - this.model.m_min) / this.model.m_span);
    for (let li = 0; li < this.layers.length; li++) {
      const L = this.layers[li];
      const last = li === this.layers.length - 1;
      const out = new Float32Array(L.w.length);
      for (let j = 0; j < L.w.length; j++) {
        const row = L.w[j];
        let z = L.b[j];
        for (let i = 0; i < a.length; i++) z += row[i] * a[i];
        out[j] = last ? z : Math.tanh(z);
      }
      a = out;
    }
    this.envCache.set(key, a);
    return a;
  }

  _maxPartial(m) {
    return Math.max(1, Math.min(this.model.n_partials,
      Math.floor(0.98 * 12000 / this._midiHz(m))));
  }

  _buildWave(m) {
    if (this.waveCache.has(m)) return this.waveCache.get(m);
    const N = this._maxPartial(m);
    const real = new Float32Array(N + 1);
    const imag = new Float32Array(N + 1);
    const bankSize = this.model.input_dim === 2 ? 32 : this.model.n_partials;
    const banks = new Map();
    for (let h = 1; h <= N; h++) {
      const bank = Math.floor((h - 1) / bankSize);
      if (!banks.has(bank)) banks.set(bank, this._forward(m, bank));
      const env = banks.get(bank);
      const db = (h - 1) % bankSize < env.length ? env[(h - 1) % bankSize] : -200;
      imag[h] = Math.pow(10, db / 20);
    }
    const wave = this.ctx.createPeriodicWave(real, imag);
    this.waveCache.set(m, wave);
    return wave;
  }

  noteOn(midi, velocity = 1, options = {}) {
    this.ensure();
    const m = this._noteNumber(midi);
    const vel = Number.isFinite(velocity) ? Math.max(0, Math.min(1, velocity)) : 1;
    this.sustained.delete(m);
    if (this.active.has(m)) this._release(m);

    const ctxNow = this.ctx.currentTime;
    const startAt = Number.isFinite(options.when) && options.when >= ctxNow
      ? options.when : ctxNow + 0.05;   // slight delay to avoid clicks
    const duration = Number.isFinite(options.duration) ? Math.max(0, options.duration) : null;
    const detune = Number.isFinite(options.detune) ? options.detune : 0;
    const noteHz = this._midiHz(m);
    const baseHz = Number.isFinite(options.frequency) && options.frequency > 0
      ? options.frequency : noteHz;
    const oscFreq = baseHz * Math.pow(2, detune / 1200);
    const peak = (vel ** 2) * 0.5;

    const decayTime = Math.max(this.decay * 1.7 * Math.pow(2, (60 - m) / 18), 0.5);
    const cutoffFreq = 492.35 * Math.exp(2.5 * vel);
    const nyquist = this.ctx.sampleRate / 2;
    const filterStart = Math.min(cutoffFreq, nyquist);
    const filterTarget = Math.min(cutoffFreq * 0.1, nyquist);
    const filterDecay = decayTime / 3;
    const attack = ATTACK_SEC;
    const rel = RELEASE_SEC;

    const osc = this.ctx.createOscillator();
    osc.frequency.value = oscFreq;
    osc.setPeriodicWave(this._buildWave(m));

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = -1;  // Q < 0 means "no resonance" in WebAudio
    const g = this.ctx.createGain();

    g.gain.setValueAtTime(0.0001, startAt);
    g.gain.setTargetAtTime(peak, startAt, attack / 3);
    if (duration !== null) {
      g.gain.setTargetAtTime(0.0001, startAt + duration, rel / 3);
    } else {
      g.gain.setTargetAtTime(0, startAt + attack, decayTime / 2);
    }
    const endStop = duration !== null
      ? startAt + duration + rel + 0.15
      : startAt + attack + Math.max(decayTime * 4, 3.0);

    filter.frequency.setValueAtTime(filterStart, startAt);
    filter.frequency.setTargetAtTime(filterTarget, startAt + attack, filterDecay);

    osc.connect(filter);
    filter.connect(g);

    g.connect(this.dryGain);
    g.connect(this.convolver);

    osc.start(startAt);
    osc.stop(endStop);

    // ========== Hammer 噪声层 ==========
    const noiseBuf = this._getHammerNoiseBuffer();
    const noiseSrc = this.ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;

    const noiseFilter = this.ctx.createBiquadFilter();
    // 低音更闷一点，高音更亮
    noiseFilter.frequency.value = baseHz + 500;

    const noiseGain = this.ctx.createGain();
    // 力度用二次曲线，更接近真实击弦动态
    const hammerLevel = Math.pow(vel, 2) * 3;

    // 极快的起音 + 快速衰减（15~40ms）
    const hammerDur = 0.016 + vel * 0.028;
    noiseGain.gain.setValueAtTime(0, startAt);
    noiseGain.gain.linearRampToValueAtTime(hammerLevel, startAt + 0.0012);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, startAt + hammerDur);

    noiseSrc.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.dryGain);
    noiseGain.connect(this.convolver);   // 也送进 IR，空间感一致

    noiseSrc.start(startAt);
    noiseSrc.stop(startAt + hammerDur + 0.02);

    const voice = {
      osc,
      gain: g,
      note: m,
      velocity: vel,
      startAt,
      decayTime,
      peak,
      duration,
      stopped: false,
      ended: false,
      onEnded: typeof options.onEnded === "function" ? options.onEnded : null
    };
    osc.onended = () => this._finishVoice(m, voice);
    this.active.set(m, voice);
    return m;
  }

  noteOnHz(frequency, velocity = 1, options = {}) {
    const m = this.hzToMidi(frequency);
    return this.noteOn(m, velocity, Object.assign({}, options, { frequency }));
  }

  noteOffHz(frequency) {
    return this.noteOff(this.hzToMidi(frequency));
  }

  noteOff(midi) {
    const m = this._noteNumber(midi);
    if (this.sustain && this.active.has(m)) {
      this.sustained.add(m);          // pedal down: keep the note ringing
      return;
    }
    this._release(m);
  }

  _release(midi) {
    const m = this._noteNumber(midi);
    const voice = this.active.get(m);
    if (!voice || voice.stopped || voice.ended) return;
    voice.stopped = true;
    const now = this.ctx.currentTime;
    const level = Math.max(this._gainAt(voice, now), 0.0001);
    voice.gain.gain.cancelScheduledValues(now);
    if (voice.gain.gain.value === 1) voice.gain.gain.setValueAtTime(0, now);
    voice.gain.gain.linearRampToValueAtTime(level, now + ATTACK_SEC);
    voice.gain.gain.setTargetAtTime(0.0001, now + ATTACK_SEC, RELEASE_SEC / 3);
    this._finishVoice(m, voice);
  }

  // 计算 noteOn() 之后 gain 包络在 t 时刻的值。attack 极短,直接按 peak 计。
  _gainAt(voice, t) {
    const startAt = voice.startAt;
    if (t < startAt) return voice.peak;
    if (voice.duration === null) {
      const decayStart = startAt + ATTACK_SEC;
      if (t < decayStart) return voice.peak;
      return voice.peak * Math.exp(-(t - decayStart) / (voice.decayTime / 2));
    }
    const releaseStart = startAt + voice.duration;
    if (t < releaseStart) return voice.peak;
    return 0.0001 + (voice.peak - 0.0001) * Math.exp(-(t - releaseStart) / (RELEASE_SEC / 3));
  }

  _finishVoice(m, voice) {
    if (voice.ended) return;
    voice.ended = true;
    if (this.active.get(m) === voice) this.active.delete(m);
    if (voice.onEnded) {
      voice.onEnded(m, voice.velocity);
      voice.onEnded = null;
    }
    if (typeof this.onNoteEnded === "function") {
      this.onNoteEnded(m, voice.velocity);
    }
  }

  setSustain(down) {
    down = !!down;
    if (!down && this.sustain) {
      for (const m of [...this.sustained]) this._release(m);
      this.sustained.clear();
    }
    this.sustain = down;
  }

  allNotesOff() {
    for (const m of [...this.active.keys()]) this._release(m);
    this.sustained.clear();
  }
}

if (typeof window !== "undefined") window.PianoSynth = PianoSynth;
if (typeof module !== "undefined") module.exports = PianoSynth;
