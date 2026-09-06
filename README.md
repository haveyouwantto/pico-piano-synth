# pico-piano-synth

基于神经网络模型生成音色的轻量化 Web Audio 钢琴合成器。打包体积约 **8 KB**，核心音色由约 **0.9 KB** 的小型神经网络生成，**无需任何音频采样切片（Samples）**。

适合用于体积敏感的 Web 音频项目、交互式网页、虚拟键盘及 MIDI 接口对接。

> **注意**：本项目为音频合成引擎，不包含标准 MIDI 文件（SMF）解析与播放功能。

---

## 特性

* **极小体积**：压缩后全量代码约 8 KB（含 0.9 KB 内嵌神经网络模型）。
* **逼真音色**：通过神经网络预测钢琴谐波结构，结合动态包络、击弦噪声和混响，获得自然的钢琴音色。
* **纯算法合成**：无外部音频文件依赖，直接根据 MIDI 音高实时计算波形。
* **完整音域支持**：覆盖 88 键标准钢琴音质（MIDI 21–108）。
* **表达力控制**：支持动态按键力度（Velocity）、延音踏板（Sustain Pedal）、主音量控制及混响调节。
* **单文件即插即用**：提供内嵌模型的打包版本，开箱即用。
* **零外部依赖**：原生基于浏览器 Web Audio API 开发。

---

## 安装

```bash
npm install pico-piano-synth

```

---

## 快速开始

### 方式一：使用内嵌模型单文件（推荐）

```html
<script src="node_modules/pico-piano-synth/dist/piano-synth-embedded.min.js"></script>

<button id="play">播放</button>

<script>
let synth;

document.getElementById("play").addEventListener("click", async () => {
  // 延迟初始化实例
  synth ??= await PianoSynth.load();
  
  // 必须在用户交互回调中调用 ensure()，解锁浏览器的 AudioContext 限制
  synth.ensure();

  // 播放中央 C (MIDI 60)，力度 0.8
  synth.noteOn(60, 0.8);

  // 800ms 后关断音符
  setTimeout(() => synth.noteOff(60), 800);
});
</script>

```

### 方式二：分离式加载模型

```html
<script src="node_modules/pico-piano-synth/dist/piano-synth.min.js"></script>

<script>
// 手动指定二进制模型文件 (.bin) 路径
const synth = await PianoSynth.load("model/piano_nn.bin");
</script>

```

---

## API 参考

### 静态方法

* **`PianoSynth.load(url?: string): Promise<PianoSynth>`**
异步初始化合成器。若不传 `url`，默认使用内嵌模型或默认路径。
* **`PianoSynth.fromBinary(buffer: ArrayBuffer): Promise<PianoSynth>`**
从二进制内存块直接解析初始化模型。

### 实例方法

* **`synth.ensure(): void`**
检查并恢复 `AudioContext` 运行状态。需放在事件监听函数内部以符合浏览器 Autoplay 策略。
* **`synth.noteOn(note: number, velocity?: number): void`**
触发指定音符。
* `note`: MIDI 音高代码（`21` – `108`）。
* `velocity`: 按键力度，取值 `0.0` – `1.0`（默认 `1.0`）。


* **`synth.noteOff(note: number): void`**
关断指定 MIDI 音符。
* **`synth.allNotesOff(): void`**
切断当前所有正在响起的音符。
* **`synth.setSustain(enable: boolean): void`**
设置延音踏板状态。为 `true` 时抬起按键仍会维持余音。
* **`synth.setVolume(volume: number): void`**
设置主输出音量（取值 `0.0` – `1.0`）。
* **`synth.setReverb(amount: number): void`**
调节干湿比混响程度（取值 `0.0` – `1.0`）。
* **`synth.loadIR(url: string): Promise<void>`**
加载外部 WAV/MP3 脉冲响应（Impulse Response）文件，自定义混响空间效果。

---

## 本地 Demo

项目自带一个包含 88 键虚拟键盘、SMF/MIDI 文件播放、控制面板及 Web MIDI 接入能力的测试页面。
选择 `.mid` 或 `.midi` 文件后即可播放，播放中的音符会在键盘上高亮。

```bash
# 启动本地服务
npx serve .

```

打开浏览器访问 `http://localhost:3000/demo/`。

*(注：Web MIDI 硬件接入需要浏览器支持相应 API，且仅在安全上下文 HTTPS 或 localhost 下生效。Demo 的 SMF 播放支持常见的 Type 0/1 文件。)*

---

## 致谢

项目的极简前端音源设计思路受 [PicoAudio.js](https://github.com/cagpie/PicoAudio.js) 启发。

---

## 开源协议

[MIT License](LICENSE)