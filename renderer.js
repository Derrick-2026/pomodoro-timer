// renderer.js — 运行在 Electron 渲染进程（即页面）中
// ipcRenderer 用于向主进程发送消息（通知、关闭窗口等）
const { ipcRenderer } = require('electron');

// ============================================================
// 状态数据
// ============================================================

// 三种模式的默认时长（分钟）和声音开关
const settings = {
  work:  25,   // 专注时长
  short: 5,    // 短休息时长
  long:  15,   // 长休息时长
  sound: true, // 是否播放提示音
};

// 模式切换顺序：专注 → 短休息 → 长休息（循环）
const MODES = ['work', 'short', 'long'];

// 每种模式在界面上显示的文字标签
const MODE_LABELS = { work: '专注时间', short: '短休息', long: '长休息' };

// SVG 圆环的周长，用于计算进度条偏移量
// 公式：2π × 半径（r=96）≈ 603
const CIRCUMFERENCE = 2 * Math.PI * 96;

// 完成多少个番茄后触发长休息
const CYCLE_LENGTH = 4;
// 底部最多显示多少个 🍅 图标（超出显示 "+N"）
const MAX_TOMATO_DISPLAY = 8;

// ---- 运行时状态变量 ----
let currentMode = 'work';             // 当前所处模式
let timeLeft    = settings.work * 60; // 剩余秒数（初始为 25 分钟）
let totalTime   = settings.work * 60; // 本阶段总秒数（用来计算进度比例）
let isRunning   = false;              // 计时器是否正在运行
let intervalId  = null;               // setInterval 返回的 ID，用于停止计时
let sessionsDone = 0;                 // 今日完成的番茄总数（周期位置 = sessionsDone % CYCLE_LENGTH）

// ============================================================
// 获取页面上的 DOM 元素（避免每次操作时重复查询）
// ============================================================
const timeDisplay    = document.getElementById('timeDisplay');   // 显示 "25:00" 的大字
const sessionLabel   = document.getElementById('sessionLabel');  // 圆圈内的小标签（"专注时间"）
const startBtn       = document.getElementById('startBtn');      // 开始/暂停按钮
const resetBtn       = document.getElementById('resetBtn');      // 重置按钮（↺）
const skipBtn        = document.getElementById('skipBtn');       // 跳过按钮（⏭）
const ringFill       = document.getElementById('ringFill');      // SVG 圆环进度条元素
const tomatoRow      = document.getElementById('tomatoRow');     // 显示番茄图标的行
const sessionCount   = document.getElementById('sessionCount');  // "今日完成：X 个番茄" 中的数字
const settingsToggle = document.getElementById('settingsToggle'); // "⚙ 设置" 折叠按钮
const settingsPanel  = document.getElementById('settingsPanel'); // 设置面板容器
const soundToggle    = document.getElementById('soundToggle');   // 声音开关（checkbox）
// 设置面板各字段数值显示元素，通过 {field}Val 命名约定动态查找
const settingValEls  = { work: document.getElementById('workVal'), short: document.getElementById('shortVal'), long: document.getElementById('longVal') };

// ============================================================
// 音效（使用浏览器内置的 Web Audio API，无需外部音频文件）
// ============================================================

let audioCtx = null;

// 惰性初始化 AudioContext（浏览器要求必须由用户交互触发，不能在页面加载时直接创建）
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

// 播放一段音阶提示音
// type === 'work'  → 上行音阶（C5 E5 G5 C6），清脆上扬，提示"专注结束，去休息"
// type !== 'work'  → 下行音阶（G5 E5 C5 G4），平缓下降，提示"休息结束，回来专注"
function playChime(type) {
  if (!settings.sound) return; // 静音模式直接跳过

  const ctx = getAudioCtx();
  const now = ctx.currentTime; // 当前音频时钟（高精度，单位：秒）

  const freqs = type === 'work'
    ? [523, 659, 784, 1046]  // C5、E5、G5、C6（上行大调和弦）
    : [784, 659, 523, 392];  // G5、E5、C5、G4（下行）

  // 依次在不同时刻触发每个音符
  freqs.forEach((freq, i) => {
    const osc  = ctx.createOscillator(); // 振荡器（产生纯音）
    const gain = ctx.createGain();       // 增益节点（控制音量）

    // 连接信号链：振荡器 → 增益 → 扬声器
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = 'sine';          // 正弦波，音色最柔和
    osc.frequency.value = freq; // 设置频率（Hz）

    const t = now + i * 0.18;  // 每个音符间隔 0.18 秒

    // 音量包络：静音 → 快速淡入（0.04s）→ 指数衰减至静音（0.5s）
    // 这样每个音符有清脆的"叮"感，而不是突然切断
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.25, t + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);

    osc.start(t);       // 在 t 时刻开始播放
    osc.stop(t + 0.5);  // 0.5 秒后停止（释放资源）
  });
}

// ============================================================
// 计时器核心逻辑
// ============================================================

// 将秒数格式化为 "MM:SS" 字符串，例如 90 → "01:30"
function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// 根据剩余时间更新 SVG 圆环进度条
// 原理：通过改变 stroke-dashoffset 来"遮住"部分圆环
//   - offset = 0         → 圆环完整显示（满）
//   - offset = CIRCUMFERENCE → 圆环完全消失（空）
function updateRing() {
  const progress = timeLeft / totalTime;           // 剩余比例，1.0 → 0.0
  const offset   = CIRCUMFERENCE * (1 - progress); // 已消耗的弧长
  ringFill.style.strokeDashoffset = offset;
  // strokeDasharray 是常量，只在初始化时设置一次（见文件末尾）
}

// 统一刷新界面：时间文字、圆环进度、按钮文字
function render() {
  timeDisplay.textContent = formatTime(timeLeft);
  updateRing();
  startBtn.textContent = isRunning ? '暂停' : '开始';
}

// 切换到指定模式（work / short / long）
// 切换时自动停止当前计时，重置时间，并更新 UI 颜色主题
function setMode(mode) {
  currentMode = mode;
  stopTimer(); // 切换模式时先停止计时

  // 重置为该模式的时长
  timeLeft   = settings[mode] * 60;
  totalTime  = timeLeft;

  // 更新圆圈内的标签
  sessionLabel.textContent = MODE_LABELS[mode];

  // 切换 body 的 class 来改变 CSS 变量中的 --accent 颜色
  // CSS 为每个 mode-* 定义对应颜色，统一用 mode-{mode} 类名
  document.body.className = `mode-${mode}`;

  // 更新顶部标签页的高亮状态
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.mode === mode);
  });

  render();
}

// 启动计时：每隔 1 秒将 timeLeft 减 1，到 0 时触发完成逻辑
function startTimer() {
  if (timeLeft === 0) return; // 时间已到，不重复启动
  isRunning = true;
  render(); // 立刻把按钮改成"暂停"
  intervalId = setInterval(() => {
    timeLeft--;
    render();
    if (timeLeft <= 0) onTimerComplete();
  }, 1000);
}

// 暂停/停止计时（清除 interval，但不重置时间）
function stopTimer() {
  isRunning = false;
  clearInterval(intervalId);
  intervalId = null;
  render(); // 把按钮改回"开始"
}

// 重置：停止计时 + 时间归零到当前模式的初始值
function resetTimer() {
  stopTimer();
  timeLeft  = settings[currentMode] * 60;
  totalTime = timeLeft;
  render();
}

// 计时结束时的处理
function onTimerComplete() {
  stopTimer();
  playChime(currentMode);                      // 播放对应提示音
  ipcRenderer.send('timer-complete', currentMode); // 通知主进程发系统通知

  if (currentMode === 'work') {
    // 完成一个专注番茄
    sessionsDone++;
    sessionCount.textContent = sessionsDone;
    updateTomatoes(); // 在底部追加一个 🍅 图标

    // 每完成 CYCLE_LENGTH 个番茄 → 长休息；否则 → 短休息
    if (sessionsDone % CYCLE_LENGTH === 0) {
      setMode('long');
    } else {
      setMode('short');
    }
  } else {
    // 休息结束 → 回到专注模式
    setMode('work');
  }
}

// 更新底部番茄计数图标行
// 最多显示 MAX_TOMATO_DISPLAY 个 🍅，超出部分显示 "+N"
function updateTomatoes() {
  tomatoRow.innerHTML = '';
  const display = Math.min(sessionsDone, MAX_TOMATO_DISPLAY);
  for (let i = 0; i < display; i++) {
    const span = document.createElement('span');
    span.className = 'tomato-icon done';
    span.textContent = '🍅';
    tomatoRow.appendChild(span);
  }
  if (sessionsDone > MAX_TOMATO_DISPLAY) {
    const span = document.createElement('span');
    span.className = 'tomato-icon done';
    span.style.fontSize = '12px';
    span.style.opacity = '0.7';
    span.textContent = `+${sessionsDone - MAX_TOMATO_DISPLAY}`;
    tomatoRow.appendChild(span);
  }
}

// ============================================================
// 事件绑定
// ============================================================

// 开始/暂停按钮：根据当前状态切换
startBtn.addEventListener('click', () => {
  if (isRunning) stopTimer();
  else startTimer();
});

// 重置按钮
resetBtn.addEventListener('click', resetTimer);

// 跳过按钮：跳到下一个模式（循环：work → short → long → work）
skipBtn.addEventListener('click', () => {
  const idx = MODES.indexOf(currentMode);
  setMode(MODES[(idx + 1) % MODES.length]);
});

// 顶部三个模式标签页（专注 / 短休息 / 长休息）
document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => setMode(tab.dataset.mode));
});

// 设置面板折叠/展开
settingsToggle.addEventListener('click', () => {
  settingsPanel.classList.toggle('open');
});

// 声音开关
soundToggle.addEventListener('change', () => {
  settings.sound = soundToggle.checked;
});

// 时长调节按钮（每个按钮上有 data-field 和 data-dir 属性）
// data-field: 'work' | 'short' | 'long'
// data-dir:   +1（增加）| -1（减少）
document.querySelectorAll('.adj-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const field = btn.dataset.field;
    const dir   = parseInt(btn.dataset.dir);

    // 专注时长限制：5~90 分钟；休息时长限制：1~30 分钟
    const min = field === 'work' ? 5 : 1;
    const max = field === 'work' ? 90 : 30;

    // 更新设置值（clamp 到合法范围）
    settings[field] = Math.min(max, Math.max(min, settings[field] + dir));

    // 刷新设置面板中显示的数字
    settingValEls[field].textContent = settings[field];

    // 如果调整的是当前模式且计时未开始，立刻同步计时器时间
    if (field === currentMode && !isRunning) {
      timeLeft  = settings[field] * 60;
      totalTime = timeLeft;
      render();
    }
  });
});

// 自定义标题栏的关闭/最小化按钮，通过 IPC 通知主进程操作窗口
document.getElementById('closeBtn').addEventListener('click', () => {
  ipcRenderer.send('window-close');
});

document.getElementById('minimizeBtn').addEventListener('click', () => {
  ipcRenderer.send('window-minimize');
});

// ============================================================
// 初始化：页面加载完成后渲染初始状态
// ============================================================
ringFill.style.strokeDasharray  = CIRCUMFERENCE; // 常量，仅此一处设置
ringFill.style.strokeDashoffset = 0;             // 初始满圆（无偏移）
render();                                         // 渲染初始时间 "25:00"
