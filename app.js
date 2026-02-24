// ===== DERIVEDGE PRO — Main App Logic =====
// Connects to Deriv WebSocket API and powers all strategy analysis

const DERIV_WS_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';
const MARKETS = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];
const MARKET_NAMES = { R_10: 'V10', R_25: 'V25', R_50: 'V50', R_75: 'V75', R_100: 'V100' };

// ===== STATE =====
const state = {
  ws: null,
  connected: false,
  ticks: { R_10: [], R_25: [], R_50: [], R_75: [], R_100: [] },
  prices: { R_10: null, R_25: null, R_50: null, R_75: null, R_100: null },
  digitCounts: { R_10: Array(10).fill(0), R_25: Array(10).fill(0), R_50: Array(10).fill(0), R_75: Array(10).fill(0), R_100: Array(10).fill(0) },
  rsi: { R_10: 50, R_25: 50, R_50: 50, R_75: 50, R_100: 50 },
  ema: { R_10: {e5:0,e10:0,e20:0,e50:0,e200:0}, R_25: {e5:0,e10:0,e20:0,e50:0,e200:0}, R_50: {e5:0,e10:0,e20:0,e50:0,e200:0}, R_75: {e5:0,e10:0,e20:0,e50:0,e200:0}, R_100: {e5:0,e10:0,e20:0,e50:0,e200:0} },
  currentPage: 'dashboard',
  trackerMarket: 'R_75',
  trackerWindow: 100,
  journal: JSON.parse(localStorage.getItem('journal') || '[]'),
  subscriptions: {},
};

// ===== WEBSOCKET =====
function connectWS() {
  try {
    state.ws = new WebSocket(DERIV_WS_URL);
    state.ws.onopen = () => {
      state.connected = true;
      subscribeAll();
    };
    state.ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
    state.ws.onclose = () => {
      state.connected = false;
      setTimeout(connectWS, 3000);
    };
    state.ws.onerror = () => state.ws.close();
  } catch(err) {
    console.error('WS Error:', err);
    setTimeout(connectWS, 5000);
  }
}

function sendWS(data) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(data));
  }
}

function subscribeAll() {
  MARKETS.forEach(mkt => {
    sendWS({ ticks: mkt, subscribe: 1 });
  });
}

function handleMessage(msg) {
  if (msg.msg_type === 'tick') {
    const tick = msg.tick;
    const mkt = tick.symbol;
    const price = parseFloat(tick.quote);
    const digit = parseInt(tick.quote.toString().slice(-1));

    state.prices[mkt] = price;
    state.ticks[mkt].push({ price, digit, time: tick.epoch });

    if (state.ticks[mkt].length > 2000) state.ticks[mkt].shift();
    state.digitCounts[mkt][digit]++;

    updateIndicators(mkt);
    updateUI(mkt, price, digit);
  }
}

// ===== INDICATORS =====
function calcEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  const changes = [];
  for (let i = 1; i < prices.length; i++) changes.push(prices[i] - prices[i - 1]);
  const recent = changes.slice(-period);
  const gains = recent.filter(c => c > 0).reduce((a, b) => a + b, 0) / period;
  const losses = recent.filter(c => c < 0).map(c => -c).reduce((a, b) => a + b, 0) / period;
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function updateIndicators(mkt) {
  const prices = state.ticks[mkt].map(t => t.price);
  if (prices.length < 5) return;

  state.rsi[mkt] = calcRSI(prices, 14);
  state.ema[mkt] = {
    e5: calcEMA(prices, 5),
    e10: calcEMA(prices, 10),
    e20: calcEMA(prices, 20),
    e50: calcEMA(prices, 50),
    e200: calcEMA(prices, 200),
  };
}

// ===== SIGNAL GENERATION =====
function getRiseFallSignal(mkt) {
  const rsi = state.rsi[mkt];
  const ema = state.ema[mkt];
  const ticks = state.ticks[mkt];
  if (ticks.length < 20) return 'SCANNING';

  const bullishTrend = ema.e20 > ema.e50 && ema.e50 > ema.e200;
  const bearishTrend = ema.e20 < ema.e50 && ema.e50 < ema.e200;
  const price = state.prices[mkt];

  if (bullishTrend && rsi > 50 && rsi < 70 && price > ema.e50) return 'RISE';
  if (bearishTrend && rsi < 50 && rsi > 30 && price < ema.e50) return 'FALL';
  if (rsi >= 45 && rsi <= 55) return 'FLAT';
  return 'NEUTRAL';
}

function getEvenOddSignal(mkt) {
  const ticks = state.ticks[mkt].slice(-20);
  if (ticks.length < 10) return { signal: 'WAITING', even: 0, odd: 0 };
  const even = ticks.filter(t => t.digit % 2 === 0).length;
  const odd = ticks.length - even;
  const rsi = state.rsi[mkt];

  let signal = 'NEUTRAL';
  if (even >= 14 && rsi >= 40 && rsi <= 55) signal = 'EVEN';
  else if (odd >= 14 && rsi >= 45 && rsi <= 65) signal = 'ODD';
  else if (rsi >= 45 && rsi <= 55) signal = 'NO TRADE';

  return { signal, even, odd };
}

function getOverUnderSignal(mkt) {
  const ticks = state.ticks[mkt].slice(-20);
  if (ticks.length < 10) return { signal: 'SCANNING', low: 0, high: 0 };
  const low = ticks.filter(t => t.digit <= 4).length;
  const high = ticks.length - low;
  const rsi = state.rsi[mkt];

  let signal = 'NEUTRAL';
  if (low >= 14 && rsi > 55) signal = 'OVER';
  else if (high >= 14 && rsi < 45) signal = 'UNDER';

  return { signal, low, high };
}

function getStreak(ticks, type) {
  let count = 0;
  for (let i = ticks.length - 1; i >= 0; i--) {
    const d = ticks[i].digit;
    const isEven = d % 2 === 0;
    if (type === 'even' && isEven) count++;
    else if (type === 'odd' && !isEven) count++;
    else break;
  }
  return count;
}

function getDigitFrequency(mkt, window = 1000) {
  const ticks = state.ticks[mkt].slice(-window);
  const counts = Array(10).fill(0);
  ticks.forEach(t => counts[t.digit]++);
  return counts;
}

function getDigitPct(mkt, digit, window = 1000) {
  const ticks = state.ticks[mkt].slice(-window);
  if (!ticks.length) return 10;
  return (ticks.filter(t => t.digit === digit).length / ticks.length) * 100;
}

// ===== BOT CONDITION CHECKER =====
function checkBotConditions(botType) {
  const mkt = 'R_75';
  const rsi = state.rsi[mkt];
  const ticks = state.ticks[mkt];
  const time = new Date();
  const utcH = time.getUTCHours();
  const inTradingWindow = utcH >= 9 && utcH < 17;
  const prices = ticks.map(t => t.price);
  const priceMoving = prices.length >= 10 ?
    Math.abs(prices[prices.length - 1] - prices[prices.length - 10]) >= 0.04 : false;

  const configs = {
    nuclear9: { digit: 9 },
    zerokiller: { digit: 0 },
    mirror8: { digit: 8 },
    onestreak: { digit: 1 },
  };

  if (configs[botType]) {
    const digit = configs[botType].digit;
    const pct = getDigitPct(mkt, digit, 1000);
    const isCold = pct <= 9.0;
    const isHot = pct >= 11.5;
    const rsiOk = rsi <= 32 || rsi >= 64;

    return [
      isCold || isHot,
      rsiOk,
      priceMoving,
      inTradingWindow,
      true, // no news check placeholder
    ];
  }

  if (botType === 'firebias') {
    const recentTicks = ticks.slice(-100);
    const highDigits = recentTicks.filter(t => t.digit >= 5).length;
    const highPct = recentTicks.length ? (highDigits / recentTicks.length) * 100 : 50;
    return [
      highPct >= 50 || highPct <= 50,
      rsi > 50 || rsi < 50,
      prices.length >= 10 ? Math.abs(prices[prices.length - 1] - prices[prices.length - 10]) >= 0.02 : false,
      utcH >= 8 && utcH < 18,
      true,
    ];
  }

  if (botType === 'underbeast') {
    const recentTicks = ticks.slice(-1000);
    const lowPct = recentTicks.length ? (recentTicks.filter(t => t.digit <= 4).length / recentTicks.length) * 100 : 50;
    return [
      lowPct >= 50 || lowPct <= 50,
      rsi < 45 || rsi > 55,
      prices.length >= 5 ? Math.abs(prices[prices.length - 1] - prices[prices.length - 5]) >= 0.015 : false,
      utcH >= 7 && utcH < 19,
      true,
    ];
  }

  if (botType === 'evenstreak') {
    const last1000 = ticks.slice(-1000);
    const evenPct = last1000.length ? (last1000.filter(t => t.digit % 2 === 0).length / last1000.length) * 100 : 50;
    const last2 = ticks.slice(-2);
    const last2Even = last2.every(t => t.digit % 2 === 0);
    return [
      evenPct >= 50 || evenPct < 50,
      last2Even,
      rsi < 48 || rsi > 52,
      utcH >= 7 && utcH < 19,
      true,
    ];
  }

  return [false, false, false, false, false];
}

// ===== UI UPDATERS =====
function updateUI(mkt, price, digit) {
  // Update price tickers
  const tickEls = { R_10: 'v10-val', R_25: 'v25-val', R_50: 'v50-val', R_75: 'v75-val', R_100: 'v100-val' };
  const el = document.getElementById(tickEls[mkt]);
  if (el) el.textContent = price.toFixed(2);

  // Update dashboard cards
  const dashEls = { R_10: {v:'dv10',s:'ds10',b:'db10'}, R_25: {v:'dv25',s:'ds25',b:'db25'}, R_75: {v:'dv75',s:'ds75',b:'db75'}, R_100: {v:'dv100',s:'ds100',b:'db100'} };
  if (dashEls[mkt]) {
    const d = dashEls[mkt];
    const vEl = document.getElementById(d.v);
    if (vEl) vEl.textContent = price.toFixed(2);
    const sig = getRiseFallSignal(mkt);
    const sEl = document.getElementById(d.s);
    if (sEl) { sEl.textContent = sig; sEl.className = 'card-signal ' + sig.toLowerCase(); }
    const rsi = state.rsi[mkt];
    const bEl = document.getElementById(d.b);
    if (bEl) bEl.style.width = rsi + '%';
  }

  // Update signal matrix
  updateSignalMatrix();

  // Digit distribution
  if (mkt === 'R_75') {
    updateDigitChart('v75', mkt);
    updateStreaks();
  }

  // Page-specific updates
  if (state.currentPage === 'rise-fall') updateRiseFallPage();
  if (state.currentPage === 'even-odd') updateEvenOddPage(mkt);
  if (state.currentPage === 'over-under') updateOverUnderPage(mkt);
  if (state.currentPage === 'matches-differs') updateMDPage(mkt);
  if (state.currentPage === 'dbot') updateDBotPage();
  if (state.currentPage === 'digit-tracker' && mkt === state.trackerMarket) updateTracker(digit, price);
  if (state.currentPage === 'greenlight') updateGreenLightPage(mkt);
}

function updateSignalMatrix() {
  const tbody = document.getElementById('signal-tbody');
  if (!tbody) return;
  const rows = MARKETS.map(mkt => {
    const rsi = state.rsi[mkt].toFixed(1);
    const ema = state.ema[mkt];
    const trend = ema.e20 > ema.e50 ? '↑ Bull' : ema.e20 < ema.e50 ? '↓ Bear' : '— Flat';
    const mom = state.rsi[mkt] > 60 ? 'Strong ↑' : state.rsi[mkt] < 40 ? 'Strong ↓' : 'Neutral';
    const rf = getRiseFallSignal(mkt);
    const eo = getEvenOddSignal(mkt).signal;
    const ou = getOverUnderSignal(mkt).signal;
    const gl = (rf === 'RISE' || rf === 'FALL') ? '✅ GO' : '⏸ WAIT';
    const rfClass = rf === 'RISE' ? 'rise' : rf === 'FALL' ? 'fall' : 'neutral';
    return `<tr>
      <td>${MARKET_NAMES[mkt]}</td>
      <td style="color:${state.rsi[mkt]>60?'#10b981':state.rsi[mkt]<40?'#ef4444':'#94a3b8'}">${rsi}</td>
      <td>${trend}</td>
      <td>${mom}</td>
      <td class="signal-cell ${rfClass}">${rf}</td>
      <td style="color:${eo==='EVEN'?'#38bdf8':eo==='ODD'?'#8b5cf6':'#94a3b8'}">${eo}</td>
      <td style="color:${ou==='OVER'?'#10b981':ou==='UNDER'?'#ef4444':'#94a3b8'}">${ou}</td>
      <td style="color:${gl==='✅ GO'?'#10b981':'#f59e0b'}">${gl}</td>
    </tr>`;
  }).join('');
  tbody.innerHTML = rows;
}

function updateDigitChart(suffix, mkt) {
  const barsEl = document.getElementById('digit-bars-' + suffix);
  if (!barsEl) return;
  const ticks = state.ticks[mkt].slice(-100);
  const counts = Array(10).fill(0);
  ticks.forEach(t => counts[t.digit]++);
  const max = Math.max(...counts, 1);

  barsEl.innerHTML = counts.map((c, i) => {
    const h = Math.round((c / max) * 70);
    const cls = i % 2 === 0 ? 'even-bar' : 'odd-bar';
    return `<div class="digit-bar ${cls}" style="height:${h}px" title="Digit ${i}: ${c}x (${((c/ticks.length||0)*100).toFixed(1)}%)"></div>`;
  }).join('');

  const even = counts.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0);
  const over5 = counts.slice(5).reduce((a, b) => a + b, 0);
  const total = ticks.length || 1;

  const evenEl = document.getElementById('even-pct-' + suffix);
  const oddEl = document.getElementById('odd-pct-' + suffix);
  const overEl = document.getElementById('over-pct-' + suffix);
  const underEl = document.getElementById('under-pct-' + suffix);
  if (evenEl) evenEl.textContent = ((even / total) * 100).toFixed(1) + '%';
  if (oddEl) oddEl.textContent = (((total - even) / total) * 100).toFixed(1) + '%';
  if (overEl) overEl.textContent = ((over5 / total) * 100).toFixed(1) + '%';
  if (underEl) underEl.textContent = (((total - over5) / total) * 100).toFixed(1) + '%';
}

function updateStreaks() {
  const markets = [
    { id: 'v75-even', mkt: 'R_75', type: 'even' },
    { id: 'v75-odd', mkt: 'R_75', type: 'odd' },
    { id: 'v10-even', mkt: 'R_10', type: 'even' },
  ];

  // Rise streak
  const v75Ticks = state.ticks['R_75'];
  let riseStreak = 0;
  for (let i = v75Ticks.length - 1; i > 0; i--) {
    if (v75Ticks[i].price > v75Ticks[i - 1].price) riseStreak++;
    else break;
  }
  renderStreakDots('streak-rise', 'streak-rise-count', riseStreak);

  markets.forEach(({ id, mkt, type }) => {
    const s = getStreak(state.ticks[mkt], type);
    renderStreakDots('streak-' + id, 'streak-' + id + '-count', s);
  });

  // Alert
  const alertEl = document.getElementById('streak-alert');
  if (alertEl) {
    const evenS = getStreak(v75Ticks, 'even');
    const oddS = getStreak(v75Ticks, 'odd');
    if (evenS >= 5) alertEl.textContent = `🚨 V75 Even streak: ${evenS} — Consider ODD entry!`;
    else if (oddS >= 5) alertEl.textContent = `🚨 V75 Odd streak: ${oddS} — Consider EVEN entry!`;
    else if (riseStreak >= 5) alertEl.textContent = `📈 V75 Rise streak: ${riseStreak} — Watch for reversal`;
    else alertEl.textContent = 'Monitoring streaks for signals...';
  }
}

function renderStreakDots(dotsId, countId, count) {
  const el = document.getElementById(dotsId);
  const cEl = document.getElementById(countId);
  if (!el) return;
  const max = 10;
  let html = '';
  for (let i = 0; i < max; i++) {
    let cls = 'streak-dot';
    if (i < count) {
      cls += count >= 7 ? ' alert' : count >= 5 ? ' warn' : ' active';
    }
    html += `<div class="${cls}"></div>`;
  }
  el.innerHTML = html;
  if (cEl) cEl.textContent = count;
}

function updateRiseFallPage() {
  const mkt = document.querySelector('.mkt-btn.active')?.dataset?.mkt || 'R_75';
  const rsi = state.rsi[mkt];
  const ema = state.ema[mkt];
  const sig = getRiseFallSignal(mkt);

  const bullTrend = ema.e20 > ema.e50 && ema.e50 > ema.e200;
  const bearTrend = ema.e20 < ema.e50 && ema.e50 < ema.e200;

  setEl('gl-trend-status', bullTrend ? '✅ BULLISH' : bearTrend ? '❌ BEARISH' : '⏸ FLAT', bullTrend ? 'gl-box green' : bearTrend ? 'gl-box red' : 'gl-box', 'gl-trend');
  setEl('gl-mom-status', rsi > 50 ? '✅ BULLISH RSI' : '❌ BEARISH RSI', rsi > 50 ? 'gl-box green' : 'gl-box red', 'gl-momentum');
  setEl('gl-entry-status', sig === 'RISE' || sig === 'FALL' ? '✅ SIGNAL ACTIVE' : '⏸ NO SIGNAL', (sig === 'RISE' || sig === 'FALL') ? 'gl-box green' : 'gl-box', 'gl-entry');

  // Condition checks
  setCond('cond-ema', bullTrend || bearTrend);
  setCond('cond-rsi', rsi > 50);
  setCond('cond-macd', rsi > 55 || rsi < 45);
  setCond('cond-price', state.prices[mkt] > ema.e50);
  setCond('cond-support', Math.abs(state.prices[mkt] - ema.e20) < 0.1);

  const sigEl = document.getElementById('rf-signal-val');
  if (sigEl) { sigEl.textContent = sig; sigEl.className = 'signal-val ' + sig.toLowerCase(); }

  // Perf table signals
  MARKETS.forEach(m => {
    const s = getRiseFallSignal(m);
    const el = document.getElementById('rf-' + m.toLowerCase().replace('_', ''));
    if (el) { el.textContent = s; el.className = 'signal-cell ' + s.toLowerCase(); }
  });
}

function updateEvenOddPage(mkt) {
  if (mkt !== 'R_75') return;
  const ticks = state.ticks[mkt].slice(-20);
  const { signal, even, odd } = getEvenOddSignal(mkt);

  // Digit stream
  const streamEl = document.getElementById('eo-digit-stream');
  if (streamEl) {
    streamEl.innerHTML = ticks.map(t => {
      const cls = t.digit % 2 === 0 ? 'even' : 'odd';
      return `<div class="ds-digit ${cls}">${t.digit}</div>`;
    }).join('');
  }

  const evenEl = document.getElementById('eo-even-count');
  const oddEl = document.getElementById('eo-odd-count');
  if (evenEl) evenEl.textContent = even;
  if (oddEl) oddEl.textContent = odd;

  const sigEl = document.getElementById('eo-signal');
  if (sigEl) { sigEl.textContent = signal; sigEl.className = 'signal-val ' + (signal === 'EVEN' ? 'rise' : signal === 'ODD' ? 'fall' : 'neutral'); }

  // Method detection
  const evenStreak = getStreak(state.ticks[mkt], 'even');
  const oddStreak = getStreak(state.ticks[mkt], 'odd');
  setMethodSignal('m1-signal', evenStreak >= 5 ? '🚨 5+ Even streak → Bet ODD' : oddStreak >= 5 ? '🚨 5+ Odd streak → Bet EVEN' : 'No streak signal');
  setMethodSignal('m2-signal', even >= 14 ? '✅ Even dominant → EVEN' : odd >= 14 ? '✅ Odd dominant → ODD' : 'No dominance signal');

  // Alternation check
  let isAlternating = true;
  for (let i = 1; i < Math.min(ticks.length, 6); i++) {
    if ((ticks[i].digit % 2) === (ticks[i - 1].digit % 2)) { isAlternating = false; break; }
  }
  setMethodSignal('m3-signal', isAlternating && ticks.length >= 4 ? '✅ Alternation pattern → ' + (ticks[ticks.length-1].digit % 2 === 0 ? 'ODD' : 'EVEN') : 'No alternation');
}

function updateOverUnderPage(mkt) {
  if (mkt !== 'R_75') return;
  const ticks = state.ticks[mkt].slice(-20);
  const { signal, low, high } = getOverUnderSignal(mkt);
  const rsi = state.rsi[mkt];

  const digEl = document.getElementById('ou-digits');
  if (digEl) {
    digEl.innerHTML = ticks.map(t => {
      const cls = t.digit <= 4 ? 'low' : 'high';
      return `<div class="ou-d ${cls}">${t.digit}</div>`;
    }).join('');
  }

  const total = ticks.length || 1;
  setElText('ou-low', low);
  setElText('ou-high', high);
  setBar('ou-low-bar', (low / total) * 100);
  setBar('ou-high-bar', (high / total) * 100);

  setCond('over-c1', low >= 12, 'over-c1');
  setCond('over-c2', rsi > 55, 'over-c2');
  setCond('under-c1', high >= 12, 'under-c1');
  setCond('under-c2', rsi < 45, 'under-c2');

  setSignalVal('over-signal', signal === 'OVER' ? 'OVER ▲' : 'WAITING', signal === 'OVER' ? 'rise' : 'neutral');
  setSignalVal('under-signal', signal === 'UNDER' ? 'UNDER ▼' : 'WAITING', signal === 'UNDER' ? 'fall' : 'neutral');
}

function updateMDPage(mkt) {
  if (mkt !== 'R_75') return;
  const ticks = state.ticks[mkt].slice(-20);
  const digitFreq = {};
  ticks.forEach(t => { digitFreq[t.digit] = (digitFreq[t.digit] || 0) + 1; });

  const repEl = document.getElementById('repeat-display');
  if (repEl) {
    repEl.innerHTML = ticks.map(t => {
      const cls = digitFreq[t.digit] > 1 ? 'repeat' : 'normal';
      return `<div class="rep-digit ${cls}">${t.digit}</div>`;
    }).join('');
  }

  const rsi = state.rsi[mkt];
  const hasRepeats = Object.values(digitFreq).some(v => v >= 2);
  const vol = state.ticks[mkt].slice(-10).map(t => t.price);
  const volatility = vol.length > 1 ? Math.max(...vol) - Math.min(...vol) : 0;
  const isHighVol = volatility > 0.5;

  const sigEl = document.getElementById('md-signal');
  if (sigEl) {
    if (hasRepeats && rsi >= 45 && rsi <= 55 && !isHighVol) {
      sigEl.textContent = 'MATCHES'; sigEl.className = 'signal-val rise';
    } else if (isHighVol && (rsi > 60 || rsi < 40)) {
      sigEl.textContent = 'DIFFERS'; sigEl.className = 'signal-val fall';
    } else {
      sigEl.textContent = 'ANALYZING'; sigEl.className = 'signal-val neutral';
    }
  }
}

function updateDBotPage() {
  const bots = ['nuclear9', 'zerokiller', 'mirror8', 'onestreak', 'firebias', 'underbeast', 'evenstreak'];
  const prefixes = { nuclear9: 'n9', zerokiller: 'zk', mirror8: 'm8', onestreak: 'os', firebias: 'fb', underbeast: 'ub', evenstreak: 'es' };

  bots.forEach(bot => {
    const conditions = checkBotConditions(bot);
    const metCount = conditions.filter(Boolean).length;
    const prefix = prefixes[bot];

    conditions.forEach((met, i) => {
      const letters = ['a', 'b', 'c', 'd', 'e'];
      const el = document.getElementById(`${prefix}-${letters[i]}`);
      if (el) { el.className = 'bc-item ' + (met ? 'pass' : 'fail'); }
    });

    const scoreEl = document.getElementById(`${prefix}-score`);
    const barEl = document.getElementById(`${prefix}-bar`);
    const statusEl = document.getElementById(`${bot}-status`);
    if (scoreEl) scoreEl.textContent = metCount;
    if (barEl) barEl.style.width = (metCount / 5 * 100) + '%';
    if (statusEl) {
      if (metCount >= 3) { statusEl.textContent = '✅ READY'; statusEl.className = 'bot-status ready'; }
      else if (metCount >= 2) { statusEl.textContent = '⚡ CLOSE'; statusEl.className = 'bot-status caution'; }
      else { statusEl.textContent = 'MONITORING'; statusEl.className = 'bot-status'; }
    }
  });
}

function updateTracker(digit, price) {
  const window = state.trackerWindow;
  const ticks = state.ticks[state.trackerMarket].slice(-window);
  const counts = Array(10).fill(0);
  ticks.forEach(t => counts[t.digit]++);
  const total = ticks.length || 1;
  const max = Math.max(...counts, 1);

  // Big chart
  const chartEl = document.getElementById('big-digit-chart');
  if (chartEl) {
    chartEl.innerHTML = counts.map((c, i) => {
      const h = Math.round((c / max) * 110);
      const cls = i % 2 === 0 ? 'even-bar' : 'odd-bar';
      return `<div class="digit-bar ${cls}" style="height:${h}px;flex:1" title="${i}: ${c} (${((c/total)*100).toFixed(1)}%)"></div>`;
    }).join('');
  }

  // Stats
  const even = counts.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0);
  const over5 = counts.slice(5).reduce((a, b) => a + b, 0);
  const coldIdx = counts.indexOf(Math.min(...counts));
  const hotIdx = counts.indexOf(Math.max(...counts));

  setElText('ts-total', total);
  setElText('ts-even', even);
  setElText('ts-odd', total - even);
  setElText('ts-even-pct', ((even / total) * 100).toFixed(1) + '%');
  setElText('ts-odd-pct', (((total - even) / total) * 100).toFixed(1) + '%');
  setElText('ts-over', ((over5 / total) * 100).toFixed(1) + '%');
  setElText('ts-under', (((total - over5) / total) * 100).toFixed(1) + '%');
  setElText('ts-cold', coldIdx + ' (' + ((counts[coldIdx] / total) * 100).toFixed(1) + '%)');
  setElText('ts-hot', hotIdx + ' (' + ((counts[hotIdx] / total) * 100).toFixed(1) + '%)');

  // Tick stream
  const streamEl = document.getElementById('tick-stream');
  if (streamEl) {
    const lastTick = document.createElement('div');
    lastTick.className = 'ts-tick ' + (digit % 2 === 0 ? 'even' : 'odd');
    lastTick.textContent = digit;
    streamEl.prepend(lastTick);
    if (streamEl.children.length > 60) streamEl.removeChild(streamEl.lastChild);
  }
}

function updateGreenLightPage(mkt) {
  if (mkt !== 'R_75') return;
  const ticks = state.ticks[mkt].slice(-20);
  const rsi = state.rsi[mkt];
  const ema = state.ema[mkt];
  const even = ticks.filter(t => t.digit % 2 === 0).length;
  const price = state.prices[mkt];

  const cond1 = even >= 13;
  const cond2 = rsi >= 40 && rsi <= 55;
  const cond3 = price <= ema.e20 * 1.001;
  const cond4 = ema.e5 > ema.e10;

  setGLCond('glc-dominance', cond1, 'glcs-1', cond1 ? '✅' : '❌');
  setGLCond('glc-rsi', cond2, 'glcs-2', rsi.toFixed(0));
  setGLCond('glc-bollinger', cond3, 'glcs-3', cond3 ? '✅' : '❌');
  setGLCond('glc-ema-cross', cond4, 'glcs-4', cond4 ? '✅' : '❌');

  const greenEven = cond1 && cond2 && cond3 && cond4;
  const greenEl = document.getElementById('gl-even-val');
  if (greenEl) { greenEl.textContent = greenEven ? 'EVEN ✅' : 'NOT YET'; greenEl.style.color = greenEven ? '#10b981' : '#94a3b8'; }

  // Odd conditions (inverse)
  setGLCond('glc-odd-dom', even <= 7, 'glcs-5', even <= 7 ? '✅' : '❌');
  setGLCond('glc-odd-rsi', rsi >= 45 && rsi <= 65, 'glcs-6', rsi.toFixed(0));
  setGLCond('glc-upper-bb', price >= ema.e20 * 0.999, 'glcs-7', price >= ema.e20 * 0.999 ? '✅' : '❌');
  setGLCond('glc-ema-down', ema.e5 < ema.e10, 'glcs-8', ema.e5 < ema.e10 ? '✅' : '❌');

  const greenOdd = even <= 7 && (rsi >= 45 && rsi <= 65) && ema.e5 < ema.e10;
  const oddEl = document.getElementById('gl-odd-val');
  if (oddEl) { oddEl.textContent = greenOdd ? 'ODD ✅' : 'NOT YET'; oddEl.style.color = greenOdd ? '#8b5cf6' : '#94a3b8'; }
}

// ===== HELPERS =====
function setEl(id, text, boxClass, boxId) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
  if (boxId && boxClass) {
    const box = document.getElementById(boxId);
    if (box) box.className = boxClass;
  }
}
function setElText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function setBar(id, pct) { const el = document.getElementById(id); if (el) el.style.width = Math.min(100, pct) + '%'; }
function setCond(id, pass) {
  const el = document.getElementById(id);
  if (el) el.className = 'cond-item ' + (pass ? 'pass' : 'fail');
}
function setSignalVal(id, text, cls) {
  const el = document.getElementById(id);
  if (el) { el.textContent = text; el.className = 'signal-val ' + (cls || ''); }
}
function setMethodSignal(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
function setGLCond(condId, pass, statusId, statusText) {
  const el = document.getElementById(condId);
  if (el) el.className = 'gl-cond ' + (pass ? 'pass' : 'fail');
  const sEl = document.getElementById(statusId);
  if (sEl) { sEl.textContent = statusText; sEl.style.color = pass ? '#10b981' : '#ef4444'; }
}

// ===== CLOCK =====
function updateClock() {
  const now = new Date();
  const h = String(now.getUTCHours()).padStart(2, '0');
  const m = String(now.getUTCMinutes()).padStart(2, '0');
  const s = String(now.getUTCSeconds()).padStart(2, '0');
  setElText('utc-clock', `${h}:${m}:${s} UTC`);
}

// ===== NAVIGATION =====
function initNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const page = item.dataset.page;
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      const pageEl = document.getElementById('page-' + page);
      if (pageEl) pageEl.classList.add('active');
      state.currentPage = page;

      // Close sidebar on mobile
      if (window.innerWidth < 768) document.getElementById('sidebar').classList.remove('open');
    });
  });

  document.getElementById('menu-toggle')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
}

// ===== MARKET BUTTONS =====
function initMarketButtons() {
  document.querySelectorAll('.mkt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mkt-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateRiseFallPage();
    });
  });
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

// ===== TRACKER CONTROLS =====
function initTracker() {
  document.getElementById('tracker-market')?.addEventListener('change', (e) => {
    state.trackerMarket = e.target.value;
  });
  document.getElementById('tracker-window')?.addEventListener('change', (e) => {
    state.trackerWindow = parseInt(e.target.value);
  });
  document.getElementById('tracker-reset')?.addEventListener('click', () => {
    state.ticks[state.trackerMarket] = [];
    state.digitCounts[state.trackerMarket] = Array(10).fill(0);
    const streamEl = document.getElementById('tick-stream');
    if (streamEl) streamEl.innerHTML = '';
  });
}

// ===== JOURNAL =====
function initJournal() {
  document.getElementById('j-submit')?.addEventListener('click', () => {
    const market = document.getElementById('j-market')?.value;
    const strategy = document.getElementById('j-strategy')?.value;
    const result = document.getElementById('j-result')?.value;
    const stake = parseFloat(document.getElementById('j-stake')?.value || 0);
    const pnl = parseFloat(document.getElementById('j-pnl')?.value || 0);
    const gl = document.getElementById('j-greenlight')?.value;
    const notes = document.getElementById('j-notes')?.value;

    const trade = { market, strategy, result, stake, pnl, gl, notes, time: new Date().toISOString() };
    state.journal.push(trade);
    localStorage.setItem('journal', JSON.stringify(state.journal));
    renderJournal();

    // Clear form
    document.getElementById('j-stake').value = '';
    document.getElementById('j-pnl').value = '';
    document.getElementById('j-notes').value = '';
  });

  renderJournal();
}

function renderJournal() {
  const tbody = document.getElementById('journal-tbody');
  if (!tbody) return;

  if (!state.journal.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="loading-row">No trades logged yet</td></tr>';
    return;
  }

  tbody.innerHTML = state.journal.slice().reverse().map(t => {
    const win = t.result === 'win';
    const pnlClass = t.pnl >= 0 ? 'color:#10b981' : 'color:#ef4444';
    const time = new Date(t.time).toLocaleString();
    return `<tr>
      <td style="font-size:11px;color:#64748b">${time}</td>
      <td>${t.market}</td>
      <td>${t.strategy}</td>
      <td style="color:${win ? '#10b981' : '#ef4444'};font-weight:700">${win ? '✓ WIN' : '✗ LOSS'}</td>
      <td style="${pnlClass};font-family:'DM Mono',monospace">${t.pnl >= 0 ? '+' : ''}$${t.pnl?.toFixed(2)}</td>
      <td style="color:${t.gl==='yes'?'#10b981':t.gl==='partial'?'#f59e0b':'#ef4444'}">${t.gl}</td>
      <td style="font-size:11px;color:#64748b">${t.notes || '—'}</td>
    </tr>`;
  }).join('');

  // Stats
  const wins = state.journal.filter(t => t.result === 'win').length;
  const totalPnl = state.journal.reduce((a, t) => a + (t.pnl || 0), 0);
  const winRate = state.journal.length ? ((wins / state.journal.length) * 100).toFixed(1) + '%' : '0%';

  const stratWins = {};
  state.journal.forEach(t => {
    if (!stratWins[t.strategy]) stratWins[t.strategy] = { w: 0, l: 0 };
    if (t.result === 'win') stratWins[t.strategy].w++;
    else stratWins[t.strategy].l++;
  });
  let bestStrat = '—';
  let bestRate = 0;
  Object.entries(stratWins).forEach(([s, { w, l }]) => {
    const r = w / (w + l);
    if (r > bestRate && w + l >= 2) { bestRate = r; bestStrat = s; }
  });

  setElText('j-total-trades', state.journal.length);
  setElText('j-winrate', winRate);
  const pnlEl = document.getElementById('j-total-pnl');
  if (pnlEl) { pnlEl.textContent = (totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(2); pnlEl.style.color = totalPnl >= 0 ? '#10b981' : '#ef4444'; }
  setElText('j-best-strat', bestStrat);
}

// ===== INIT =====
function init() {
  initNav();
  initMarketButtons();
  initTracker();
  initJournal();
  connectWS();
  setInterval(updateClock, 1000);
  updateClock();

  // Periodic full refresh
  setInterval(() => {
    if (state.currentPage === 'dashboard') updateSignalMatrix();
    if (state.currentPage === 'dbot') updateDBotPage();
    if (state.currentPage === 'rise-fall') updateRiseFallPage();
  }, 2000);
}

document.addEventListener('DOMContentLoaded', init);
