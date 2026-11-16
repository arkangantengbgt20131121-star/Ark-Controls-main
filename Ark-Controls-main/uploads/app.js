(function () {
  'use strict';

  /* ================= KONFIGURASI ================= */
  var UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  var KNOWN_CHAR_UUIDS = [
    '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
    '6e400003-b5a3-f393-e0a9-e50e24dcca9e'
  ];
  var MAX_POINTS = 30;        // default titik grafik
  var MAX_LOG_LINES = 300;    // batas baris log (anti memori bengkak)
  var MAX_CMD_HISTORY = 8;
  var CHUNK_SIZE = 20;        // batas MTU BLE per tulis
  var CHUNK_GAP_MS = 25;      // jeda antar potongan
  var CHART_FLUSH_MS = 250;   // grafik di-render ulang tiap 250 ms
  var CONNECT_TIMEOUT_MS = 30000;
  var AUTOCONNECT_TIMEOUT_MS = 20000;
  var THEME_KEY = 'microbitTheme';
  var ALARM_KEY = 'microbitAlarm';
  var AUTORECONN_KEY = 'microbitAutoReconn';
  var CONN_KEY = 'microbitConn';
  var UI_KEY = 'microbitUI';
  var DATA_KEY = 'microbitData';
  var FAN_KEY = 'microbitFan';
  var SETTING_KEYS = [THEME_KEY, ALARM_KEY, AUTORECONN_KEY, CONN_KEY, UI_KEY, DATA_KEY, FAN_KEY];
  var VALID_THEMES = ['light', 'dark'];
  var DARK_LEGACY_THEMES = ['skyblue', 'purple', 'sunset', 'midnight', 'terminal'];
  var META_THEME_COLORS = { light: '#f4f6f3', dark: '#020509' };
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var RECORD_MAX = 10000;         // default baris rekaman sesi
  var STALE_AFTER_MS = 5000;      // default data dianggap basi
  var ALARM_HYST = 0.5;           // histeresis alarm (°C)
  var ALARM_REPEAT_MS = 5000;     // ulang bunyi tiap 5 dtk selama alarm aktif
  var AUTO_BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000];
  var AUTO_MAX_ATTEMPTS = 12;     // default upaya maksimum

  /* ================= STATE ================= */
  var state = {
    device: null,
    notifyChar: null,
    writeChar: null,
    connected: false,
    connecting: false,
    demo: false,
    demoTimer: null,
    rx: 0,
    tx: 0,
    rxBuffer: '',
    connectStart: 0,
    uptimeTimer: null,
    dpadDir: null,
    writeChain: Promise.resolve(),
    autoScroll: true,
    wantDisconnect: false,
    lastSeen: { suhu: 0, kelembaban: 0 },
    staleFlag: { suhu: false, kelembaban: false },
    lastSuhu: null,
    rec: { rows: [], suhu: null, hum: null, mode: null, lampu: null, kipas: null },
    alarm: { enabled: false, threshold: 35, sound: true, volume: 80, active: false, lastBeep: 0, bgNotif: false },
    auto: { enabled: false, running: false, attempts: 0, nextAt: 0, gaveUp: false },
    conn: { namePrefix: 'BBC micro:bit', serviceUuid: UART_SERVICE_UUID, maxAttempts: AUTO_MAX_ATTEMPTS },
    ui: { maxPoints: MAX_POINTS, toastMs: 4000, sounds: true, wakeLock: false },
    data: { staleSec: Math.round(STALE_AFTER_MS / 1000), recordMax: RECORD_MAX },
    fan: { enabled: false, low: 28, high: 33, lastSent: -1, lastTime: 0 }
  };

  /* ================= HELPERS ================= */
  function $(id) { return document.getElementById(id); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function shortUuid(uuid) { try { return String(uuid).slice(4, 8); } catch (e) { return '?'; } }
  function formatElapsed(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (h > 0 ? h + ':' : '') + p(m) + ':' + p(ss);
  }
  // Bungkus promise dengan timeout agar operasi GATT yang macet tidak menggantung selamanya.
  function withTimeout(promise, ms, message) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () {
        if (!done) { done = true; reject(new Error(message || 'Timeout.')); }
      }, ms);
      promise.then(
        function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
        function (err) { if (!done) { done = true; clearTimeout(t); reject(err); } }
      );
    });
  }
  // Encoder/decoder dipakai ulang (lebih hemat + decode streaming tahan karakter multi-byte yang terpotong antar paket).
  var textEncoder = new TextEncoder();
  var textDecoder = new TextDecoder('utf-8');

  /* ================= ELEMEN ================= */
  var els = {
    statusDot: $('statusDot'), statusText: $('statusText'),
    connectBtn: $('connectBtn'), demoBtn: $('demoBtn'),
    statDevice: $('statDevice'), statUptime: $('statUptime'),
    statRx: $('statRx'), statTx: $('statTx'), statRxRate: $('statRxRate'),
    pageTitle: $('pageTitle'), pageDesc: $('pageDesc'),
    bleWarn: $('bleWarn'), bleWarnText: $('bleWarnText'),
    bleWarnClose: $('bleWarnClose'), bleWarnDemo: $('bleWarnDemo'),
    themeToggleBtn: $('themeToggleBtn'), themeToggleLabel: $('themeToggleLabel'),
    suhuVal: $('suhuVal'), suhuTrend: $('suhuTrend'),
    kelembabanVal: $('kelembabanVal'), kelembabanTrend: $('kelembabanTrend'),
    modeVal: $('modeVal'),
    lampuSwitch: $('lampuSwitch'), lampuStatus: $('lampuStatus'),
    kipasSlider: $('kipasSlider'), kipasVal: $('kipasVal'), kipasPct: $('kipasPct'),
    logBox: $('logBox'),
    autoScrollToggle: $('autoScrollToggle'),
    copyLogBtn: $('copyLogBtn'), dlLogBtn: $('dlLogBtn'), clearLogBtn: $('clearLogBtn'),
    dpadStatus: $('dpadStatus'), dpadStop: $('dpadStop'),
    capitBtn: $('capitBtn'), lepasBtn: $('lepasBtn'),
    lastCmdVal: $('lastCmdVal'), cmdHistory: $('cmdHistory'), cmdEmpty: $('cmdEmpty'),
    guideCode: $('guideCode'), guideCopyBtn: $('guideCopyBtn'),
    toasts: $('toasts'),
    suhuWidget: $('suhuWidget'), suhuAge: $('suhuAge'),
    humWidget: $('humWidget'), humAge: $('humAge'),
    alarmEnabled: $('alarmEnabled'), alarmThreshold: $('alarmThreshold'),
    alarmSound: $('alarmSound'), alarmTestBtn: $('alarmTestBtn'), alarmState: $('alarmState'),
    recCount: $('recCount'), exportCsvBtn: $('exportCsvBtn'), clearRecBtn: $('clearRecBtn'),
    statSuhuMin: $('statSuhuMin'), statSuhuMax: $('statSuhuMax'), statSuhuAvg: $('statSuhuAvg'),
    statHumMin: $('statHumMin'), statHumMax: $('statHumMax'), statHumAvg: $('statHumAvg'),
    statResetBtn: $('statResetBtn'),
    autoReconnToggle: $('autoReconnToggle'), autoReconnStatus: $('autoReconnStatus'),
    fanAutoEnabled: $('fanAutoEnabled'), fanAutoLow: $('fanAutoLow'),
    fanAutoHigh: $('fanAutoHigh'), fanAutoState: $('fanAutoState'),
    setAutoToggle: $('setAutoToggle'), setMaxAttempts: $('setMaxAttempts'),
    setNamePrefix: $('setNamePrefix'), setServiceUuid: $('setServiceUuid'), resetUuidBtn: $('resetUuidBtn'),
    setMaxPoints: $('setMaxPoints'), setToastDur: $('setToastDur'),
    setAlarmEnabled: $('setAlarmEnabled'), setAlarmThreshold: $('setAlarmThreshold'),
    setAlarmSound: $('setAlarmSound'), setAlarmVolume: $('setAlarmVolume'),
    setAlarmVolumeVal: $('setAlarmVolumeVal'), setAlarmTestBtn: $('setAlarmTestBtn'),
    setNotifSound: $('setNotifSound'),
    setStaleSec: $('setStaleSec'), setRecordMax: $('setRecordMax'),
    setExportCsvBtn: $('setExportCsvBtn'), setClearRecBtn: $('setClearRecBtn'),
    exportCfgBtn: $('exportCfgBtn'), importCfgBtn: $('importCfgBtn'), importFile: $('importFile'),
    resetAllBtn: $('resetAllBtn'),
    setBgNotif: $('setBgNotif'), setWakeLock: $('setWakeLock'), wakeDesc: $('wakeDesc'),
    cmdForm: $('cmdForm'), cmdInput: $('cmdInput'), cmdSendBtn: $('cmdSendBtn'),
    gamepadStatus: $('gamepadStatus')
  };
  var navItems = $all('.nav-list .nav-item');
  var pages = $all('.page');
  var dpadButtons = $all('.dpad-btn[data-dir]');
  var presetButtons = $all('.preset-btn');

  /* ================= TOAST ================= */
  function toast(msg, type) {
    type = type || 'info';
    var box = els.toasts;
    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    var dot = document.createElement('span');
    dot.className = 'toast-dot';
    var text = document.createElement('span');
    text.textContent = msg;
    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Tutup notifikasi');
    close.textContent = '✕';
    el.appendChild(dot); el.appendChild(text); el.appendChild(close);
    box.appendChild(el);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    var killed = false;
    function kill() {
      if (killed) return; killed = true;
      el.classList.add('out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }
    close.addEventListener('click', kill);
    setTimeout(kill, state.ui.toastMs);
  }

  /* ================= LOG ================= */
  function logActivity(message, type) {
    type = type || 'info';
    var box = els.logBox;
    var empty = box.querySelector('.log-empty');
    if (empty) box.removeChild(empty);
    var line = document.createElement('div');
    line.className = 'log-line log-' + type;
    var time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = '[' + new Date().toLocaleTimeString('id-ID', { hour12: false }) + ']';
    line.appendChild(time);
    line.appendChild(document.createTextNode(' ' + message)); // textContent: aman dari HTML injeksi
    box.appendChild(line);
    while (box.children.length > MAX_LOG_LINES) box.removeChild(box.firstChild);
    if (state.autoScroll) box.scrollTop = box.scrollHeight;
  }

  function getLogText() {
    return $all('.log-line', els.logBox).map(function (l) { return l.textContent; }).join('\n');
  }

  els.clearLogBtn.addEventListener('click', function () {
    els.logBox.innerHTML = '';
    var p = document.createElement('p');
    p.className = 'log-empty';
    p.textContent = 'Log aktivitas akan muncul di sini…';
    els.logBox.appendChild(p);
  });

  els.copyLogBtn.addEventListener('click', function () {
    var text = getLogText() || '(log kosong)';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast('Log disalin ke clipboard.', 'success'); },
        function () { fallbackCopy(text); }
      );
    } else fallbackCopy(text);
  });
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Log disalin ke clipboard.', 'success'); }
    catch (e) { toast('Gagal menyalin log.', 'error'); }
    document.body.removeChild(ta);
  }

  els.dlLogBtn.addEventListener('click', function () {
    var text = getLogText() || '(log kosong)';
    var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'microbit-log-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  });

  els.autoScrollToggle.addEventListener('change', function (e) {
    state.autoScroll = e.target.checked;
    if (state.autoScroll) els.logBox.scrollTop = els.logBox.scrollHeight;
  });

  /* ================= NAVIGASI ================= */
  var pageMeta = {
    'page-dashboard': ['Dashboard micro:bit', 'Pantau sensor & kendalikan output micro:bit.'],
    'page-parking': ['Smart Parking', 'Status enam petak parkir dari micro:bit secara real-time.'],
    'page-controlpad': ['Control Pad', 'Kendalikan gerakan dengan D-Pad atau keyboard.'],
    'page-gesture': ['Gestur Tangan', 'Deteksi gerakan tangan via Teachable Machine — hasil tampil real-time.'],
    'page-panduan': ['Panduan', 'Langkah mulai, contoh kode, format data, dan bantuan.'],
    'page-settings': ['Pengaturan', 'Konfigurasi koneksi, tampilan, alarm & data.']
  };
  function switchToPage(target) {
    if (!pageMeta[target]) target = 'page-dashboard';
    navItems.forEach(function (n) { n.classList.toggle('active', n.dataset.page === target); });
    pages.forEach(function (p) { p.classList.toggle('page-hidden', p.id !== target); });
    els.pageTitle.textContent = pageMeta[target][0];
    els.pageDesc.textContent = pageMeta[target][1];
  }
  navItems.forEach(function (item) {
    item.addEventListener('click', function () { switchToPage(item.dataset.page); });
  });

  /* ================= TEMA ================= */
  function normalizeTheme(themeId) {
    if (VALID_THEMES.indexOf(themeId) !== -1) return themeId;
    return DARK_LEGACY_THEMES.indexOf(themeId) !== -1 ? 'dark' : 'light';
  }
  var themeTransitionTimer = null;
  function syncSettingsTheme(themeId) {
    $all('input[name="setTheme"]').forEach(function (r) { r.checked = (r.value === themeId); });
  }
  function applyTheme(themeId, persist) {
    themeId = normalizeTheme(themeId);
    var root = document.documentElement;
    var changed = root.getAttribute('data-theme') !== themeId;
    if (changed) {
      root.classList.add('theme-transition');
      clearTimeout(themeTransitionTimer);
      themeTransitionTimer = setTimeout(function () { root.classList.remove('theme-transition'); }, 700);
    }
    document.documentElement.setAttribute('data-theme', themeId);
    var nextTheme = themeId === 'dark' ? 'light' : 'dark';
    var nextLabel = nextTheme === 'dark' ? 'Aktifkan tema gelap' : 'Aktifkan tema terang';
    els.themeToggleLabel.textContent = nextLabel;
    els.themeToggleBtn.setAttribute('aria-label', nextLabel);
    syncSettingsTheme(themeId);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', META_THEME_COLORS[themeId]);
    if (persist !== false) {
      try { localStorage.setItem(THEME_KEY, themeId); } catch (e) { /* abaikan */ }
    }
    refreshChartTheme();
  }
  els.themeToggleBtn.addEventListener('click', function () {
    var currentTheme = document.documentElement.getAttribute('data-theme');
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
  });

  /* ================= GRAFIK ================= */
  var chartSuhu = null, chartKelembaban = null;
  var chartDirty = { suhu: false, hum: false };
  function themeChartColors() {
    var cs = getComputedStyle(document.documentElement);
    return {
      grid: (cs.getPropertyValue('--chart-grid') || '').trim() || 'rgba(128,128,128,0.15)',
      tick: (cs.getPropertyValue('--chart-tick') || '').trim() || '#888888'
    };
  }
  function createChart(canvasId, color, suggestedMax) {
    var canvas = $(canvasId);
    if (!canvas) return null;
    if (!window.Chart) {
      // Fallback jika CDN Chart.js gagal dimuat: angka sensor tetap berfungsi.
      canvas.parentElement.innerHTML = '';
      var p = document.createElement('p');
      p.className = 'chart-fallback';
      p.textContent = 'Grafik tidak tersedia (Chart.js gagal dimuat). Nilai sensor tetap tampil di atas.';
      canvas.parentElement.appendChild(p);
      return null;
    }
    var ctx = canvas.getContext('2d');
    var c = themeChartColors();
    var grad = ctx.createLinearGradient(0, 0, 0, 148);
    grad.addColorStop(0, color + '44');
    grad.addColorStop(1, color + '00');
    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          data: [], borderColor: color, backgroundColor: grad,
          borderWidth: 2, fill: true, tension: 0.35,
          pointRadius: 0, pointHitRadius: 10
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: true, displayColors: false,
            backgroundColor: 'rgba(8,12,20,0.92)',
            titleFont: { family: "'JetBrains Mono', monospace", size: 10 },
            bodyFont: { family: "'JetBrains Mono', monospace", size: 12 },
            padding: 10, cornerRadius: 6
          }
        },
        scales: {
          x: { display: false },
          y: {
            beginAtZero: true, suggestedMax: suggestedMax,
            grid: { color: c.grid },
            border: { display: false },
            ticks: { color: c.tick, font: { family: "'JetBrains Mono', monospace", size: 10 }, maxTicksLimit: 4 }
          }
        }
      }
    });
  }
  function refreshChartTheme() {
    var c = themeChartColors();
    [chartSuhu, chartKelembaban].forEach(function (ch) {
      if (!ch) return;
      ch.options.scales.y.grid.color = c.grid;
      ch.options.scales.y.ticks.color = c.tick;
      ch.update();
    });
  }
  // Data didorong tiap pesan masuk, tapi render-nya dibatasi (throttle) via flushCharts
  // agar micro:bit yang mengirim cepat tidak membuat halaman lag.
  function pushChart(chart, value, key) {
    if (!chart) return;
    var d = chart.data;
    d.labels.push('');
    d.datasets[0].data.push(value);
    while (d.labels.length > state.ui.maxPoints) { d.labels.shift(); d.datasets[0].data.shift(); }
    chartDirty[key] = true;
  }
  function flushCharts() {
    if (chartDirty.suhu && chartSuhu) { chartSuhu.update(); chartDirty.suhu = false; }
    if (chartDirty.hum && chartKelembaban) { chartKelembaban.update(); chartDirty.hum = false; }
  }
  function trimCharts() {
    [chartSuhu, chartKelembaban].forEach(function (ch) {
      if (!ch) return;
      while (ch.data.labels.length > state.ui.maxPoints) { ch.data.labels.shift(); ch.data.datasets[0].data.shift(); }
      ch.update();
    });
    chartDirty.suhu = false;
    chartDirty.hum = false;
  }

  /* ================= STATUS & STATISTIK ================= */
  function setStatus(text, mode) {
    els.statusText.textContent = text;
    var extra = { on: 'on', error: 'error', busy: 'busy', demo: 'demo' }[mode] || '';
    els.statusDot.className = 'led-dot' + (extra ? ' ' + extra : '');
  }
  function updateStats() {
    els.statRx.textContent = state.rx;
    els.statTx.textContent = state.tx;
  }
  function startUptime() {
    stopUptime();
    resetSessStats(true);
    wakeAcquire();
    state.uptimeTimer = setInterval(function () {
      els.statUptime.textContent = formatElapsed(Date.now() - state.connectStart);
    }, 1000);
    els.statUptime.textContent = '00:00';
  }
  function stopUptime() {
    wakeRelease();
    if (state.uptimeTimer) { clearInterval(state.uptimeTimer); state.uptimeTimer = null; }
    els.statUptime.textContent = '—';
  }

  function isConnected() {
    return !!(state.connected && state.device && state.device.gatt && state.device.gatt.connected);
  }
  function canControl() { return isConnected() || state.demo; }

  function setControlsEnabled() {
    var en = canControl();
    els.lampuSwitch.disabled = !en;
    els.kipasSlider.disabled = !en;
    dpadButtons.forEach(function (b) { b.disabled = !en; });
    els.dpadStop.disabled = !en;
    els.capitBtn.disabled = !en;
    els.lepasBtn.disabled = !en;
    els.cmdInput.disabled = !en;
    els.cmdSendBtn.disabled = !en;
    presetButtons.forEach(function (b) { b.disabled = !en; });
    if (!en) dpadReset(true);
  }

  /* ================= PERINTAH MANUAL ================= */
  els.cmdForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = els.cmdInput.value.trim().slice(0, 40);
    if (!v) return;
    if (!canControl()) { toast('Hubungkan dulu atau aktifkan Mode Demo.', 'warn'); return; }
    sendData(v);
    els.cmdInput.value = '';
    els.cmdInput.focus();
  });

  /* ================= PARSING DATA MASUK ================= */
  var prevSuhu = null, prevHum = null;
  var parkingStates = [null, null, null, null, null, null, null];
  function updateParkingSummary() {
    var occupied = 0, free = 0;
    for (var i = 1; i < parkingStates.length; i++) {
      if (parkingStates[i] === true) occupied++;
      else if (parkingStates[i] === false) free++;
    }
    $('parkingOccupied').textContent = occupied;
    $('parkingFree').textContent = free;
    $('parkingWaiting').textContent = parkingStates.length - 1 - occupied - free;
    $('parkingAddBtn').disabled = occupied === parkingStates.length - 1;
    $('parkingRemoveBtn').disabled = occupied === 0;
  }
  function setParkingStatus(lotNumber, occupied) {
    var slot = $('parkingSlot' + lotNumber);
    if (!slot) {
      logActivity('Nomor lot parkir di luar jangkauan: ' + lotNumber, 'warn');
      return;
    }
    parkingStates[lotNumber] = occupied;
    slot.dataset.state = occupied ? 'occupied' : 'free';
    slot.setAttribute('aria-label', 'Lot ' + lotNumber + ', ' + (occupied ? 'terisi' : 'kosong'));
    $('parkingState' + lotNumber).textContent = occupied ? 'Terisi' : 'Kosong';
    updateParkingSummary();
  }
  $('parkingAddBtn').addEventListener('click', function () {
    for (var i = 1; i < parkingStates.length; i++) {
      if (parkingStates[i] !== true) {
        setParkingStatus(i, true);
        logActivity('Mobil ditambahkan secara manual ke lot ' + i + '.', 'sys');
        return;
      }
    }
  });
  $('parkingRemoveBtn').addEventListener('click', function () {
    for (var i = parkingStates.length - 1; i > 0; i--) {
      if (parkingStates[i] === true) {
        setParkingStatus(i, false);
        logActivity('Mobil dihapus secara manual dari lot ' + i + '.', 'sys');
        return;
      }
    }
  });
  function setTrend(el, prev, curr) {
    if (prev === null || prev === curr) { el.textContent = ''; el.className = 'trend'; return curr; }
    if (curr > prev) { el.textContent = '▲'; el.className = 'trend up'; }
    else { el.textContent = '▼'; el.className = 'trend down'; }
    return curr;
  }
  function flashMode() {
    var b = els.modeVal;
    b.classList.remove('flash');
    void b.offsetWidth; // paksa reflow agar animasi bisa diulang
    b.classList.add('flash');
  }

  function parseLine(line) {
    var parkingMatch = line.match(/^(?:parking|parkir|slot|lot|p)[\s_-]*(?:lot[\s_-]*)?(\d+)\s*:?[\s_-]*(occupied|terisi|full|empty|kosong|free|true|false|1|0)$/i);
    if (parkingMatch) {
      var lotNumber = Number(parkingMatch[1]);
      var parkingValue = parkingMatch[2].toLowerCase();
      if (lotNumber < 1 || lotNumber > 6) {
        logActivity('Nomor lot parkir di luar jangkauan: ' + lotNumber, 'warn');
        return;
      }
      setParkingStatus(lotNumber, ['occupied', 'terisi', 'full', 'true', '1'].indexOf(parkingValue) !== -1);
      return;
    }
    var idx = line.indexOf(':');
    if (idx === -1) { logActivity('Format tak dikenal (tanpa ":"): ' + line, 'warn'); return; }
    var key = line.slice(0, idx).trim().toLowerCase();
    var raw = line.slice(idx + 1).trim();
    var value = Number(raw);
    if (!isFinite(value)) { logActivity('Nilai bukan angka untuk "' + key + '": ' + raw, 'warn'); return; }

    if (key === 'suhu' || key === 'temp' || key === 'temperature') {
      value = clamp(value, -40, 85);
      els.suhuVal.textContent = value;
      prevSuhu = setTrend(els.suhuTrend, prevSuhu, value);
      pushChart(chartSuhu, value, 'suhu');
      freshMark('suhu');
      state.lastSuhu = value;
      state.rec.suhu = value;
      recordRow();
      checkAlarm(value);
      fanAutoTick(value);
      sessPush('suhu', value);
    } else if (key === 'kelembaban' || key === 'kelembapan' || key === 'hum' || key === 'humidity') {
      value = clamp(value, 0, 100);
      els.kelembabanVal.textContent = value;
      prevHum = setTrend(els.kelembabanTrend, prevHum, value);
      pushChart(chartKelembaban, value, 'hum');
      freshMark('kelembaban');
      state.rec.hum = value;
      recordRow();
      sessPush('hum', value);
    } else if (key === 'mode') {
      els.modeVal.textContent = Math.round(value);
      flashMode();
      state.rec.mode = Math.round(value);
      recordRow();
    } else if (key === 'lampu' || key === 'led' || key === 'lamp') {
      var on = value == 1;
      setLampuUI(on);
      state.rec.lampu = on ? 1 : 0;
      recordRow();
    } else if (key === 'kipas' || key === 'fan' || key === 'motor') {
      var kv = Math.round(clamp(value, 0, 1023));
      setKipasUI(kv);
      state.rec.kipas = kv;
      recordRow();
    } else {
      logActivity('Kunci tak dikenal "' + key + '" — diabaikan.', 'warn');
    }
  }

  function handleIncomingData(event) {
    try {
      var dv = event.target.value;
      if (!dv) return;
      // Abaikan data nyasar (mis. notifikasi yang terlanjur aktif setelah timeout/disconnect).
      if (!state.connected && !state.demo) return;
      state.rxBuffer += textDecoder.decode(dv, { stream: true });
      var parts = state.rxBuffer.split(/\r?\n/);
      state.rxBuffer = parts.pop();
      // Pengaman: jika micro:bit tidak pernah mengirim newline, jangan biarkan buffer membengkak.
      if (state.rxBuffer.length > 512) {
        state.rxBuffer = '';
        logActivity('Buffer RX dibuang (tidak ada newline terlalu lama).', 'warn');
      }
      for (var i = 0; i < parts.length; i++) {
        var line = parts[i].trim();
        if (!line) continue;
        state.rx++;
        updateStats();
        logActivity('Masuk: ' + line, 'rx');
        parseLine(line);
      }
    } catch (err) {
      console.error(err);
    }
  }

  /* ================= MENGIRIM DATA (antrean + potongan 20 byte) ================= */
  function pushCmdHistory(cmd) {
    els.lastCmdVal.textContent = cmd;
    var li = document.createElement('li');
    var c = document.createElement('span'); c.textContent = cmd;
    var t = document.createElement('span');
    t.textContent = new Date().toLocaleTimeString('id-ID', { hour12: false });
    li.appendChild(c); li.appendChild(t);
    els.cmdHistory.insertBefore(li, els.cmdHistory.firstChild);
    while (els.cmdHistory.children.length > MAX_CMD_HISTORY) {
      els.cmdHistory.removeChild(els.cmdHistory.lastChild);
    }
    els.cmdEmpty.style.display = 'none';
  }

  function sendData(cmd) {
    cmd = String(cmd == null ? '' : cmd).trim();
    if (!cmd) return;
    pushCmdHistory(cmd);

    if (state.demo) {
      state.tx++; updateStats();
      logActivity('Keluar: ' + cmd, 'tx');
      demoLoopback(cmd);
      return;
    }
    if (!isConnected() || !state.writeChar) {
      toast('Belum terhubung — perintah "' + cmd + '" dibatalkan.', 'warn');
      logActivity('Gagal kirim "' + cmd + '": belum terhubung.', 'warn');
      return;
    }
    var payload = textEncoder.encode(cmd + '\n');
    state.tx++; updateStats();
    logActivity('Keluar: ' + cmd, 'tx');
    // Antrean: cegah "GATT operation already in progress" saat kirim cepat beruntun.
    state.writeChain = state.writeChain.then(function () {
      return writePayload(payload);
    }).catch(function (err) {
      console.error(err);
      logActivity('Error kirim: ' + (err && err.message ? err.message : err), 'err');
    });
  }

  function writePayload(bytes) {
    var char = state.writeChar;
    if (!char) return Promise.reject(new Error('Karakteristik tulis hilang.'));
    var noResp = !!(char.properties && char.properties.writeWithoutResponse && char.writeValueWithoutResponse);
    var chain = Promise.resolve();
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      (function (offset) {
        chain = chain.then(function () {
          var chunk = bytes.slice(offset, offset + CHUNK_SIZE);
          var p = noResp ? char.writeValueWithoutResponse(chunk) : char.writeValue(chunk);
          return p.then(function () {
            if (offset + CHUNK_SIZE < bytes.length) return sleep(CHUNK_GAP_MS);
          });
        });
      })(i);
    }
    return chain;
  }

  /* ================= KONTROL UI: LAMPU & KIPAS ================= */
  function setLampuUI(on) {
    if (els.lampuSwitch.checked !== on) els.lampuSwitch.checked = on;
    els.lampuStatus.textContent = on ? 'MENYALA' : 'MATI';
    els.lampuStatus.classList.toggle('on', on);
  }
  els.lampuSwitch.addEventListener('change', function (e) {
    var on = e.target.checked;
    setLampuUI(on);
    sendData('lampu:' + (on ? 1 : 0));
  });

  function setKipasUI(v) {
    els.kipasSlider.value = v;
    els.kipasVal.textContent = v;
    els.kipasPct.textContent = Math.round(v / 1023 * 100) + '%';
    els.kipasSlider.style.setProperty('--fill', (v / 1023 * 100) + '%');
  }
  els.kipasSlider.addEventListener('input', function (e) {
    setKipasUI(Number(e.target.value));
  });
  els.kipasSlider.addEventListener('change', function (e) {
    if (state.fan.enabled) setFanAuto(false, true);
    sendData('kipas:' + e.target.value);
  });
  presetButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      if (state.fan.enabled) setFanAuto(false, true);
      var v = Number(b.dataset.kipas);
      setKipasUI(v);
      sendData('kipas:' + v);
    });
  });

  /* ================= KIPAS OTOMATIS ================= */
  function updateFanAutoState(extra) {
    var st = els.fanAutoState;
    st.classList.remove('armed');
    if (state.fan.enabled) {
      st.textContent = 'SIAGA' + (extra || '');
      st.classList.add('armed');
    } else {
      st.textContent = 'NONAKTIF';
    }
  }
  function saveFan() {
    try {
      localStorage.setItem(FAN_KEY, JSON.stringify({
        enabled: state.fan.enabled, low: state.fan.low, high: state.fan.high
      }));
    } catch (e) { /* abaikan */ }
  }
  function setFanAuto(v, manual) {
    v = !!v;
    state.fan.enabled = v;
    els.fanAutoEnabled.checked = v;
    if (v) {
      state.fan.lastSent = -1;
      state.fan.lastTime = 0;
      logActivity('Kipas otomatis dinyalakan (' + state.fan.low + '–' + state.fan.high + ' °C).', 'sys');
      updateFanAutoState();
      if (state.lastSuhu !== null) fanAutoTick(state.lastSuhu);
    } else {
      if (manual) {
        logActivity('Kipas otomatis dimatikan (kontrol manual).', 'sys');
        toast('Kipas otomatis dimatikan.');
      } else {
        logActivity('Kipas otomatis dimatikan.', 'sys');
      }
      updateFanAutoState();
    }
    saveFan();
  }
  function setFanRange(which, v) {
    v = Number(v);
    if (!isFinite(v)) v = which === 'low' ? 28 : 33;
    v = clamp(Math.round(v * 2) / 2, 0, 60);
    state.fan[which] = v;
    if (state.fan.low >= state.fan.high) {
      if (which === 'low') state.fan.high = clamp(state.fan.low + 1, 0, 60);
      else state.fan.low = clamp(state.fan.high - 1, 0, 60);
      toast('Ambang disesuaikan agar bawah < atas.', 'warn');
    }
    els.fanAutoLow.value = state.fan.low;
    els.fanAutoHigh.value = state.fan.high;
    saveFan();
    updateFanAutoState();
    if (state.fan.enabled && state.lastSuhu !== null) {
      state.fan.lastSent = -1;
      fanAutoTick(state.lastSuhu);
    }
  }
  function fanAutoTick(value) {
    var f = state.fan;
    if (!f.enabled || !canControl()) return;
    var target;
    if (value <= f.low) target = 0;
    else if (value >= f.high) target = 1023;
    else target = Math.round((value - f.low) / (f.high - f.low) * 1023);
    var now = Date.now();
    // Hanya kirim jika berubah cukup besar & minimal 1 detik sejak kirim terakhir (anti-banjir BLE).
    if (Math.abs(target - f.lastSent) >= 40 && now - f.lastTime >= 1000) {
      f.lastSent = target;
      f.lastTime = now;
      setKipasUI(target);
      sendData('kipas:' + target);
      updateFanAutoState(' · ' + Math.round(target / 1023 * 100) + '%');
    }
  }
  function loadFanSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(FAN_KEY) || '{}');
      if (isFinite(s.low)) state.fan.low = clamp(s.low, 0, 60);
      if (isFinite(s.high)) state.fan.high = clamp(s.high, 0, 60);
      if (state.fan.low >= state.fan.high) { state.fan.low = 28; state.fan.high = 33; }
      state.fan.enabled = !!s.enabled;
    } catch (e) { /* abaikan: pakai default */ }
    els.fanAutoLow.value = state.fan.low;
    els.fanAutoHigh.value = state.fan.high;
    els.fanAutoEnabled.checked = state.fan.enabled;
    updateFanAutoState();
  }
  els.fanAutoEnabled.addEventListener('change', function (e) { setFanAuto(e.target.checked, false); });
  els.fanAutoLow.addEventListener('change', function (e) { setFanRange('low', e.target.value); });
  els.fanAutoHigh.addEventListener('change', function (e) { setFanRange('high', e.target.value); });

  /* ================= CONTROL PAD ================= */
  els.capitBtn.addEventListener('click', function () { sendData('capit'); });
  els.lepasBtn.addEventListener('click', function () { sendData('lepas'); });

  function dpadUpdateStatus(text, moving) {
    els.dpadStatus.textContent = text;
    els.dpadStatus.classList.toggle('moving', !!moving);
  }
  function dpadReset(silent) {
    state.dpadDir = null;
    dpadButtons.forEach(function (b) { b.classList.remove('active'); });
    dpadUpdateStatus('STOP', false);
    if (!silent) sendData('stop');
  }
  function dpadPress(dir) {
    if (!canControl()) { toast('Hubungkan dulu atau aktifkan Mode Demo.', 'warn'); return; }
    if (state.dpadDir === dir) return;
    state.dpadDir = dir;
    dpadButtons.forEach(function (b) { b.classList.toggle('active', b.dataset.dir === dir); });
    dpadUpdateStatus(dir.toUpperCase(), true);
    sendData(dir);
  }
  function dpadRelease() {
    if (state.dpadDir === null) return;
    dpadReset(false);
  }

  dpadButtons.forEach(function (btn) {
    var dir = btn.dataset.dir;
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch (err) { /* abaikan */ }
      dpadPress(dir);
    });
    btn.addEventListener('pointerup', function (e) { e.preventDefault(); dpadRelease(); });
    btn.addEventListener('pointercancel', function () { dpadRelease(); });
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  });
  els.dpadStop.addEventListener('click', function () { dpadRelease(); });
  // Pengaman: jika jendela kehilangan fokus saat tombol ditahan, kirim "stop".
  window.addEventListener('blur', function () { dpadRelease(); });

  var dpadKeyMap = {
    ArrowUp: 'atas', ArrowDown: 'bawah', ArrowLeft: 'kiri', ArrowRight: 'kanan',
    w: 'atas', s: 'bawah', a: 'kiri', d: 'kanan'
  };
  document.addEventListener('keydown', function (e) {
    if (e.repeat) return;
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    var dir = dpadKeyMap[k] || dpadKeyMap[e.key];
    if (!dir || !canControl()) return;
    var tag = (e.target && e.target.tagName ? e.target.tagName : '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable)) return;
    e.preventDefault();
    if ($('page-controlpad').classList.contains('page-hidden')) switchToPage('page-controlpad');
    dpadPress(dir);
  });
  document.addEventListener('keyup', function (e) {
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    var dir = dpadKeyMap[k] || dpadKeyMap[e.key];
    if (!dir) return;
    if (state.dpadDir === dir) dpadRelease();
  });

  /* ================= GAMEPAD USB ================= */
  var padPrevDir = null;
  var padLastText = '';
  function firstPad() {
    var pads = [];
    try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) { return null; }
    for (var i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i].connected) return pads[i];
    }
    return null;
  }
  function padDir(gp) {
    var b = gp.buttons || [];
    function pressed(i) { return !!(b[i] && b[i].pressed); }
    if (pressed(12)) return 'atas';
    if (pressed(13)) return 'bawah';
    if (pressed(14)) return 'kiri';
    if (pressed(15)) return 'kanan';
    var ax = (gp.axes && gp.axes.length > 1) ? gp.axes : [0, 0];
    var x = Number(ax[0]) || 0, y = Number(ax[1]) || 0;
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return null;
    if (Math.abs(x) > Math.abs(y)) return x > 0 ? 'kanan' : 'kiri';
    return y > 0 ? 'bawah' : 'atas';
  }
  function padPoll() {
    var gp = firstPad();
    var txt = gp ? ('\U0001F3AE Gamepad: ' + String(gp.id || 'tanpa nama').slice(0, 32) + '.') : '\U0001F3AE Gamepad: tidak terdeteksi.';
    if (txt !== padLastText) { padLastText = txt; els.gamepadStatus.textContent = txt; }
    var dir = gp ? padDir(gp) : null;
    if (!canControl()) dir = null;
    if (dir) {
      padPrevDir = dir;
      if ($('page-controlpad').classList.contains('page-hidden')) switchToPage('page-controlpad');
      dpadPress(dir);
    } else if (padPrevDir) {
      if (state.dpadDir === padPrevDir) dpadRelease();
      padPrevDir = null;
    }
  }
  window.addEventListener('gamepadconnected', function (e) {
    var name = (e.gamepad && e.gamepad.id) ? e.gamepad.id.slice(0, 40) : '?';
    logActivity('Gamepad terhubung: ' + name, 'sys');
    toast('Gamepad terhubung \u2014 pakai D-Pad / analog kiri.', 'success');
  });
  window.addEventListener('gamepaddisconnected', function () {
    if (padPrevDir && state.dpadDir === padPrevDir) dpadRelease();
    padPrevDir = null;
    logActivity('Gamepad dilepas.', 'sys');
  });

  /* ================= WAKE LOCK ================= */
  var wakeSentinel = null;
  function wakeAcquire() {
    if (!state.ui.wakeLock || !('wakeLock' in navigator)) return;
    if (wakeSentinel) return;
    try {
      navigator.wakeLock.request('screen').then(function (s) {
        wakeSentinel = s;
        wakeSentinel.addEventListener('release', function () { wakeSentinel = null; });
        logActivity('Wake Lock aktif \u2014 layar dijaga menyala.', 'sys');
      }).catch(function (err) {
        logActivity('Wake Lock gagal: ' + (err && err.message ? err.message : err), 'warn');
      });
    } catch (e) { /* abaikan */ }
  }
  function wakeRelease() {
    if (wakeSentinel) {
      try { wakeSentinel.release(); } catch (e) { /* abaikan */ }
      wakeSentinel = null;
    }
  }
  function setWakeLock(v) {
    state.ui.wakeLock = !!v && ('wakeLock' in navigator);
    els.setWakeLock.checked = state.ui.wakeLock;
    saveUI();
    if (state.ui.wakeLock) {
      if (isConnected() || state.demo) wakeAcquire();
      toast('Layar dijaga menyala selama sesi.', 'success');
    } else {
      wakeRelease();
    }
    logActivity('Jaga layar menyala: ' + (state.ui.wakeLock ? 'ON' : 'OFF') + '.', 'sys');
  }
  els.setWakeLock.addEventListener('change', function (e) { setWakeLock(e.target.checked); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.ui.wakeLock && (isConnected() || state.demo)) wakeAcquire();
  });

  /* ================= WEB BLUETOOTH ================= */
  function bleStatus() {
    if (!('bluetooth' in navigator)) return 'unsupported';
    if (window.isSecureContext === false) return 'insecure';
    return 'ok';
  }

  function setupCharacteristics(service) {
    return service.getCharacteristics().catch(function () { return []; }).then(function (all) {
      var notifyChar = null, writeChar = null;
      var byUuid = {};
      all.forEach(function (c) {
        try { byUuid[String(c.uuid).toLowerCase()] = c; } catch (e) { /* abaikan */ }
      });
      // Deteksi berdasarkan properti (bukan sekadar UUID) — tahan terhadap
      // firmware standar (0002 tulis / 0003 notify) maupun yang tertukar.
      all.forEach(function (c) {
        var p = c.properties || {};
        if (!notifyChar && (p.notify || p.indicate)) notifyChar = c;
      });
      all.forEach(function (c) {
        var p = c.properties || {};
        if (!writeChar && (p.write || p.writeWithoutResponse)) writeChar = c;
      });
      // Fallback: cocokkan UUID yang dikenal.
      if (!notifyChar) notifyChar = byUuid[KNOWN_CHAR_UUIDS[0]] || byUuid[KNOWN_CHAR_UUIDS[1]] || null;
      if (!writeChar) writeChar = byUuid[KNOWN_CHAR_UUIDS[1]] || byUuid[KNOWN_CHAR_UUIDS[0]] || null;

      var needDirect = [];
      if (!notifyChar || !writeChar) needDirect = KNOWN_CHAR_UUIDS.slice();
      var chain = Promise.resolve();
      needDirect.forEach(function (uuid) {
        chain = chain.then(function () {
          if (notifyChar && writeChar) return;
          return service.getCharacteristic(uuid).then(function (c) {
            var p = c.properties || {};
            if (!notifyChar && (p.notify || p.indicate)) notifyChar = c;
            if (!writeChar && (p.write || p.writeWithoutResponse)) writeChar = c;
            if (!notifyChar) notifyChar = c;
            else if (!writeChar && c !== notifyChar) writeChar = c;
          }).catch(function () { /* UUID ini tidak ada — lanjut */ });
        });
      });
      return chain.then(function () {
        if (!notifyChar) throw new Error('Karakteristik notifikasi tidak ditemukan di UART service.');
        if (!writeChar) throw new Error('Karakteristik tulis tidak ditemukan di UART service.');
        return notifyChar.startNotifications().then(function () {
          // Hapus dulu listener lama: mencegah parsing ganda saat reconnect
          // memakai ulang objek karakteristik yang sama.
          notifyChar.removeEventListener('characteristicvaluechanged', handleIncomingData);
          // Abaikan penyelesaian yang terlambat (upaya sudah timeout/dibatalkan).
          if (!state.connecting && !state.connected) {
            throw new Error('Koneksi dibatalkan (timeout).');
          }
          notifyChar.addEventListener('characteristicvaluechanged', handleIncomingData);
          state.notifyChar = notifyChar;
          state.writeChar = writeChar;
          logActivity('Karakteristik siap — notify: 0x' + shortUuid(notifyChar.uuid) +
            ', tulis: 0x' + shortUuid(writeChar.uuid) + '.', 'sys');
        });
      });
    });
  }

  els.connectBtn.addEventListener('click', function () {
    ensureAudio(); // siapkan audio (untuk suara notifikasi) dalam gestur pengguna
    if (state.demo) { toast('Matikan Mode Demo dulu sebelum memakai Bluetooth.', 'warn'); return; }
    if (state.connecting) return;
    stopAutoLoop(); // aksi manual selalu membatalkan loop auto-reconnect
    if (isConnected() && state.device) {
      state.wantDisconnect = true; // jangan picu auto-reconnect
      try { state.device.gatt.disconnect(); } catch (e) { onDisconnected(); }
      return;
    }
    connect();
  });

  function connect() {
    var support = bleStatus();
    if (support === 'unsupported') {
      setStatus('Tidak Didukung', 'error');
      logActivity('Browser ini tidak mendukung Web Bluetooth. Gunakan Chrome/Edge, atau aktifkan Mode Demo.', 'err');
      toast('Browser tidak mendukung Web Bluetooth. Coba Mode Demo.', 'error');
      showBleBanner('Browser ini tidak mendukung Web Bluetooth. Gunakan Chrome/Edge terbaru, atau:');
      return;
    }
    if (support === 'insecure') {
      setStatus('Gagal Terhubung', 'error');
      logActivity('Web Bluetooth butuh konteks aman (HTTPS atau localhost).', 'err');
      toast('Halaman harus dibuka via HTTPS/localhost untuk Bluetooth.', 'error');
      return;
    }

    state.connecting = true;
    els.connectBtn.disabled = true;
    els.connectBtn.textContent = 'Menghubungkan…';
    setStatus('Mencari…', 'busy');
    logActivity('Mencari perangkat Bluetooth…', 'sys');

    var device;
    var svc = state.conn.serviceUuid;
    navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: state.conn.namePrefix }, { services: [svc] }],
      optionalServices: [svc]
    }).then(function (d) {
      device = d;
      state.device = d;
      device.addEventListener('gattserverdisconnected', onDisconnected);
      setStatus('Menghubungkan…', 'busy');
      logActivity('Perangkat dipilih: ' + (device.name || '(tanpa nama)') + '. Menghubungkan GATT…', 'sys');
      return withTimeout(establishLink(device), CONNECT_TIMEOUT_MS, 'Timeout: micro:bit tidak merespons (30 dtk).');
    }).then(function () {
      finishConnect(false);
    }).catch(function (error) {
      state.connecting = false;
      els.connectBtn.disabled = false;
      els.connectBtn.textContent = 'Hubungkan ke Micro:bit';
      // Bersihkan koneksi GATT yang mungkin setengah jadi (mis. setelah timeout).
      if (device && device.gatt && device.gatt.connected) {
        try { device.gatt.disconnect(); } catch (e) { /* abaikan */ }
      }
      console.error(error);
      if (error && error.name === 'NotFoundError') {
        setStatus('Belum Terhubung', 'idle');
        logActivity('Pemilihan perangkat dibatalkan.', 'sys');
        return;
      }
      setStatus('Gagal Terhubung', 'error');
      logActivity('Error: ' + (error && error.message ? error.message : error), 'err');
      toast('Gagal terhubung: ' + (error && error.message ? error.message : error), 'error');
      notifySound('err');
    });
  }

  function onDisconnected() {
    var was = state.connected;
    var manual = state.wantDisconnect;
    state.wantDisconnect = false;
    state.connected = false;
    if (state.notifyChar) {
      try { state.notifyChar.removeEventListener('characteristicvaluechanged', handleIncomingData); }
      catch (e) { /* abaikan */ }
    }
    state.writeChar = null;
    state.notifyChar = null;
    state.rxBuffer = '';
    state.writeChain = Promise.resolve();
    resetFreshness();
    if (was) {
      setStatus('Terputus', 'idle');
      if (manual) {
        logActivity('Koneksi diputus oleh pengguna.', 'sys');
      } else {
        logActivity('Koneksi terputus di luar dugaan.', 'warn');
        notifySound('warn');
        if (state.auto.enabled && state.device && !state.demo) {
          startAutoLoop();
        } else {
          toast('Koneksi Bluetooth terputus.', 'warn');
        }
      }
    }
    els.connectBtn.textContent = 'Hubungkan ke Micro:bit';
    els.connectBtn.classList.remove('connected');
    els.connectBtn.disabled = false;
    els.statDevice.textContent = '—';
    els.statDevice.title = '';
    stopUptime();
    titleFlashStop();
    setControlsEnabled();
    updateAutoLabel();
  }

  /* ================= LINK BLE (dipakai manual & otomatis) ================= */
  function establishLink(device) {
    return device.gatt.connect().then(function (server) {
      logActivity('Terhubung ke GATT server. Membuka UART service…', 'sys');
      return server.getPrimaryService(state.conn.serviceUuid);
    }).then(function (service) {
      return setupCharacteristics(service);
    });
  }

  function finishConnect(fromAuto) {
    state.connected = true;
    state.connecting = false;
    state.connectStart = Date.now();
    startUptime();
    stopAutoLoop();
    setStatus('Terhubung', 'on');
    els.connectBtn.textContent = 'Putuskan Koneksi';
    els.connectBtn.classList.add('connected');
    els.connectBtn.disabled = false;
    els.statDevice.textContent = (state.device && state.device.name) || 'micro:bit';
    els.statDevice.title = els.statDevice.textContent;
    setControlsEnabled();
    updateAutoLabel();
    notifySound('ok');
    if (fromAuto) {
      logActivity('Tersambung ulang otomatis ke ' + els.statDevice.textContent + '.', 'sys');
      toast('Tersambung ulang otomatis.', 'success');
    } else {
      logActivity('Siap menerima dan mengirim data.', 'sys');
      toast('Terhubung ke ' + els.statDevice.textContent + '.', 'success');
    }
  }

  /* ================= AUTO-RECONNECT ================= */
  function updateAutoLabel() {
    var el = els.autoReconnStatus;
    el.classList.remove('working');
    if (!state.auto.enabled) { el.textContent = 'Nonaktif'; return; }
    if (state.demo || isConnected()) { el.textContent = 'Aktif • siaga'; return; }
    if (state.auto.running) {
      el.classList.add('working');
      if (state.connecting) {
        el.textContent = 'Menghubungkan… (upaya ' + state.auto.attempts + '/' + state.conn.maxAttempts + ')';
        return;
      }
      var wait = Math.max(0, Math.ceil((state.auto.nextAt - Date.now()) / 1000));
      el.textContent = 'Upaya ke-' + (state.auto.attempts + 1) + ' dalam ' + wait + ' dtk';
      return;
    }
    if (state.auto.gaveUp) { el.textContent = 'Berhenti • ' + state.conn.maxAttempts + ' upaya gagal'; return; }
    el.textContent = state.device ? 'Aktif • menunggu' : 'Aktif • belum ada perangkat';
  }

  function startAutoLoop() {
    if (!state.auto.enabled || !state.device || state.demo) return;
    if (state.auto.running) return;
    state.auto.running = true;
    state.auto.gaveUp = false;
    state.auto.attempts = 0;
    state.auto.nextAt = Date.now() + AUTO_BACKOFF[0];
    setStatus('Menyambung ulang…', 'busy');
    logActivity('Auto-reconnect aktif — mencoba sambung ulang (maks. ' + state.conn.maxAttempts + ' upaya).', 'sys');
    toast('Koneksi putus — mencoba sambung ulang otomatis…', 'warn');
    updateAutoLabel();
  }

  function stopAutoLoop() {
    state.auto.running = false;
    state.auto.attempts = 0;
    state.auto.gaveUp = false;
    updateAutoLabel();
  }

  function setAutoEnabled(v) {
    v = !!v;
    state.auto.enabled = v;
    els.autoReconnToggle.checked = v;
    els.setAutoToggle.checked = v;
    try { localStorage.setItem(AUTORECONN_KEY, v ? '1' : '0'); } catch (err) { /* abaikan */ }
    if (v) {
      state.auto.gaveUp = false;
      logActivity('Auto-reconnect dinyalakan.', 'sys');
      // Jika sedang terputus dan sudah pernah memilih perangkat, langsung mulai loop.
      if (!isConnected() && !state.demo && state.device && !state.connecting) startAutoLoop();
      else updateAutoLabel();
    } else {
      var wasRunning = state.auto.running;
      stopAutoLoop();
      logActivity('Auto-reconnect dimatikan.', 'sys');
      if (wasRunning && !isConnected()) setStatus('Terputus', 'idle');
    }
  }

  function autoTick() {
    if (!state.auto.running || !state.auto.enabled) return;
    if (state.demo || isConnected() || state.connecting || !state.device) { updateAutoLabel(); return; }
    if (Date.now() < state.auto.nextAt) { updateAutoLabel(); return; }
    state.auto.attempts++;
    if (state.auto.attempts > state.conn.maxAttempts) {
      state.auto.running = false;
      state.auto.gaveUp = true;
      setStatus('Terputus', 'idle');
      logActivity('Auto-reconnect berhenti setelah ' + state.conn.maxAttempts + ' upaya gagal.', 'err');
      toast('Auto-reconnect menyerah setelah ' + state.conn.maxAttempts + ' upaya.', 'error');
      notifySound('err');
      updateAutoLabel();
      return;
    }
    state.connecting = true;
    els.connectBtn.disabled = true;
    setStatus('Menyambung ulang (' + state.auto.attempts + ')…', 'busy');
    logActivity('Upaya sambung ulang ke-' + state.auto.attempts + '…', 'sys');
    updateAutoLabel();
    withTimeout(establishLink(state.device), AUTOCONNECT_TIMEOUT_MS, 'Timeout: micro:bit tidak merespons.').then(function () {
      finishConnect(true);
    }).catch(function (err) {
      state.connecting = false;
      els.connectBtn.disabled = false;
      if (!state.auto.running) {
        // Loop dibatalkan pengguna saat upaya berjalan — kembalikan status netral.
        setStatus('Terputus', 'idle');
        updateAutoLabel();
        return;
      }
      var delay = AUTO_BACKOFF[Math.min(state.auto.attempts, AUTO_BACKOFF.length - 1)];
      state.auto.nextAt = Date.now() + delay;
      setStatus('Menyambung ulang…', 'busy');
      logActivity('Upaya ke-' + state.auto.attempts + ' gagal (' +
        (err && err.message ? err.message : err) + '). Coba lagi dalam ' +
        Math.round(delay / 1000) + ' dtk.', 'warn');
      updateAutoLabel();
    });
  }

  els.autoReconnToggle.addEventListener('change', function (e) { setAutoEnabled(e.target.checked); });

  /* ================= REKAMAN SESI (CSV) ================= */
  function updateRecCount() {
    els.recCount.textContent = state.rec.rows.length.toLocaleString('id-ID') + ' data';
  }
  function recordRow() {
    state.rec.rows.push({
      t: new Date().toISOString(),
      suhu: state.rec.suhu, hum: state.rec.hum, mode: state.rec.mode,
      lampu: state.rec.lampu, kipas: state.rec.kipas
    });
    while (state.rec.rows.length > state.data.recordMax) state.rec.rows.shift();
    updateRecCount();
  }
  function exportCSV() {
    var rows = state.rec.rows;
    if (!rows.length) { toast('Belum ada data untuk diekspor.', 'warn'); return; }
    var out = ['waktu,suhu_c,kelembaban_pct,mode,lampu,kipas'];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      out.push([
        r.t,
        r.suhu === null ? '' : r.suhu,
        r.hum === null ? '' : r.hum,
        r.mode === null ? '' : r.mode,
        r.lampu === null ? '' : r.lampu,
        r.kipas === null ? '' : r.kipas
      ].join(','));
    }
    // BOM (﻿) agar Excel Windows langsung mengenali UTF-8.
    var blob = new Blob(['﻿' + out.join('\n')], { type: 'text/csv;charset=utf-8' });
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    var name = 'microbit-data-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.csv';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    logActivity(rows.length + ' baris data diekspor ke ' + name + '.', 'sys');
    toast('CSV diunduh (' + rows.length + ' baris).', 'success');
  }
  function clearRecording() {
    resetSessStats(true);
    state.rec.rows = [];
    updateRecCount();
    toast('Rekaman sesi dihapus.');
  }
  els.exportCsvBtn.addEventListener('click', exportCSV);
  els.clearRecBtn.addEventListener('click', clearRecording);

  /* ================= STATISTIK SESI ================= */
  function sessNew() { return { min: null, max: null, sum: 0, n: 0 }; }
  var sess = { suhu: sessNew(), hum: sessNew() };
  function sessPush(which, value) {
    var s = sess[which];
    if (s.min === null || value < s.min) s.min = value;
    if (s.max === null || value > s.max) s.max = value;
    s.sum += value; s.n++;
    sessRender();
  }
  function sessFmt(v, digits) { return (v === null || v === undefined) ? '\u2014' : Number(v).toFixed(digits); }
  function sessRender() {
    els.statSuhuMin.textContent = sessFmt(sess.suhu.min, 1);
    els.statSuhuMax.textContent = sessFmt(sess.suhu.max, 1);
    els.statSuhuAvg.textContent = sess.suhu.n ? sessFmt(sess.suhu.sum / sess.suhu.n, 1) : '\u2014';
    els.statHumMin.textContent = sessFmt(sess.hum.min, 0);
    els.statHumMax.textContent = sessFmt(sess.hum.max, 0);
    els.statHumAvg.textContent = sess.hum.n ? sessFmt(sess.hum.sum / sess.hum.n, 0) : '\u2014';
  }
  function resetSessStats(silent) {
    sess = { suhu: sessNew(), hum: sessNew() };
    sessRender();
    if (!silent) { logActivity('Statistik sesi di-reset.', 'sys'); toast('Statistik sesi di-reset.'); }
  }
  els.statResetBtn.addEventListener('click', function () { resetSessStats(false); });

  /* ================= PENANDA DATA BASI ================= */
  var FRESH_SENSORS = [
    { key: 'suhu', widget: 'suhuWidget', age: 'suhuAge', label: 'suhu' },
    { key: 'kelembaban', widget: 'humWidget', age: 'humAge', label: 'kelembaban' }
  ];
  function staleMs() { return state.data.staleSec * 1000; }
  function freshMark(key) {
    state.lastSeen[key] = Date.now();
    if (state.staleFlag[key]) {
      state.staleFlag[key] = false;
      logActivity('Data ' + key + ' mengalir kembali.', 'sys');
    }
  }
  function resetFreshness() {
    state.lastSeen.suhu = 0;
    state.lastSeen.kelembaban = 0;
    state.staleFlag.suhu = false;
    state.staleFlag.kelembaban = false;
    FRESH_SENSORS.forEach(function (s) {
      els[s.age].textContent = '· —';
      els[s.age].classList.remove('stale');
      els[s.widget].classList.remove('stale');
    });
  }
  function ageText(ms) {
    var s = Math.floor(ms / 1000);
    if (s < 2) return 'baru saja';
    if (s < 60) return s + ' dtk lalu';
    return Math.floor(s / 60) + ' mnt lalu';
  }
  function freshTick() {
    var live = canControl();
    FRESH_SENSORS.forEach(function (s) {
      var ageEl = els[s.age], wEl = els[s.widget];
      var last = state.lastSeen[s.key];
      if (!live) {
        ageEl.textContent = '· —';
        ageEl.classList.remove('stale');
        wEl.classList.remove('stale');
        return;
      }
      if (!last) return; // belum pernah ada data — biarkan "· —"
      var age = Date.now() - last;
      if (age > staleMs()) {
        ageEl.textContent = '· BASI ' + ageText(age);
        ageEl.classList.add('stale');
        wEl.classList.add('stale');
        if (!state.staleFlag[s.key]) {
          state.staleFlag[s.key] = true;
          logActivity('Data ' + s.label + ' basi (>' + state.data.staleSec + ' dtk tanpa update).', 'warn');
          toast('Data ' + s.label + ' basi — periksa micro:bit.', 'warn');
        }
      } else {
        ageEl.textContent = '· ' + ageText(age);
        ageEl.classList.remove('stale');
        wEl.classList.remove('stale');
      }
    });
  }

  /* ================= AUDIO ================= */
  var PAGE_TITLE = document.title;
  var audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(function () { /* butuh gestur pengguna */ });
    }
    return audioCtx;
  }
  function playAlarmSound(times) {
    if (!state.alarm.sound || state.alarm.volume <= 0) return;
    var ctx = ensureAudio();
    if (!ctx) return;
    try {
      var peak = Math.max(0.0002, 0.22 * (state.alarm.volume / 100));
      var t = ctx.currentTime + 0.01;
      for (var i = 0; i < (times || 2); i++) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'square';
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(peak, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        o.connect(g); g.connect(ctx.destination);
        o.start(t); o.stop(t + 0.2);
        t += 0.26;
      }
    } catch (e) { /* abaikan: audio tidak tersedia */ }
  }
  // Bunyi notifikasi koneksi (lembut, nada sine). Tidak memaksa resume audio —
  // jika browser menahan (tanpa gestur), ya sudah: tidak bunyi, tidak error.
  function notifySound(kind) {
    if (!state.ui.sounds) return;
    var ctx = ensureAudio();
    if (!ctx || ctx.state !== 'running') return;
    try {
      var notes = kind === 'ok' ? [660, 880] : kind === 'err' ? [330, 220] : [440];
      var t = ctx.currentTime + 0.01;
      notes.forEach(function (f) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.connect(g); g.connect(ctx.destination);
        o.start(t); o.stop(t + 0.18);
        t += 0.15;
      });
    } catch (e) { /* abaikan */ }
  }

  /* ================= ALARM SUHU ================= */
  function setAlarmUI() {
    var st = els.alarmState;
    st.classList.remove('armed', 'firing');
    if (state.alarm.active) {
      st.textContent = 'ALARM!';
      st.classList.add('firing');
      els.suhuWidget.classList.add('alarming');
      document.title = '🔴 ALARM SUHU — micro:bit';
    } else if (state.alarm.enabled) {
      st.textContent = 'SIAGA ≥ ' + state.alarm.threshold + '°C';
      st.classList.add('armed');
      els.suhuWidget.classList.remove('alarming');
      document.title = PAGE_TITLE;
    } else {
      st.textContent = 'NONAKTIF';
      els.suhuWidget.classList.remove('alarming');
      document.title = PAGE_TITLE;
    }
  }
  function saveAlarm() {
    try {
      localStorage.setItem(ALARM_KEY, JSON.stringify({
        enabled: state.alarm.enabled,
        threshold: state.alarm.threshold,
        sound: state.alarm.sound,
        volume: state.alarm.volume,
        bgNotif: state.alarm.bgNotif
      }));
    } catch (e) { /* abaikan */ }
  }
  function setAlarmEnabled(v) {
    v = !!v;
    state.alarm.enabled = v;
    els.alarmEnabled.checked = v;
    els.setAlarmEnabled.checked = v;
    ensureAudio(); // gestur pengguna: bangunkan AudioContext
    if (!v && state.alarm.active) {
      state.alarm.active = false;
      logActivity('Alarm dimatikan manual saat berbunyi.', 'sys');
    }
    saveAlarm();
    setAlarmUI();
    if (v) {
      logActivity('Alarm suhu dinyalakan (ambang ≥ ' + state.alarm.threshold + '°C).', 'sys');
      if (state.lastSuhu !== null) checkAlarm(state.lastSuhu);
    } else {
      logActivity('Alarm suhu dimatikan.', 'sys');
    }
  }
  function setAlarmThreshold(v) {
    v = Number(v);
    if (!isFinite(v)) v = 35;
    v = clamp(Math.round(v * 2) / 2, -40, 85);
    state.alarm.threshold = v;
    els.alarmThreshold.value = v;
    els.setAlarmThreshold.value = v;
    saveAlarm();
    setAlarmUI();
    if (state.lastSuhu !== null) checkAlarm(state.lastSuhu);
  }
  function setAlarmSound(v) {
    state.alarm.sound = !!v;
    els.alarmSound.checked = state.alarm.sound;
    els.setAlarmSound.checked = state.alarm.sound;
    saveAlarm();
  }
  function setAlarmVolume(v, save) {
    v = clamp(Math.round(Number(v) || 0), 0, 100);
    state.alarm.volume = v;
    els.setAlarmVolume.value = v;
    els.setAlarmVolumeVal.textContent = v + '%';
    els.setAlarmVolume.style.setProperty('--fill', v + '%');
    if (save !== false) saveAlarm();
  }
  function testAlarmSound() {
    ensureAudio();
    if (!state.alarm.sound) { toast('Suara alarm sedang dimatikan.', 'warn'); return; }
    if (state.alarm.volume <= 0) { toast('Volume alarm 0% — besarkan dulu.', 'warn'); return; }
    playAlarmSound(2);
    toast('Tes bunyi alarm dimainkan.');
  }
  var titleTimer = null;
  var origTitle = document.title;
  function titleFlashStart(msg) {
    titleFlashStop();
    var show = false;
    titleTimer = setInterval(function () {
      show = !show;
      document.title = show ? msg : origTitle;
    }, 1000);
  }
  function titleFlashStop() {
    if (titleTimer) { clearInterval(titleTimer); titleTimer = null; }
    document.title = origTitle;
  }
  function bgAlarmNotify(value) {
    if (!state.alarm.bgNotif) return;
    try {
      if ('vibrate' in navigator) navigator.vibrate([200, 100, 200]);
    } catch (e) { /* abaikan */ }
    titleFlashStart('\u{1F6A8} ALARM SUHU ' + value + '\u00B0C!');
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification('\u{1F6A8} Alarm Suhu micro:bit', {
          body: 'Suhu ' + value + '\u00B0C melewati ambang ' + state.alarm.threshold + '\u00B0C!',
          tag: 'microbit-alarm'
        });
      } catch (e) { /* abaikan */ }
    }
  }
  function setBgNotif(v) {
    state.alarm.bgNotif = !!v;
    els.setBgNotif.checked = state.alarm.bgNotif;
    saveAlarm();
    if (state.alarm.bgNotif && 'Notification' in window && Notification.permission === 'default') {
      try {
        Notification.requestPermission().then(function (perm) {
          if (perm !== 'granted') toast('Izin notifikasi ditolak \u2014 hanya getar + judul berkedip yang aktif.', 'warn');
        });
      } catch (e) { /* abaikan */ }
    }
    logActivity('Notifikasi latar: ' + (state.alarm.bgNotif ? 'ON' : 'OFF') + '.', 'sys');
  }
  els.setBgNotif.addEventListener('change', function (e) { setBgNotif(e.target.checked); });

  function checkAlarm(value) {
    var a = state.alarm;
    if (!a.enabled) {
      if (a.active) { a.active = false; setAlarmUI(); titleFlashStop(); }
      return;
    }
    if (!a.active && value >= a.threshold) {
      a.active = true;
      a.lastBeep = Date.now();
      setAlarmUI();
      playAlarmSound(3);
      logActivity('🚨 ALARM: suhu ' + value + '°C ≥ ' + a.threshold + '°C!', 'err');
      toast('ALARM: suhu ' + value + '°C!', 'error');
      bgAlarmNotify(value);
    } else if (a.active && value < a.threshold - ALARM_HYST) {
      a.active = false;
      setAlarmUI();
      logActivity('Suhu kembali normal (' + value + '°C). Alarm berhenti.', 'sys');
      toast('Suhu normal kembali.', 'success');
      titleFlashStop();
    } else if (a.active && a.sound && Date.now() - a.lastBeep > ALARM_REPEAT_MS) {
      a.lastBeep = Date.now();
      playAlarmSound(2);
    }
  }
  els.alarmEnabled.addEventListener('change', function (e) { setAlarmEnabled(e.target.checked); });
  els.alarmThreshold.addEventListener('change', function (e) { setAlarmThreshold(e.target.value); });
  els.alarmSound.addEventListener('change', function (e) { setAlarmSound(e.target.checked); });
  els.alarmTestBtn.addEventListener('click', testAlarmSound);
  function loadAlarmSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(ALARM_KEY) || '{}');
      if (typeof s.threshold === 'number' && isFinite(s.threshold)) {
        state.alarm.threshold = clamp(s.threshold, -40, 85);
      }
      state.alarm.sound = s.sound !== false;
      state.alarm.enabled = !!s.enabled;
      state.alarm.bgNotif = !!s.bgNotif && ('Notification' in window);
      if (typeof s.volume === 'number' && isFinite(s.volume)) {
        state.alarm.volume = clamp(Math.round(s.volume), 0, 100);
      }
    } catch (e) { /* abaikan: pakai default */ }
    els.alarmThreshold.value = state.alarm.threshold;
    els.alarmSound.checked = state.alarm.sound;
    els.alarmEnabled.checked = state.alarm.enabled;
    els.setAlarmThreshold.value = state.alarm.threshold;
    els.setAlarmSound.checked = state.alarm.sound;
    els.setBgNotif.checked = state.alarm.bgNotif;
    els.setAlarmEnabled.checked = state.alarm.enabled;
    setAlarmVolume(state.alarm.volume, false);
    setAlarmUI();
  }

  /* ================= MODE DEMO ================= */
  var demoSuhu = 27, demoHum = 62, demoTick = 0;
  function simulateRx(line) {
    state.rx++; updateStats();
    logActivity('Masuk: ' + line, 'rx');
    parseLine(line);
  }
  function demoLoopback(cmd) {
    var lc = cmd.toLowerCase();
    if (lc === 'stop' || lc === 'atas' || lc === 'bawah' || lc === 'kiri' || lc === 'kanan') return;
    var idx = lc.indexOf(':');
    if (idx > 0) {
      var k = lc.slice(0, idx), v = lc.slice(idx + 1);
      if ((k === 'lampu' || k === 'kipas') && v !== '') {
        setTimeout(function () { if (state.demo) simulateRx(k + ':' + v); }, 150);
      }
    }
  }
  function startDemo() {
    if (isConnected()) { toast('Putuskan koneksi BLE dulu untuk memakai Mode Demo.', 'warn'); return; }
    if (state.demo) return;
    state.demo = true;
    stopAutoLoop();
    resetFreshness();
    state.connectStart = Date.now();
    demoTick = 0;
    startUptime();
    setStatus('Mode Demo', 'demo');
    els.demoBtn.classList.add('active');
    els.demoBtn.textContent = 'Stop Demo';
    els.statDevice.textContent = 'Demo Virtual';
    els.statDevice.title = 'Demo Virtual';
    setControlsEnabled();
    hideBleBanner();
    updateAutoLabel();
    logActivity('Mode Demo aktif — data sensor disimulasikan tiap 1 detik.', 'sys');
    toast('Mode Demo aktif.', 'success');
    state.demoTimer = setInterval(function () {
      demoTick++;
      demoSuhu = clamp(demoSuhu + (Math.random() * 1.2 - 0.6), 24, 33);
      demoHum = clamp(demoHum + (Math.random() * 2 - 1), 50, 80);
      simulateRx('suhu:' + demoSuhu.toFixed(1));
      simulateRx('kelembaban:' + Math.round(demoHum));
      if (demoTick % 6 === 0) simulateRx('mode:' + (demoTick % 12 === 0 ? 0 : 1));
    }, 1000);
  }
  function stopDemo(silent) {
    if (!state.demo) return;
    state.demo = false;
    if (state.demoTimer) { clearInterval(state.demoTimer); state.demoTimer = null; }
    stopUptime();
    titleFlashStop();
    resetFreshness();
    setStatus('Belum Terhubung', 'idle');
    els.demoBtn.classList.remove('active');
    els.demoBtn.textContent = 'Mode Demo';
    els.statDevice.textContent = '—';
    els.statDevice.title = '';
    setControlsEnabled();
    // Selesai demo: jika auto-reconnect menunggu perangkat BLE, lanjutkan loop-nya.
    if (state.auto.enabled && state.device && !state.connecting) startAutoLoop();
    else updateAutoLabel();
    if (!silent) { logActivity('Mode Demo dimatikan.', 'sys'); toast('Mode Demo dimatikan.'); }
  }
  els.demoBtn.addEventListener('click', function () {
    ensureAudio();
    if (state.demo) stopDemo(false); else startDemo();
  });

  /* ================= BANNER BLE ================= */
  function showBleBanner(msg) {
    els.bleWarnText.textContent = msg;
    els.bleWarn.hidden = false;
  }
  function hideBleBanner() { els.bleWarn.hidden = true; }
  els.bleWarnClose.addEventListener('click', hideBleBanner);
  els.bleWarnDemo.addEventListener('click', function () { startDemo(); });

  /* ================= PANDUAN: SALIN KODE ================= */
  els.guideCopyBtn.addEventListener('click', function () {
    var text = els.guideCode.textContent;
    function done() {
      els.guideCopyBtn.textContent = 'Tersalin ✓';
      setTimeout(function () { els.guideCopyBtn.textContent = 'Salin kode'; }, 1800);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  });

  /* ================= PENGATURAN ================= */
  function saveConn() { try { localStorage.setItem(CONN_KEY, JSON.stringify(state.conn)); } catch (e) { /* abaikan */ } }
  function saveUI() { try { localStorage.setItem(UI_KEY, JSON.stringify(state.ui)); } catch (e) { /* abaikan */ } }
  function saveDataCfg() { try { localStorage.setItem(DATA_KEY, JSON.stringify(state.data)); } catch (e) { /* abaikan */ } }

  function loadConnSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(CONN_KEY) || '{}');
      if (typeof s.namePrefix === 'string' && s.namePrefix.trim()) {
        state.conn.namePrefix = s.namePrefix.trim().slice(0, 40);
      }
      if (typeof s.serviceUuid === 'string' && UUID_RE.test(s.serviceUuid.trim())) {
        state.conn.serviceUuid = s.serviceUuid.trim().toLowerCase();
      }
      if (isFinite(s.maxAttempts)) state.conn.maxAttempts = clamp(Math.round(s.maxAttempts), 1, 20);
    } catch (e) { /* abaikan: pakai default */ }
    els.setNamePrefix.value = state.conn.namePrefix;
    els.setServiceUuid.value = state.conn.serviceUuid;
    els.setMaxAttempts.value = state.conn.maxAttempts;
  }
  function loadUISettings() {
    try {
      var s = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
      if (isFinite(s.maxPoints)) state.ui.maxPoints = clamp(Math.round(s.maxPoints), 10, 100);
      if (s.toastMs === 2000 || s.toastMs === 4000 || s.toastMs === 8000) state.ui.toastMs = s.toastMs;
      state.ui.sounds = s.sounds !== false;
      state.ui.wakeLock = !!s.wakeLock && ('wakeLock' in navigator);
    } catch (e) { /* abaikan: pakai default */ }
    els.setMaxPoints.value = state.ui.maxPoints;
    els.setToastDur.value = String(state.ui.toastMs);
    els.setNotifSound.checked = state.ui.sounds;
    els.setWakeLock.checked = state.ui.wakeLock;
    if (!('wakeLock' in navigator)) {
      els.setWakeLock.disabled = true;
      els.wakeDesc.textContent = 'Browser ini tidak mendukung Wake Lock.';
    }
  }
  function loadDataSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(DATA_KEY) || '{}');
      if (isFinite(s.staleSec)) state.data.staleSec = clamp(Math.round(s.staleSec), 2, 60);
      if (isFinite(s.recordMax)) state.data.recordMax = clamp(Math.round(s.recordMax), 1000, 50000);
    } catch (e) { /* abaikan: pakai default */ }
    els.setStaleSec.value = state.data.staleSec;
    els.setRecordMax.value = state.data.recordMax;
  }

  els.setAutoToggle.addEventListener('change', function (e) { setAutoEnabled(e.target.checked); });
  els.setMaxAttempts.addEventListener('change', function (e) {
    var v = clamp(Math.round(Number(e.target.value) || AUTO_MAX_ATTEMPTS), 1, 20);
    e.target.value = v;
    state.conn.maxAttempts = v;
    saveConn();
    updateAutoLabel();
    logActivity('Upaya maksimum auto-reconnect: ' + v + '.', 'sys');
  });
  els.setNamePrefix.addEventListener('change', function (e) {
    var v = e.target.value.trim().slice(0, 40);
    if (!v) {
      e.target.value = state.conn.namePrefix;
      toast('Prefiks nama tidak boleh kosong.', 'warn');
      return;
    }
    state.conn.namePrefix = v;
    e.target.value = v;
    saveConn();
    logActivity('Prefiks nama perangkat: "' + v + '" (berlaku koneksi berikutnya).', 'sys');
  });
  els.setServiceUuid.addEventListener('change', function (e) {
    var v = e.target.value.trim().toLowerCase();
    if (!UUID_RE.test(v)) {
      e.target.value = state.conn.serviceUuid;
      toast('Format UUID tidak valid — dikembalikan.', 'error');
      return;
    }
    state.conn.serviceUuid = v;
    e.target.value = v;
    saveConn();
    logActivity('UUID service diubah (berlaku koneksi berikutnya).', 'sys');
  });
  els.resetUuidBtn.addEventListener('click', function () {
    state.conn.serviceUuid = UART_SERVICE_UUID;
    els.setServiceUuid.value = UART_SERVICE_UUID;
    saveConn();
    logActivity('UUID service dikembalikan ke UART standar.', 'sys');
    toast('UUID dikembalikan ke UART standar.');
  });
  $all('input[name="setTheme"]').forEach(function (r) {
    r.addEventListener('change', function () { if (r.checked) applyTheme(r.value); });
  });
  els.setMaxPoints.addEventListener('change', function (e) {
    var v = clamp(Math.round(Number(e.target.value) || MAX_POINTS), 10, 100);
    e.target.value = v;
    state.ui.maxPoints = v;
    saveUI();
    trimCharts();
  });
  els.setToastDur.addEventListener('change', function (e) {
    state.ui.toastMs = Number(e.target.value) || 4000;
    saveUI();
    toast('Durasi notifikasi: ' + (state.ui.toastMs / 1000) + ' detik.');
  });
  els.setAlarmEnabled.addEventListener('change', function (e) { setAlarmEnabled(e.target.checked); });
  els.setAlarmThreshold.addEventListener('change', function (e) { setAlarmThreshold(e.target.value); });
  els.setAlarmSound.addEventListener('change', function (e) { setAlarmSound(e.target.checked); });
  els.setNotifSound.addEventListener('change', function (e) {
    state.ui.sounds = e.target.checked;
    saveUI();
  });
  els.setAlarmVolume.addEventListener('input', function (e) { setAlarmVolume(e.target.value, false); });
  els.setAlarmVolume.addEventListener('change', function (e) { setAlarmVolume(e.target.value, true); });
  els.setAlarmTestBtn.addEventListener('click', testAlarmSound);
  els.setStaleSec.addEventListener('change', function (e) {
    var v = clamp(Math.round(Number(e.target.value) || 5), 2, 60);
    e.target.value = v;
    state.data.staleSec = v;
    saveDataCfg();
    logActivity('Batas data basi: ' + v + ' detik.', 'sys');
  });
  els.setRecordMax.addEventListener('change', function (e) {
    var v = clamp(Math.round(Number(e.target.value) || RECORD_MAX), 1000, 50000);
    e.target.value = v;
    state.data.recordMax = v;
    saveDataCfg();
    while (state.rec.rows.length > v) state.rec.rows.shift();
    updateRecCount();
    logActivity('Maksimum baris rekaman: ' + v.toLocaleString('id-ID') + '.', 'sys');
  });
  els.setExportCsvBtn.addEventListener('click', exportCSV);
  els.setClearRecBtn.addEventListener('click', clearRecording);

  /* ---- Backup & restore konfigurasi ---- */
  function downloadFile(name, text, mime) {
    var blob = new Blob([text], { type: mime });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function localStamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  els.exportCfgBtn.addEventListener('click', function () {
    var data = {
      app: 'microbit-control-panel', version: 1,
      exportedAt: new Date().toISOString(), settings: {}
    };
    SETTING_KEYS.forEach(function (k) {
      try { data.settings[k] = localStorage.getItem(k); }
      catch (e) { data.settings[k] = null; }
    });
    downloadFile('microbit-config-' + localStamp() + '.json', JSON.stringify(data, null, 2), 'application/json');
    logActivity('Konfigurasi diekspor ke JSON.', 'sys');
    toast('File konfigurasi diunduh.', 'success');
  });
  els.importCfgBtn.addEventListener('click', function () { els.importFile.click(); });
  els.importFile.addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = ''; // izinkan file yang sama dipilih ulang
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!data || data.app !== 'microbit-control-panel' || typeof data.settings !== 'object' || !data.settings) {
          throw new Error('Bukan file konfigurasi panel ini.');
        }
        var applied = 0, skipped = 0;
        SETTING_KEYS.forEach(function (k) {
          var raw = data.settings[k];
          if (raw === null || raw === undefined) return; // kunci tak ada — biarkan nilai lama
          if (k === THEME_KEY) {
            if (typeof raw !== 'string') { skipped++; return; }
            raw = normalizeTheme(raw);
          } else if (k === AUTORECONN_KEY) {
            if (raw !== '1' && raw !== '0') { skipped++; return; }
          } else {
            try {
              var o = JSON.parse(raw);
              if (typeof o !== 'object' || o === null) throw new Error('bad');
            } catch (err2) { skipped++; return; }
          }
          try { localStorage.setItem(k, raw); applied++; }
          catch (err3) { skipped++; }
        });
        logActivity('Impor konfigurasi: ' + applied + ' diterapkan, ' + skipped + ' dilewati. Memuat ulang…', 'sys');
        toast('Konfigurasi diimpor — memuat ulang…', 'success');
        setTimeout(function () { location.reload(); }, 800);
      } catch (err) {
        toast('Gagal impor: ' + err.message, 'error');
        logActivity('Gagal impor konfigurasi: ' + err.message, 'err');
      }
    };
    reader.onerror = function () { toast('Gagal membaca file.', 'error'); };
    reader.readAsText(file);
  });
  els.resetAllBtn.addEventListener('click', function () {
    var ok = confirm('Kembalikan SEMUA pengaturan ke default?\n\nKoneksi akan diputus dan halaman dimuat ulang.');
    if (!ok) return;
    try {
      SETTING_KEYS.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { /* abaikan */ }
    location.reload();
  });

  /* ================= TIK DETIKAN ================= */
  var lastRxCount = 0;
  function tickSecond() {
    freshTick();
    autoTick();
    var rate = state.rx - lastRxCount;
    lastRxCount = state.rx;
    els.statRxRate.textContent = rate + ' pkt/dtk';
  }

  /* ================= INIT ================= */
  chartSuhu = createChart('suhuChart', '#ff8a5c', 50);
  chartKelembaban = createChart('kelembabanChart', '#5eead4', 100);
  applyTheme(document.documentElement.getAttribute('data-theme') || 'default', false);
  setKipasUI(0);
  setControlsEnabled();
  updateStats();
  loadAlarmSettings();
  loadConnSettings();
  loadUISettings();
  loadDataSettings();
  loadFanSettings();
  try { state.auto.enabled = localStorage.getItem(AUTORECONN_KEY) === '1'; }
  catch (e) { state.auto.enabled = false; }
  els.autoReconnToggle.checked = state.auto.enabled;
  els.setAutoToggle.checked = state.auto.enabled;
  updateAutoLabel();
  updateRecCount();
  setInterval(tickSecond, 1000);
  setInterval(flushCharts, CHART_FLUSH_MS);
  setInterval(padPoll, 120);
  sessRender();
  if (bleStatus() === 'unsupported') {
    showBleBanner('Browser ini tidak mendukung Web Bluetooth (butuh Chrome/Edge). Kamu tetap bisa mencoba semua fitur lewat:');
  } else if (bleStatus() === 'insecure') {
    showBleBanner('Halaman ini tidak dibuka via HTTPS/localhost, sehingga Web Bluetooth diblokir browser. Sementara itu kamu bisa memakai:');
  }

  /* ================= GESTUR TANGAN — runtime resmi Teachable Machine (@teachablemachine/image) ================= */
  var GEST_STORE = 'microbitGesture2';
  var GEST_DEFAULTS = {
    url: 'https://teachablemachine.withgoogle.com/models/dLWidtkCQ/',
    mirror: true, send: true,
    conf: 0.65, holdMs: 150, cooldownMs: 900,
    map: {}
  };
  var GEST_ACTIONS = {
    none:    { text: '— (tanpa aksi)', mode: 'idle' },
    atas:    { text: 'Gerak: naik ▲',  mode: 'hold', dir: 'atas' },
    bawah:   { text: 'Gerak: turun ▼', mode: 'hold', dir: 'bawah' },
    kiri:    { text: 'Gerak: kiri ◀',  mode: 'hold', dir: 'kiri' },
    kanan:   { text: 'Gerak: kanan ▶', mode: 'hold', dir: 'kanan' },
    stop:    { text: 'Berhenti ■',     mode: 'once' },
    lampu:   { text: 'Lampu: nyalakan/matikan', mode: 'once' },
    fanup:   { text: 'Kipas: +15%',    mode: 'once' },
    fandown: { text: 'Kipas: −15%',    mode: 'once' }
  };
  var GEST_MIN_MS = 80;        // jarak antar prediksi (~12 fps)
  var GEST_RELEASE_GRACE = 260; // ms sebelum dianggap "lepas" (anti-kedip)

  function gestReadCfg() {
    try {
      var raw = localStorage.getItem(GEST_STORE);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p === 'object') {
          var c = Object.assign({}, GEST_DEFAULTS, p);
          c.map = (p.map && typeof p.map === 'object') ? p.map : {};
          return c;
        }
      }
    } catch (e) { /* abaikan */ }
    return JSON.parse(JSON.stringify(GEST_DEFAULTS));
  }

  var gest = {
    cfg: gestReadCfg(),
    model: null, modelUrl: null, labels: [],
    stream: null, running: false, loading: false, inFlight: false,
    rafId: 0, lastAt: 0, lastRateAt: 0, startedAt: 0, predCount: 0,
    frameErrors: 0, errShown: false, videoWarned: false,
    ema: {}, candidate: null, candidateSince: 0,
    accepted: null, unstableSince: 0, lastActionAt: {}, sendWarned: false
  };
  function gestSaveCfg() { try { localStorage.setItem(GEST_STORE, JSON.stringify(gest.cfg)); } catch (e) { /* abaikan */ } }

  var G = {
    stage: $('gestStage'), video: $('gestVideo'), badge: $('gestBadge'),
    startBtn: $('gestStartBtn'), stopBtn: $('gestStopBtn'),
    urlIn: $('gestUrlInput'), loadBtn: $('gestLoadBtn'),
    mirror: $('gestMirror'), status: $('gestStatus'),
    top: $('gestTop'), topLabel: $('gestTopLabel'), topConf: $('gestTopConf'),
    rate: $('gestRate'), stateLbl: $('gestState'), bars: $('gestBars'),
    conf: $('gestConf'), confVal: $('gestConfVal'),
    hold: $('gestHold'), holdVal: $('gestHoldVal'),
    cd: $('gestCd'), cdVal: $('gestCdVal'),
    mapWrap: $('gestMap'), send: $('gestSend')
  };
  G.urlIn.value = gest.cfg.url;

  function gestSetStatus(msg, isError) {
    G.status.textContent = msg;
    G.status.classList.toggle('err', !!isError);
  }
  function gestMapOf(label) {
    var k = gest.cfg.map[label];
    return GEST_ACTIONS[k] || GEST_ACTIONS[gestAutoMap(label)];
  }
  function gestAutoMap(label) {
    var s = String(label).toLowerCase();
    if (/stop|berhenti|diam|rest/.test(s)) return 'stop';
    if (/(^|[^a-z])(up|atas|naik|↑)([^a-z]|$)/.test(s)) return 'atas';
    if (/(^|[^a-z])(down|bawah|turun|↓)([^a-z]|$)/.test(s)) return 'bawah';
    if (/(^|[^a-z])(left|kiri|←)([^a-z]|$)/.test(s)) return 'kiri';
    if (/(^|[^a-z])(right|kanan|→)([^a-z]|$)/.test(s)) return 'kanan';
    if (/lampu|light|led/.test(s)) return 'lampu';
    if (/kipas|fan/.test(s)) return 'fanup';
    return 'none';
  }
  function gestNormalizeUrl(u) {
    u = String(u || '').trim();
    u = u.replace(/\/?model\.json\/?$/i, '');
    if (u && !/\/$/.test(u)) u += '/';
    return u;
  }

  /* --- pemuat runtime resmi TM dengan fallback CDN (lazy: tidak memperlambat halaman) --- */
  var tmPromise = null;
  function ensureTM() {
    if (window.tmImage) return Promise.resolve();
    if (tmPromise) return tmPromise;
    var sources = [
      'https://cdn.jsdelivr.net/npm/@teachablemachine/image@0.8.5/dist/teachablemachine-image.min.js',
      'https://unpkg.com/@teachablemachine/image@0.8.5/dist/teachablemachine-image.min.js'
    ];
    tmPromise = new Promise(function (resolve, reject) {
      (function tryNext(i) {
        if (i >= sources.length) { reject(new Error('Gagal mengunduh runtime Teachable Machine — butuh internet.')); return; }
        var s = document.createElement('script');
        s.src = sources[i]; s.async = true;
        s.onload = function () { window.tmImage ? resolve() : tryNext(i + 1); };
        s.onerror = function () { tryNext(i + 1); };
        document.head.appendChild(s);
      })(0);
    });
    tmPromise = tmPromise.catch(function (e) { tmPromise = null; throw e; });
    return tmPromise;
  }
  function gestFetchLabels(url) {
    return fetch(url + 'metadata.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (m) { return m && (m.labels || m.wordLabels) || null; })
      .catch(function () { return null; });
  }

  function gestAfterLoad(model, labels) {
    gest.model = model;
    var lb = (Array.isArray(labels) && labels.length) ? labels : (model.getClasses ? [] : []);
    try { if (!lb.length && typeof model.getClasses === 'function') lb = model.getClasses() || []; } catch (e) { lb = []; }
    if (!lb.length) lb = ['Kelas 1']; // akan diselaraskan otomatis dari prediksi pertama
    gest.labels = lb.slice();
    gest.ema = {};
    gestRenderBars();
    gestRenderMap();
    G.urlIn.value = gest.modelUrl;
    gest.cfg.url = gest.modelUrl; gestSaveCfg();
    var n = (model.getTotalClasses && model.getTotalClasses()) || lb.length;
    G.loadBtn.textContent = 'Muat ulang';
    G.loadBtn.disabled = false;
    gest.loading = false;
    if (n && gest.labels[0] !== 'Kelas 1' && n !== gest.labels.length) {
      gestSetStatus('Model siap — kelas akan disinkronkan pada prediksi pertama.', false);
    } else {
      gestSetStatus('Model siap — ' + gest.labels.length + ' kelas: ' + gest.labels.join(', ') + '.', false);
    }
    return true;
  }

  function gestLoadModel() {
    if (gest.loading) return Promise.resolve(false);
    var url = gestNormalizeUrl(G.urlIn.value);
    if (!/^https:\/\/teachablemachine\.withgoogle\.com\/models\/[A-Za-z0-9_-]+\/$/.test(url)) {
      toast('Tautan tidak dikenali. Contoh: https://teachablemachine.withgoogle.com/models/XXXXX/', 'error');
      return Promise.resolve(false);
    }
    gest.loading = true;
    G.loadBtn.disabled = true;
    G.loadBtn.textContent = 'Memuat…';
    gestSetStatus('Mengunduh model Teachable Machine… (± 15 MB, sekali lalu cache browser)', false);
    return ensureTM()
      .then(function () { return gestFetchLabels(url); })
      .then(function (labels) {
        gest.pendingLabels = labels;
        return window.tmImage.load(url + 'model.json', url + 'metadata.json');
      })
      .then(function (model) {
        gest.modelUrl = url;
        return gestAfterLoad(model, gest.pendingLabels || []);
      })
      .catch(function (err) {
        gest.loading = false;
        G.loadBtn.disabled = false;
        G.loadBtn.textContent = 'Muat model';
        var m = err && err.message ? err.message : String(err);
        gestSetStatus('Gagal memuat model: ' + m, true);
        toast('Gagal memuat model — periksa tautan & koneksi internet.', 'error');
        return false;
      });
  }

  /* --- kamera --- */
  function gestStartCam() {
    if (gest.stream) return Promise.resolve(true);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      gestSetStatus('Kamera tidak tersedia di konteks ini — butuh HTTPS atau localhost.', true);
      toast('Kamera butuh izin & halaman HTTPS/localhost.', 'error');
      return Promise.resolve(false);
    }
    return navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false
    }).then(function (st) {
      gest.stream = st;
      G.video.srcObject = st;
      return G.video.play().then(function () { return true; }, function () { return true; });
    }).catch(function (err) {
      gestSetStatus('Izin kamera ditolak: ' + (err && err.name ? err.name : 'unknown'), true);
      toast('Kamera ditolak browser — izinkan lalu coba lagi.', 'error');
      return false;
    });
  }
  function gestStopCam() {
    if (gest.stream) { gest.stream.getTracks().forEach(function (t) { t.stop(); }); gest.stream = null; }
    G.video.srcObject = null;
  }

  /* --- selaras label otomatis dari output model (jaga-jaga metadata tak terbaca) --- */
  function gestSyncLabels(preds) {
    var want = preds.map(function (x) { return x.className; });
    var ok = want.length === gest.labels.length && want.every(function (c, i) { return gest.labels[i] === c; });
    if (ok) return;
    gest.labels = want;
    gest.ema = {};
    gestRenderBars();
    gestRenderMap();
  }

  /* --- loop deteksi --- */
  function gestLoop() {
    if (!gest.running) return;
    var now = performance.now();
    if (!gest.inFlight && gest.model && now - gest.lastAt >= GEST_MIN_MS) {
      if (G.video.videoWidth) {
        gest.lastAt = now;
        gest.inFlight = true;
        gest.model.predict(G.video, !!gest.cfg.mirror).then(function (preds) {
          if (Array.isArray(preds) && preds.length) {
            gest.frameErrors = 0;
            gestSyncLabels(preds);
            gestHandle(preds, performance.now());
          }
        }).catch(function (err) {
          gest.frameErrors++;
          if (gest.frameErrors === 1 || gest.frameErrors % 60 === 0) {
            var m = 'Predict error: ' + (err && err.message ? err.message : err);
            gestSetStatus(m, true);
            if (!gest.errShown) {
              gest.errShown = true;
              toast('Mesin deteksi error — buka halaman Gestur untuk detail.', 'error');
              logActivity(m, 'err');
            }
          }
        }).then(function () { gest.inFlight = false; });
      } else if (!gest.videoWarned && now - gest.startedAt > 2500) {
        gest.videoWarned = true;
        gestSetStatus('Video kamera belum mengalir — muat ulang halaman lalu izinkan kamera.', true);
      }
    }
    if (now - gest.lastRateAt >= 1000) {
      G.rate.textContent = gest.predCount + ' pred/dtk';
      gest.predCount = 0; gest.lastRateAt = now;
    }
    gest.rafId = requestAnimationFrame(gestLoop);
  }

  /* --- inti akurasi: ambang + voting streak + histeresis + cooldown --- */
  function gestHandle(preds, now) {
    var conf = gest.cfg.conf;
    var top = preds[0];
    var label = (top && top.probability >= conf) ? top.className : null;
    gest.predCount++;

    var byLabel = {};
    for (var i = 0; i < preds.length; i++) byLabel[preds[i].className] = preds[i].probability;
    for (var j = 0; j < gest.labels.length; j++) {
      var lb = gest.labels[j];
      var raw = byLabel[lb] || 0;
      gest.ema[lb] = (gest.ema[lb] == null) ? raw : gest.ema[lb] * 0.6 + raw * 0.4;
    }
    gestUpdateBars(byLabel, top ? top.className : null);

    // umpan balik langsung: readout besar SELALU menampilkan prediksi mentah teratas
    G.topLabel.textContent = top ? top.className : '—';
    G.topConf.textContent = top ? Math.round(top.probability * 100) + '%' : '0%';

    if (label) {
      if (gest.candidate !== label) { gest.candidate = label; gest.candidateSince = now; }
      else if (!gest.accepted && now - gest.candidateSince >= gest.cfg.holdMs) {
        var last = gest.lastActionAt[label] || 0;
        if (now - last >= gest.cfg.cooldownMs) gestAccept(label, top.probability);
      }
      gest.unstableSince = 0;
    } else if (!gest.accepted) {
      gest.candidate = null;
    }

    if (gest.accepted) {
      var still = top && top.className === gest.accepted && top.probability >= conf - 0.06;
      if (!still) {
        if (!gest.unstableSince) gest.unstableSince = now;
        else if (now - gest.unstableSince > GEST_RELEASE_GRACE) gestRelease(true);
      } else gest.unstableSince = 0;
    }

    G.stateLbl.textContent = gest.accepted ? 'AKTIF: ' + gest.accepted
      : (gest.candidate ? 'menahan… ' + Math.round((top ? top.probability : 0) * 100) + '%'
      : (top ? 'belum yakin ' + Math.round(top.probability * 100) + '%' : 'mencari…'));
    G.stateLbl.classList.toggle('hot', !!gest.accepted);
  }

  function gestAccept(label, probability) {
    var act = gestMapOf(label);
    gest.accepted = label;
    gest.lastActionAt[label] = performance.now();
    G.badge.textContent = label + (act.mode === 'idle' ? '' : ' ✓');
    G.badge.hidden = false;
    G.top.classList.add('stable');
    var canCtrl = canControl();
    if (act.mode === 'hold' && canCtrl) {
      dpadPress(act.dir);            // D-pad di layar ikut menyala; perintah arah terkirim
    } else if (act.mode === 'once') {
      gestDoOnce(act, label);
    }
    logActivity('Gerakan ' + label + ' (' + Math.round(probability * 100) + '%) → ' + act.text, act.mode === 'idle' ? 'info' : 'sys');
    var dot = G._dots && G._dots[label];
    if (dot) { dot.classList.add('fire'); setTimeout(function () { dot.classList.remove('fire'); }, 500); }
  }

  function gestRelease(sendStop) {
    if (!gest.accepted) return;
    var act = gestMapOf(gest.accepted);
    if (sendStop && act.mode === 'hold' && canControl()) dpadRelease(); // "stop" sekali, seperti melepas tombol
    gest.accepted = null;
    gest.unstableSince = 0;
    G.top.classList.remove('stable');
    G.badge.hidden = true;
  }

  function gestOfflineWarn() {
    if (gest.cfg.send) {
      if (!gest.sendWarned) {
        gest.sendWarned = true;
        toast('Gerakan terbaca — tapi micro:bit belum terhubung (hasil hanya ditampilkan).', 'warn');
      }
      logActivity('Gerakan ' + gest.accepted + ' tidak dikirim: belum terhubung.', 'warn');
    }
  }

  function gestDoOnce(act, label) {
    if (!canControl()) { gestOfflineWarn(); return; }
    if (act === GEST_ACTIONS.stop) {
      dpadRelease();
    } else if (act === GEST_ACTIONS.lampu) {
      var on = !els.lampuSwitch.checked;
      setLampuUI(on);
      sendData('lampu:' + (on ? 1 : 0));
    } else if (act === GEST_ACTIONS.fanup || act === GEST_ACTIONS.fandown) {
      var cur = Number(els.kipasSlider.value) || 0;
      var v = Math.max(0, Math.min(1023, cur + (act === GEST_ACTIONS.fanup ? 154 : -154)));
      if (state.fan.enabled) setFanAuto(false, true);
      els.kipasSlider.value = v;
      setKipasUI(v);
      sendData('kipas:' + v);
    }
  }

  /* --- rendering UI --- */
  function gestRenderBars() {
    G.bars.innerHTML = '';
    G._bars = {};
    if (!gest.labels.length) { G.bars.innerHTML = '<div class="gbar-top">Muat model untuk melihat kelas.</div>'; return; }
    gest.labels.forEach(function (lb) {
      var row = document.createElement('div'); row.className = 'gbar';
      var topRow = document.createElement('div'); topRow.className = 'gbar-top';
      var name = document.createElement('span'); name.textContent = lb;
      var val = document.createElement('span'); val.className = 'gbar-val'; val.textContent = '0%';
      topRow.appendChild(name); topRow.appendChild(val);
      var track = document.createElement('div'); track.className = 'gbar-track';
      var fill = document.createElement('div'); fill.className = 'gbar-fill';
      track.appendChild(fill);
      row.appendChild(topRow); row.appendChild(track);
      G.bars.appendChild(row);
      G._bars[lb] = { row: row, fill: fill, val: val };
    });
  }
  function gestUpdateBars(byLabel, topName) {
    for (var lb in G._bars) {
      var r = G._bars[lb];
      var sm = Math.max(0, Math.min(1, gest.ema[lb] || 0));
      r.fill.style.width = (sm * 100).toFixed(1) + '%';
      r.val.textContent = Math.round((byLabel[lb] || 0) * 100) + '%';
      r.row.classList.toggle('on', lb === topName);
    }
  }
  function gestRenderMap() {
    G.mapWrap.innerHTML = '';
    G._dots = {};
    if (!gest.labels.length) {
      G.mapWrap.textContent = 'Muat model dulu untuk melihat kelas-kelasnya.';
      return;
    }
    gest.labels.forEach(function (lb) {
      var row = document.createElement('div'); row.className = 'gmap-row'; row.dataset.label = lb;
      var dot = document.createElement('span'); dot.className = 'gmap-dot';
      var name = document.createElement('span'); name.className = 'gmap-label'; name.textContent = lb; name.title = lb;
      var sel = document.createElement('select');
      Object.keys(GEST_ACTIONS).forEach(function (k) {
        var o = document.createElement('option');
        o.value = k; o.textContent = GEST_ACTIONS[k].text;
        sel.appendChild(o);
      });
      if (gest.cfg.map[lb] == null) gest.cfg.map[lb] = gestAutoMap(lb);
      sel.value = gest.cfg.map[lb];
      sel.addEventListener('change', function () {
        gest.cfg.map[lb] = sel.value;
        gestSaveCfg();
        logActivity('Peta gestur: ' + lb + ' → ' + GEST_ACTIONS[sel.value].text, 'sys');
      });
      row.appendChild(dot); row.appendChild(name); row.appendChild(sel);
      G.mapWrap.appendChild(row);
      G._dots[lb] = dot;
    });
    gestSaveCfg();
  }

  /* --- kontrol start/stop --- */
  function gestStart() {
    if (gest.running) return;
    var modelP = gest.model ? Promise.resolve(true) : gestLoadModel();
    var camP = gestStartCam();
    Promise.all([modelP, camP]).then(function (res) {
      if (res[0] === false || res[1] === false) { return; }
      gest.running = true;
      gest.startedAt = performance.now();
      gest.lastRateAt = gest.startedAt;
      gest.videoWarned = false; gest.errShown = false; gest.frameErrors = 0;
      G.stage.classList.add('live');
      G.startBtn.disabled = true;
      G.stopBtn.disabled = false;
      logActivity('Deteksi gestur dimulai (' + gest.labels.join('/') + ').', 'sys');
      gestSetStatus('Mendeteksi… angkat tangan ke kamera dan TAHAN ±0,3 detik.', false);
      gest.rafId = requestAnimationFrame(gestLoop);
    });
  }
  function gestStop() {
    if (!gest.running) return;
    gest.running = false;
    cancelAnimationFrame(gest.rafId);
    gestRelease(false);
    G.stage.classList.remove('live');
    G.startBtn.disabled = false;
    G.stopBtn.disabled = true;
    G.rate.textContent = '0 pred/dtk';
    G.stateLbl.textContent = 'Siaga';
    gestStopCam();
    gestSetStatus(gest.model ? 'Berhenti. Model masih termuat — Mulai lagi tanpa unduh ulang.' : 'Model belum dimuat.', false);
    logActivity('Deteksi gestur dihentikan.', 'sys');
  }

  /* --- wiring UI --- */
  G.startBtn.addEventListener('click', gestStart);
  G.stopBtn.addEventListener('click', gestStop);
  G.loadBtn.addEventListener('click', function () { gestLoadModel(); });
  G.mirror.addEventListener('change', function () {
    gest.cfg.mirror = G.mirror.checked;
    G.stage.classList.toggle('no-mirror', !G.mirror.checked);
    gestSaveCfg();
  });
  G.send.addEventListener('change', function () {
    gest.cfg.send = G.send.checked; gestSaveCfg();
  });
  function bindRange(input, out, fmt, setter) {
    var apply = function (save) {
      setter(Number(input.value));
      out.textContent = fmt(Number(input.value));
      if (save) gestSaveCfg();
    };
    input.addEventListener('input', function () { apply(false); });
    input.addEventListener('change', function () { apply(true); });
  }
  G.conf.value = Math.round(gest.cfg.conf * 100);
  G.hold.value = gest.cfg.holdMs;
  G.cd.value = gest.cfg.cooldownMs;
  bindRange(G.conf, G.confVal, function (v) { return v + '%'; }, function (v) { gest.cfg.conf = v / 100; });
  bindRange(G.hold, G.holdVal, function (v) { return (v / 1000).toFixed(2) + ' dtk'; }, function (v) { gest.cfg.holdMs = v; });
  bindRange(G.cd, G.cdVal, function (v) { return (v / 1000).toFixed(1) + ' dtk'; }, function (v) { gest.cfg.cooldownMs = v; });
  G.confVal.textContent = Math.round(gest.cfg.conf * 100) + '%';
  G.holdVal.textContent = (gest.cfg.holdMs / 1000).toFixed(2) + ' dtk';
  G.cdVal.textContent = (gest.cfg.cooldownMs / 1000).toFixed(1) + ' dtk';
  G.stage.classList.toggle('no-mirror', !gest.cfg.mirror);
  G.mirror.checked = !!gest.cfg.mirror;
  G.send.checked = !!gest.cfg.send;

  // pengaman: tab tersembunyi / fokus hilang → lepas gesture (stop terkirim bila sedang gerak)
  document.addEventListener('visibilitychange', function () { if (document.hidden && gest.accepted) gestRelease(true); });
  window.addEventListener('blur', function () { if (gest.accepted) gestRelease(true); });


  logActivity('Klik "Hubungkan ke Micro:bit" atau aktifkan Mode Demo untuk mulai.', 'sys');
})();
