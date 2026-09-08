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
const CYCLE_SAMPLES = 2048;
const WAVE_CACHE_MAX = 128;

function fftInverse(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angleStep = (2 * Math.PI) / size;
    for (let i = 0; i < n; i += size) {
      for (let j = i, k = 0; j < i + half; j++, k++) {
        const angle = angleStep * k;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        const tr = wr * re[j + half] - wi * im[j + half];
        const ti = wr * im[j + half] + wi * re[j + half];
        re[j + half] = re[j] - tr;
        im[j + half] = im[j] - ti;
        re[j] += tr;
        im[j] += ti;
      }
    }
  }
  for (let i = 0; i < n; i++) re[i] /= n;
}

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
    this.playing = new Set();
    this.sustain = false;
    this.sustained = new Set();
    this.decay = 1.0;
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
      // 权重按行主序导出,故行数 = 权重数 / 输入维数
      const rows = raw.w.q.length / prev;
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
    this.playing.clear();
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

  // 未加载外部 IR 时也能保留房间混响
  _buildDefaultIR(durationSeconds = 1.6, decay = 50.0) {
    if (!this.ctx) return;
    const rand = this._createPrng(411); // 固定种子,每次结果一致
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

    const rand = this._createPrng(42);  // 固定种子,每次结果一致
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

  // 只读观测快照:运行状态与资源占用
  get metrics() {
    let scheduledReleases = 0;
    for (const voice of this.active.values()) {
      if (voice.releaseAt !== null) scheduledReleases++;
    }
    const ctx = this.ctx;
    return {
      time: ctx ? ctx.currentTime : 0,
      state: ctx ? ctx.state : "none",
      sampleRate: ctx ? ctx.sampleRate : 0,
      polyphony: this.playing.size,
      sustained: this.sustained.size,
      scheduledReleases,
      waveCache: this.waveCache.size,
      envCache: this.envCache.size,
      volume: this._vol,
      reverb: this._reverbWet
    };
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
    if (this.waveCache.has(m)) {
      const hit = this.waveCache.get(m);
      this.waveCache.delete(m);
      this.waveCache.set(m, hit);
      return hit;
    }
    const N = this._maxPartial(m);
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

    // 谐波频谱直接 IFFT 成时域,避免逐采样叠加
    const len = CYCLE_SAMPLES;
    const re = new Float64Array(len);
    const im = new Float64Array(len);
    for (let h = 1; h <= N && h < len; h++) {
      const amp = imag[h];
      if (!amp) continue;
      im[h] = -amp / 2;
      im[len - h] = amp / 2;
    }
    fftInverse(re, im);
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let n = 0; n < len; n++) data[n] = re[n];
    // 归一化到接近满幅,避免削波
    let peak = 0;
    for (let n = 0; n < len; n++) peak = Math.max(peak, Math.abs(data[n]));
    if (peak > 0) {
      const gain = 0.9 / peak;
      for (let n = 0; n < len; n++) data[n] *= gain;
    }
    this.waveCache.set(m, buffer);
    if (this.waveCache.size > WAVE_CACHE_MAX) {
      this.waveCache.delete(this.waveCache.keys().next().value);
    }
    return buffer;
  }

  noteOn(midi, velocity = 1, time, options = {}) {
    this.ensure();
    const m = this._noteNumber(midi);
    const vel = Number.isFinite(velocity) ? Math.max(0, Math.min(1, velocity)) : 1;
    this.sustained.delete(m);
    const existing = this.active.get(m);
    if (existing && !existing.ended) {
      // 同键重触发:尚未起音的旧 voice 无需提前释放,已响的才重新起音
      if (this.ctx.currentTime >= existing.startAt) this._release(m);
    }

    const ctxNow = this.ctx.currentTime;
    const startAt = Number.isFinite(time) && time >= ctxNow
      ? time : ctxNow + 0.05;   // 未指定 time 时稍延迟起音,避免爆音
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

    const source = this.ctx.createBufferSource();
    source.buffer = this._buildWave(m);
    source.loop = true;
    source.playbackRate.value = (oscFreq * CYCLE_SAMPLES) / this.ctx.sampleRate;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = -1;  // Q < 0 means "no resonance" in WebAudio
    const g = this.ctx.createGain();

    g.gain.setValueAtTime(0.0001, startAt);
    g.gain.setTargetAtTime(peak, startAt, attack / 3);
    g.gain.setTargetAtTime(0, startAt + attack, decayTime / 2);
    const naturalEnd = startAt + attack + Math.max(decayTime * 4, 3.0);

    filter.frequency.setValueAtTime(filterStart, startAt);
    filter.frequency.setTargetAtTime(filterTarget, startAt + attack, filterDecay);

    source.connect(filter);
    filter.connect(g);

    g.connect(this.dryGain);
    g.connect(this.convolver);

    source.start(startAt);

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
      source,
      gain: g,
      note: m,
      velocity: vel,
      startAt,
      decayTime,
      peak,
      releaseAt: null,
      releaseTimer: null,
      sourceStopped: false,
      stopTimer: null,
      stopped: false,
      ended: false,
      onEnded: typeof options.onEnded === "function" ? options.onEnded : null
    };
    // 兜底:一直没被 noteOff 的音符在自然衰减结束后停掉 source
    const stopAtNaturalEnd = () => {
      if (voice.sourceStopped || voice.ended || voice.stopped) return;
      if (this.ctx.state !== "running") {
        voice.stopTimer = setTimeout(stopAtNaturalEnd, 250);
        return;
      }
      this._stopSource(voice, this.ctx.currentTime);
    };
    voice.stopTimer = setTimeout(
      stopAtNaturalEnd,
      Math.max(0, naturalEnd - this.ctx.currentTime) * 1000
    );
    this.playing.add(source);
    source.onended = () => {
      this.playing.delete(source);
      this._finishVoice(m, voice);
    };
    this.active.set(m, voice);
    return m;
  }

  noteOnHz(frequency, velocity = 1, time, options = {}) {
    const m = this.hzToMidi(frequency);
    return this.noteOn(m, velocity, time, Object.assign({}, options, { frequency }));
  }

  noteOffHz(frequency, time) {
    return this.noteOff(this.hzToMidi(frequency), time);
  }

  noteOff(midi, at) {
    const m = this._noteNumber(midi);
    if (this.sustain && this.active.has(m)) {
      this.sustained.add(m);          // pedal down: keep the note ringing
      return;
    }
    this._release(m, at);
  }

  _release(midi, atTime) {
    const m = this._noteNumber(midi);
    const voice = this.active.get(m);
    if (!voice || voice.stopped || voice.ended) return;
    const now = this.ctx.currentTime;
    const at = Number.isFinite(atTime) && atTime > now ? atTime : now;

    // 重新排程时,先清掉此前为同一 voice 插入的 release 事件与定时器
    if (voice.releaseAt !== null && voice.releaseAt !== at) {
      voice.gain.gain.cancelScheduledValues(Math.min(at, voice.releaseAt));
      this._clearReleaseSchedule(voice);
    }
    if (at > now) {
      this._scheduleRelease(m, voice, at);
      return;
    }

    this._clearReleaseSchedule(voice);
    voice.stopped = true;
    this._applyReleaseRamp(voice, now);
    this._stopSource(voice, Math.max(now + RELEASE_SEC + 0.15, voice.startAt + 0.02));
    this._finishVoice(m, voice);
  }

  _clearReleaseSchedule(voice) {
    if (voice.releaseAt === null) return;
    clearTimeout(voice.releaseTimer);
    voice.releaseTimer = null;
    voice.releaseAt = null;
  }

  _scheduleRelease(m, voice, at) {
    if (voice.releaseAt === at) return;
    this._applyReleaseRamp(voice, at);
    this._stopSource(voice, Math.max(at + RELEASE_SEC + 0.15, voice.startAt + 0.02));
    voice.releaseAt = at;
    clearTimeout(voice.releaseTimer);
    const finishDelay = Math.max(0, at + RELEASE_SEC - this.ctx.currentTime) * 1000;
    voice.releaseTimer = setTimeout(() => {
      voice.releaseTimer = null;
      voice.releaseAt = null;
      this._finishVoice(m, voice);
    }, finishDelay);
  }

  _stopSource(voice, at) {
    if (voice.sourceStopped) return;
    voice.sourceStopped = true;
    clearTimeout(voice.stopTimer);
    voice.source.stop(at);
  }
  
  _applyReleaseRamp(voice, at) {
    const level = Math.max(this._gainAt(voice, at), 0.0001);
    const gain = voice.gain.gain;
    gain.cancelScheduledValues(at);
    if (at <= this.ctx.currentTime) {
      if (gain.value === 1) gain.setValueAtTime(0, at);
      gain.linearRampToValueAtTime(level, at + ATTACK_SEC);
    } else {
      gain.setValueAtTime(level, at);
    }
    gain.setTargetAtTime(0.0001, at + ATTACK_SEC, RELEASE_SEC / 3);
  }

  _gainAt(voice, t) {
    const startAt = voice.startAt;
    if (t < startAt) return voice.peak;
    const decayStart = startAt + ATTACK_SEC;
    const levelAt = (at) => at < decayStart
      ? voice.peak
      : voice.peak * Math.exp(-(at - decayStart) / (voice.decayTime / 2));
    if (voice.releaseAt === null || t < voice.releaseAt) return levelAt(t);
    const levelAtRelease = levelAt(voice.releaseAt);
    return 0.0001 + (levelAtRelease - 0.0001) * Math.exp(-(t - voice.releaseAt) / (RELEASE_SEC / 3));
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
