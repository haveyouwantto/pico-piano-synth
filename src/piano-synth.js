/*
 * PianoSynth - minimal ddsp-piano inspired synth built on PeriodicWave.
 *
 * Model: PIANO_NN v2 (midi + low/high bank -> 32 partial intensities at x*f0),
 * 8-bit quantised. The two banks cover up to 64 partials in total.
 * Envelope: decayTime + lowpass sweep (user formula):
 *   decayTime  = max(decay * decayScale * 2^((decayRefNote-pitch)/decayPitchDiv), decayMin)
 *   filterStart/Target/Decay as in the pluck model, gain = setTargetAtTime.
 *
 * 所有可调参数定义在构造函数里的 this.settings:
 * 构造时用 new PianoSynth(model, { settings: { reverb: 0.3 } }) 覆盖,
 * 运行时用 synth.setSettings(patch) 增量修改(音量/混响/压缩器立即生效)。
 *
 * Usage:
 *   const synth = new PianoSynth(PIANO_NN, { audioContext });
 *   synth.ensure();            // after a user gesture
 *   synth.noteOn(60, 0.8);
 *   synth.noteOff(60);
 */

class PianoSynth {
  constructor(model, options = {}) {
    this.model = model;
    this.layers = null;

    // 合成器的全部可调参数
    this.settings = {
      // ---- 输出 ----
      volume: 0.8,             // 主音量(setVolume 可实时改)
      reverb: 0.8,             // 混响湿度 0~1(setReverb 可实时改)
      a4: 440,                 // A4 参考频率 Hz
      waveCacheMax: 128,       // PeriodicWave 缓存条数上限

      // ---- 音量包络 ----
      pitchAttenCurve: 48,      // 高频音量衰减曲线(音高每升 n 半音衰减一半)
      attack: 0.001,           // 起音时间常数(秒)
      release: 0.3,            // 释音时间常数(秒)
      tcRatio: 3,              // setTargetAtTime 时间常数 = 设定时间 / 该值
      releaseTail: 0.15,       // 释音排程后多留的尾音(秒)
      startDelay: 0.05,        // 未指定 time 时往后延迟起音(秒),避免爆音
      minStopLead: 0.02,       // source 至少排到起音后这么久才停
      velocityCurve: 2,        // 力度 -> 峰值 的指数
      velocityGain: 0.5,       // 力度 -> 峰值 的系数

      // ---- 衰减(音高越低衰减越慢) ----
      decay: 1.0,              // 全局衰减倍数
      decayScale: 1.7,
      decayRefNote: 60,        // 以该音高为 1x 基准
      decayPitchDiv: 18,       // 音高偏移除数
      decayMin: 0.5,           // 衰减时间下限(秒)
      decayTc: 0.4,            // 指数衰减时间常数 = decayTime * 该系数
      decayTail: 4,            // 自然结束后停 source: decayTime * 该系数
      decayTailMin: 3.0,       // 上一项与至少这么多秒取大

      // ---- 低通扫频 ----
      filterBaseHz: 492.35,
      filterVelocityExp: 2.5,
      filterTargetRatio: 0.1,  // 终止频率 = 起始频率 * 该系数
      filterDecayRatio: 0.5,   // 扫频时间常数 = decayTime * 该系数
      filterQ: -1,             // Q < 0 表示无共振

      // ---- 谐波 ----
      partialMaxHz: 12000,     // 只保留低于该频率的谐波(抗混叠)
      partialMargin: 0.98,     // 再乘该系数留裕量
      silentDb: -200,          // 缺失谐波的 dB 下限

      // ---- 击弦噪声 ----
      hammerNoise: true,       // 是否叠加击弦噪声
      hammerGain: 0.5,           // 噪声峰值 = vel^velocityCurve * 该系数
      hammerCurveExp: 0.3,      // 噪声频率随力度的指数曲线
      hammerCurveFloor: 0.2,    // 噪声频率随力度的指数曲线下限
      hammerCutoffOffset: 200, // 噪声低通 = 基频 + 该值
      hammerAttack: 0.0012,    // 噪声起音(秒)
      hammerDur: 0.016,        // 噪声时长 = hammerDur + vel * hammerDurVelocity
      hammerDurVelocity: 0.028,
      hammerStopTail: 0.02,    // 噪声 source 停止的额外余量(秒)
      noiseDuration: 0.08,     // 噪声 buffer 长度(秒)
      noiseSeed: 42,           // 噪声 buffer 随机种子(固定值保证可复现)
      silenceFloor: 0.0001,    // 指数斜坡与静音下限

      // ---- 默认混响 IR ----
      irDuration: 1.6,         // 长度(秒)
      irDecay: 50,             // 衰减速度
      irDamping: 0.22,         // 高频吸收(一阶低通系数)
      irSeed: 411,             // 随机种子

      // ---- 压缩器 ----
      compressorThreshold: -24,
      compressorKnee: 30,
      compressorRatio: 12,
      compressorAttack: 0.003,
      compressorRelease: 0.25
    };
    if (options.settings) Object.assign(this.settings, options.settings);

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
    this._customIR = false;

    this._hammerNoiseBuffer = null;

    this.waveCache = new Map();
    this.envCache = new Map();
    this.active = new Map();
    this.playing = new Set();
    this.sustain = false;
    this.sustained = new Set();
    this.onNoteEnded = null;
    this._decodeModel();
  }

  // synth.decay 是 settings.decay 的快捷方式,赋值即改设置
  get decay() {
    return this.settings.decay;
  }

  set decay(value) {
    this.setSettings({ decay: value });
  }

  // 增量修改设置:未列出的键保持不变,返回完整的 settings
  setSettings(patch) {
    if (!patch) return this.settings;
    const touched = [];
    for (const key of Object.keys(patch)) {
      if (!Object.prototype.hasOwnProperty.call(this.settings, key)) continue;
      this.settings[key] = patch[key];
      touched.push(key);
    }
    this._applySettings(touched);
    return this.settings;
  }

  // 把 settings 应用到当前音频图;touched 里的键顺带失效受影响的缓存
  _applySettings(touched) {
    const S = this.settings;
    if (this.master) this.master.gain.value = S.volume;
    this._applyReverbMix();
    const comp = this.compressor;
    if (comp) {
      comp.threshold.value = S.compressorThreshold;
      comp.knee.value = S.compressorKnee;
      comp.ratio.value = S.compressorRatio;
      comp.attack.value = S.compressorAttack;
      comp.release.value = S.compressorRelease;
    }
    if (!touched) return;
    for (const key of touched) {
      if (key === "a4" || key === "partialMaxHz" || key === "partialMargin" || key === "silentDb") {
        this.waveCache.clear();       // 谐波表变了,缓存的 PeriodicWave 失效
      } else if (key === "noiseSeed" || key === "noisePink" || key === "noiseDuration") {
        this._hammerNoiseBuffer = null;
      } else if (!this._customIR &&
        (key === "irSeed" || key === "irDecay" || key === "irDuration" || key === "irDamping")) {
        this._buildDefaultIR();       // 自定义 IR 优先,不覆盖
      }
    }
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
    return this.settings.a4 * Math.pow(2, (m - 69) / 12);
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
    return 69 + 12 * Math.log2(frequency / this.settings.a4);
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

      this.compressor = this.ctx.createDynamicsCompressor();
      this.output = this.ctx.createGain();
      this.master.connect(this.compressor);
      this.compressor.connect(this.output);
      if (this._autoConnect) this.output.connect(this.ctx.destination);

      this.dryGain = this.ctx.createGain();
      this.wetGain = this.ctx.createGain();
      this.convolver = this.ctx.createConvolver();

      this._applySettings();   // 主音量 / 混响配比 / 压缩器参数

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
  _buildDefaultIR(durationSeconds = this.settings.irDuration, decay = this.settings.irDecay) {
    if (!this.ctx || !this.convolver) return;
    // 固定种子,每次结果一致
    const rand = this._createPrng(this.settings.irSeed);
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
    const damping = this.settings.irDamping;
    for (let c = 0; c < 2; c++) {
      const channel = buffer.getChannelData(c);
      let last = 0;
      for (let i = 0; i < length; i++) {
        channel[i] = last + damping * (channel[i] - last);
        last = channel[i];
      }
    }

    this.convolver.buffer = buffer;
  }

  _getHammerNoiseBuffer() {
    if (this._hammerNoiseBuffer) return this._hammerNoiseBuffer;

    const S = this.settings;
    const rand = this._createPrng(S.noiseSeed);  // 固定种子,每次结果一致
    const duration = S.noiseDuration;            // 足够长，后面用 gain 截断
    const sampleRate = this.ctx.sampleRate;
    const length = Math.floor(sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    // 白噪声
    for (let i = 0; i < length; i++) {
      const white = rand() * 2 - 1;
      data[i] = white;
    }
    this._hammerNoiseBuffer = buffer;
    return buffer;
  }

  async loadIR(url) {
    this.ensure();
    const res = await fetch(url);
    const arrayBuffer = await res.arrayBuffer();
    this.convolver.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    this._customIR = true;   // 自定义 IR 优先,ir* 设置不再覆盖
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
    this.settings.reverb = Math.max(0, Math.min(1, wetRatio));
    this._applyReverbMix();
  }

  // 等功率交叉淡入淡出:干湿比按 sin/cos 分配
  _applyReverbMix() {
    const wet = this.settings.reverb;
    if (!this.dryGain || !this.wetGain) return;
    this.dryGain.gain.value = Math.cos(wet * Math.PI * 0.5);
    this.wetGain.gain.value = Math.sin(wet * Math.PI * 0.5);
  }

  setVolume(v) {
    this.settings.volume = v;
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
      volume: this.settings.volume,
      reverb: this.settings.reverb
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
    const S = this.settings;
    return Math.max(1, Math.min(this.model.n_partials,
      Math.floor(S.partialMargin * S.partialMaxHz / this._midiHz(m))));
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
      const db = (h - 1) % bankSize < env.length ? env[(h - 1) % bankSize] : this.settings.silentDb;
      imag[h] = Math.pow(10, db / 20);
    }

    const real = new Float32Array(N + 1);
    const wave = this.ctx.createPeriodicWave(real, imag);
    this.waveCache.set(m, wave);
    if (this.waveCache.size > this.settings.waveCacheMax) {
      this.waveCache.delete(this.waveCache.keys().next().value);
    }
    return wave;
  }

  noteOn(midi, velocity = 1, time, options = {}) {
    this.ensure();
    const S = this.settings;
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
      ? time : ctxNow + S.startDelay;   // 未指定 time 时稍延迟起音,避免爆音
    const detune = Number.isFinite(options.detune) ? options.detune : 0;
    const noteHz = this._midiHz(m);
    const baseHz = Number.isFinite(options.frequency) && options.frequency > 0
      ? options.frequency : noteHz;
    const oscFreq = baseHz * Math.pow(2, detune / 1200);
    
    // 高频音量衰减
    const pitchAtten = Math.pow(2, (60 - m) / S.pitchAttenCurve);
    // 限制最低衰减，避免最低音过大
    const atten = Math.max(0.35, Math.min(1.6, pitchAtten));
    const peak = Math.pow(vel, S.velocityCurve) * S.velocityGain * atten;

    const decayTime = Math.max(
      S.decay * S.decayScale * Math.pow(2, (S.decayRefNote - m) / S.decayPitchDiv),
      S.decayMin
    );
    const cutoffFreq = S.filterBaseHz * Math.exp(S.filterVelocityExp * vel);
    const nyquist = this.ctx.sampleRate / 2;
    const filterStart = Math.min(cutoffFreq, nyquist);
    const filterTarget = Math.min(cutoffFreq * S.filterTargetRatio, nyquist);
    const filterDecay = decayTime * S.filterDecayRatio;
    const attack = S.attack;

    const source = this.ctx.createOscillator();
    source.frequency.value = oscFreq;
    source.setPeriodicWave(this._buildWave(m));

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = S.filterQ;  // Q < 0 means "no resonance" in WebAudio
    const g = this.ctx.createGain();

    g.gain.setValueAtTime(S.silenceFloor, startAt);
    g.gain.setTargetAtTime(peak, startAt, attack / S.tcRatio);
    g.gain.setTargetAtTime(0, startAt + attack, decayTime * S.decayTc);
    const naturalEnd = startAt + attack + Math.max(decayTime * S.decayTail, S.decayTailMin);

    filter.frequency.setValueAtTime(filterStart, startAt);
    filter.frequency.setTargetAtTime(filterTarget, startAt + attack, filterDecay);

    source.connect(filter);
    filter.connect(g);

    g.connect(this.dryGain);
    g.connect(this.convolver);

    source.start(startAt);

    if (S.hammerNoise) {
      const noiseSrc = this.ctx.createBufferSource();
      noiseSrc.buffer = this._getHammerNoiseBuffer();

      const noiseFilter = this.ctx.createBiquadFilter();
      // 低音更闷一点，高音更亮
      noiseFilter.frequency.value = baseHz * Math.max(S.hammerCurveFloor, vel ** S.hammerCurveExp) + S.hammerCutoffOffset;

      const noiseGain = this.ctx.createGain();
      // 力度用曲线控制，更接近真实击弦动态
      const hammerLevel = Math.pow(vel, S.velocityCurve) * S.hammerGain;

      // 极快的起音 + 快速衰减（15~40ms）
      const hammerDur = S.hammerDur + vel * S.hammerDurVelocity;
      noiseGain.gain.setValueAtTime(0, startAt);
      noiseGain.gain.linearRampToValueAtTime(hammerLevel, startAt + S.hammerAttack);
      noiseGain.gain.exponentialRampToValueAtTime(S.silenceFloor, startAt + hammerDur);

      noiseSrc.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(this.dryGain);
      noiseGain.connect(this.convolver);   // 也送进 IR，空间感一致

      noiseSrc.start(startAt);
      noiseSrc.stop(startAt + hammerDur + S.hammerStopTail);
    }

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
    const S = this.settings;
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
    this._stopSource(voice, Math.max(
      now + S.release + S.releaseTail, voice.startAt + S.minStopLead));
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
    const S = this.settings;
    this._applyReleaseRamp(voice, at);
    this._stopSource(voice, Math.max(
      at + S.release + S.releaseTail, voice.startAt + S.minStopLead));
    voice.releaseAt = at;
    clearTimeout(voice.releaseTimer);
    const finishDelay = Math.max(0, at + S.release - this.ctx.currentTime) * 1000;
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
    const S = this.settings;
    const level = Math.max(this._gainAt(voice, at), S.silenceFloor);
    const gain = voice.gain.gain;
    gain.cancelScheduledValues(at);
    if (at <= this.ctx.currentTime) {
      if (gain.value === 1) gain.setValueAtTime(0, at);
      gain.linearRampToValueAtTime(level, at + S.attack);
    } else {
      gain.setValueAtTime(level, at);
    }
    gain.setTargetAtTime(S.silenceFloor, at + S.attack, S.release / S.tcRatio);
  }

  _gainAt(voice, t) {
    const S = this.settings;
    const startAt = voice.startAt;
    if (t < startAt) return voice.peak;
    const decayStart = startAt + S.attack;
    const levelAt = (at) => at < decayStart
      ? voice.peak
      : voice.peak * Math.exp(-(at - decayStart) / (voice.decayTime * S.decayTc));
    if (voice.releaseAt === null || t < voice.releaseAt) return levelAt(t);
    const levelAtRelease = levelAt(voice.releaseAt);
    return S.silenceFloor + (levelAtRelease - S.silenceFloor) *
      Math.exp(-(t - voice.releaseAt) / (S.release / S.tcRatio));
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
