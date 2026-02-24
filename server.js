// ===== DerivEdge Pro — Backend Server =====
// Deploy this on Render.com as a Web Service
// npm start → runs this file

const express = require('express');
const cors = require('cors');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== IN-MEMORY CACHE =====
const cache = {
  ticks: { R_10: [], R_25: [], R_50: [], R_75: [], R_100: [] },
  prices: {},
  digitStats: {},
  signals: {},
  lastUpdate: {},
};

const MARKETS = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];

// ===== DERIV WS CONNECTION (SERVER SIDE) =====
let derivWS = null;
let wsClients = new Set(); // browser clients connected via SSE

function connectToDerivWS() {
  derivWS = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

  derivWS.on('open', () => {
    console.log('[Deriv WS] Connected');
    MARKETS.forEach(mkt => {
      derivWS.send(JSON.stringify({ ticks: mkt, subscribe: 1 }));
    });
  });

  derivWS.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.msg_type === 'tick') {
        processTick(msg.tick);
      }
    } catch (e) {}
  });

  derivWS.on('close', () => {
    console.log('[Deriv WS] Disconnected, reconnecting...');
    setTimeout(connectToDerivWS, 3000);
  });

  derivWS.on('error', () => derivWS.close());
}

function processTick(tick) {
  const mkt = tick.symbol;
  const price = parseFloat(tick.quote);
  const digit = parseInt(tick.quote.toString().slice(-1));
  const epoch = tick.epoch;

  if (!cache.ticks[mkt]) cache.ticks[mkt] = [];
  cache.ticks[mkt].push({ price, digit, epoch });
  if (cache.ticks[mkt].length > 5000) cache.ticks[mkt].shift();

  cache.prices[mkt] = price;
  cache.lastUpdate[mkt] = Date.now();

  // Compute stats
  computeStats(mkt);

  // Broadcast to SSE clients
  const payload = JSON.stringify({ mkt, price, digit, epoch, stats: cache.digitStats[mkt] });
  wsClients.forEach(res => {
    try { res.write(`data: ${payload}\n\n`); } catch (e) { wsClients.delete(res); }
  });
}

function computeStats(mkt) {
  const ticks = cache.ticks[mkt];
  const last100 = ticks.slice(-100);
  const last1000 = ticks.slice(-1000);
  const last20 = ticks.slice(-20);

  // Digit counts
  const counts100 = Array(10).fill(0);
  last100.forEach(t => counts100[t.digit]++);

  const counts1000 = Array(10).fill(0);
  last1000.forEach(t => counts1000[t.digit]++);

  const total100 = last100.length || 1;
  const total1000 = last1000.length || 1;

  // Even/Odd
  const even100 = counts100.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0);
  const over5_100 = counts100.slice(5).reduce((a, b) => a + b, 0);

  // RSI calculation
  const prices = ticks.slice(-50).map(t => t.price);
  const rsi = calcRSI(prices, 14);

  // EMA
  const allPrices = ticks.map(t => t.price);
  const ema5 = calcEMA(allPrices, 5);
  const ema10 = calcEMA(allPrices, 10);
  const ema20 = calcEMA(allPrices, 20);
  const ema50 = calcEMA(allPrices, 50);
  const ema200 = calcEMA(allPrices, 200);

  // Streaks
  let evenStreak = 0, oddStreak = 0;
  for (let i = ticks.length - 1; i >= 0; i--) {
    if (ticks[i].digit % 2 === 0) evenStreak++;
    else break;
  }
  for (let i = ticks.length - 1; i >= 0; i--) {
    if (ticks[i].digit % 2 !== 0) oddStreak++;
    else break;
  }

  // Digit frequency for specific digits (1000 ticks)
  const digitPcts = counts1000.map(c => (c / total1000) * 100);

  // Price movement
  const priceChange10 = ticks.length >= 10 ?
    Math.abs(ticks[ticks.length - 1].price - ticks[ticks.length - 10].price) : 0;

  cache.digitStats[mkt] = {
    counts100, counts1000, digitPcts,
    evenPct: (even100 / total100) * 100,
    oddPct: ((total100 - even100) / total100) * 100,
    over5Pct: (over5_100 / total100) * 100,
    under5Pct: ((total100 - over5_100) / total100) * 100,
    rsi, ema5, ema10, ema20, ema50, ema200,
    evenStreak, oddStreak,
    priceChange10,
    totalTicks: ticks.length,
    last20Digits: last20.map(t => t.digit),
  };

  // Compute signals
  computeSignals(mkt);
}

function computeSignals(mkt) {
  const s = cache.digitStats[mkt];
  if (!s) return;

  const { rsi, ema5, ema10, ema20, ema50, ema200, evenStreak, oddStreak, digitPcts, priceChange10 } = s;
  const price = cache.prices[mkt];

  // Rise/Fall
  const bullTrend = ema20 > ema50 && ema50 > ema200;
  const bearTrend = ema20 < ema50 && ema50 < ema200;
  let rfSignal = 'NEUTRAL';
  if (bullTrend && rsi > 50 && rsi < 70 && price > ema50) rfSignal = 'RISE';
  else if (bearTrend && rsi < 50 && rsi > 30 && price < ema50) rfSignal = 'FALL';
  else if (rsi >= 45 && rsi <= 55) rfSignal = 'FLAT';

  // Even/Odd
  const evenCount20 = s.last20Digits?.filter(d => d % 2 === 0).length || 0;
  let eoSignal = 'NEUTRAL';
  if (evenCount20 >= 14 && rsi >= 40 && rsi <= 55) eoSignal = 'EVEN';
  else if (evenCount20 <= 6 && rsi >= 45 && rsi <= 65) eoSignal = 'ODD';
  else if (evenStreak >= 5) eoSignal = 'STREAK_ODD';
  else if (oddStreak >= 5) eoSignal = 'STREAK_EVEN';

  // Over/Under
  const lowCount20 = s.last20Digits?.filter(d => d <= 4).length || 0;
  let ouSignal = 'NEUTRAL';
  if (lowCount20 >= 14 && rsi > 55) ouSignal = 'OVER';
  else if (lowCount20 <= 6 && rsi < 45) ouSignal = 'UNDER';

  // Bot greenlight scores
  const utcH = new Date().getUTCHours();
  const inWindow = utcH >= 9 && utcH < 17;
  const priceMoving = priceChange10 >= 0.04;

  function botScore(digitIdx) {
    const pct = digitPcts[digitIdx];
    return [
      pct <= 9.0 || pct >= 11.5,
      rsi <= 32 || rsi >= 64,
      priceMoving,
      inWindow,
      true,
    ].filter(Boolean).length;
  }

  cache.signals[mkt] = {
    rfSignal, eoSignal, ouSignal,
    trend: bullTrend ? 'BULL' : bearTrend ? 'BEAR' : 'FLAT',
    rsi: rsi.toFixed(1),
    evenStreak, oddStreak,
    botScores: {
      nuclear9: botScore(9),
      zerokiller: botScore(0),
      mirror8: botScore(8),
      onestreak: botScore(1),
    },
    greenlight: rfSignal === 'RISE' || rfSignal === 'FALL',
  };
}

function calcEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  const changes = prices.slice(1).map((p, i) => p - prices[i]);
  const recent = changes.slice(-period);
  const gains = recent.filter(c => c > 0).reduce((a, b) => a + b, 0) / period;
  const losses = recent.filter(c => c < 0).map(c => -c).reduce((a, b) => a + b, 0) / period;
  if (losses === 0) return 100;
  return 100 - (100 / (1 + gains / losses));
}

// ===== SSE ENDPOINT (Real-time push to browsers) =====
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  wsClients.add(res);

  // Send initial data
  const initData = JSON.stringify({ type: 'init', prices: cache.prices, stats: cache.digitStats, signals: cache.signals });
  res.write(`data: ${initData}\n\n`);

  req.on('close', () => wsClients.delete(res));
});

// ===== REST API ENDPOINTS =====
app.get('/api/prices', (req, res) => {
  res.json({ prices: cache.prices, lastUpdate: cache.lastUpdate });
});

app.get('/api/ticks/:market', (req, res) => {
  const mkt = req.params.market.toUpperCase();
  const limit = parseInt(req.query.limit) || 100;
  const ticks = cache.ticks[mkt]?.slice(-limit) || [];
  res.json({ market: mkt, ticks, count: ticks.length });
});

app.get('/api/stats/:market', (req, res) => {
  const mkt = req.params.market.toUpperCase();
  res.json({ market: mkt, stats: cache.digitStats[mkt] || {}, signals: cache.signals[mkt] || {} });
});

app.get('/api/signals', (req, res) => {
  res.json({ signals: cache.signals, prices: cache.prices, timestamp: Date.now() });
});

app.get('/api/digit-analysis/:market', (req, res) => {
  const mkt = req.params.market.toUpperCase();
  const window = parseInt(req.query.window) || 1000;
  const ticks = cache.ticks[mkt]?.slice(-window) || [];
  const counts = Array(10).fill(0);
  ticks.forEach(t => counts[t.digit]++);
  const total = ticks.length || 1;
  const pcts = counts.map(c => ((c / total) * 100).toFixed(2));
  const cold = counts.indexOf(Math.min(...counts));
  const hot = counts.indexOf(Math.max(...counts));

  res.json({
    market: mkt, window, total,
    counts, percentages: pcts,
    coldDigit: cold, hotDigit: hot,
    evenPct: ((counts.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) / total) * 100).toFixed(2),
    over5Pct: ((counts.slice(5).reduce((a, b) => a + b, 0) / total) * 100).toFixed(2),
  });
});

// Pinescript template generator endpoint
app.post('/api/pinescript', (req, res) => {
  const { strategy, market, params } = req.body;
  const script = generatePinescript(strategy, market, params);
  res.json({ script });
});

function generatePinescript(strategy, market, params = {}) {
  const templates = {
    'rise-fall': `
//@version=5
// DerivEdge Pro — Rise/Fall Strategy
// Based on EMA + RSI + MACD Greenlight System
indicator("DerivEdge Rise/Fall", overlay=true)

// === INPUTS ===
ema20 = ta.ema(close, 20)
ema50 = ta.ema(close, 50)
ema200 = ta.ema(close, 200)
rsi = ta.rsi(close, 14)
[macdLine, signalLine, histLine] = ta.macd(close, 12, 26, 9)

// === TREND FILTER ===
bullTrend = ema20 > ema50 and ema50 > ema200
bearTrend = ema20 < ema50 and ema50 < ema200

// === ENTRY CONDITIONS ===
riseCondition = bullTrend and rsi > 50 and rsi < 70 and histLine > 0 and close > ema50
fallCondition = bearTrend and rsi < 50 and rsi > 30 and histLine < 0 and close < ema50
flatZone = rsi >= 45 and rsi <= 55

// === PLOTS ===
plot(ema20, "EMA 20", color.new(color.blue, 0), 2)
plot(ema50, "EMA 50", color.new(color.orange, 0), 2)
plot(ema200, "EMA 200", color.new(color.red, 0), 2)

bgcolor(flatZone ? color.new(color.gray, 90) : na, title="Flat Zone")
bgcolor(riseCondition ? color.new(color.green, 88) : na, title="Rise Signal")
bgcolor(fallCondition ? color.new(color.red, 88) : na, title="Fall Signal")

plotshape(riseCondition, "RISE", shape.labelup, location.belowbar, color.green, text="RISE ↑", textcolor=color.white)
plotshape(fallCondition, "FALL", shape.labeldown, location.abovebar, color.red, text="FALL ↓", textcolor=color.white)
`,
    'even-odd': `
//@version=5
// DerivEdge Pro — Even/Odd Digit Strategy
// Statistical digit behavior — NOT price behavior
indicator("DerivEdge Even/Odd Digits", overlay=false)

// This indicator works best on TICK chart (1 tick)
// Set chart to: Line chart, 1 tick

// === DIGIT EXTRACTION ===
lastDigit = math.floor(close * 10) % 10
isEven = lastDigit % 2 == 0
isOdd = not isEven

// === STREAK COUNTER ===
var int evenStreak = 0
var int oddStreak = 0
evenStreak := isEven ? evenStreak + 1 : 0
oddStreak := isOdd ? oddStreak + 1 : 0

// === RSI FILTER ===
rsi = ta.rsi(close, 14)
flatZone = rsi >= 45 and rsi <= 55

// === SIGNALS ===
// Method 1: Streak Break (5-7 in a row → bet opposite)
streakSignalEven = evenStreak >= 5
streakSignalOdd = oddStreak >= 5

// Method 2: RSI Confirmation
evenEntry = isEven and rsi >= 40 and rsi <= 55
oddEntry = isOdd and rsi >= 45 and rsi <= 65

// === PLOTS ===
plot(evenStreak, "Even Streak", color.blue)
plot(oddStreak, "Odd Streak", color.purple)
plot(5, "Streak Alert Level", color.yellow, linewidth=1, style=plot.style_line)

bgcolor(streakSignalEven ? color.new(color.purple, 80) : na, title="Consider ODD")
bgcolor(streakSignalOdd ? color.new(color.blue, 80) : na, title="Consider EVEN")
bgcolor(flatZone ? color.new(color.gray, 90) : na, title="No Trade Zone")

plotshape(streakSignalEven and not streakSignalEven[1], "Bet ODD", shape.triangledown, location.top, color.purple, text="BET ODD")
plotshape(streakSignalOdd and not streakSignalOdd[1], "Bet EVEN", shape.triangleup, location.bottom, color.blue, text="BET EVEN")
`,
    'over-under': `
//@version=5
// DerivEdge Pro — Over/Under Strategy
// Under: last digit 0-4 | Over: last digit 5-9
indicator("DerivEdge Over/Under", overlay=false)

lastDigit = math.floor(close * 10) % 10
isLow = lastDigit <= 4  // 0-4
isHigh = lastDigit >= 5  // 5-9

// === MOMENTUM FILTER ===
rsi = ta.rsi(close, 14)
ema5 = ta.ema(close, 5)
ema20 = ta.ema(close, 20)

// === BOLLINGER BANDS ===
[bbMid, bbUpper, bbLower] = ta.bb(close, 20, 2)
bbWidth = bbUpper - bbLower

// === ENTRY CONDITIONS ===
overEntry = isLow and rsi > 55 and ema5 > ema20  // Low digits → bet OVER
underEntry = isHigh and rsi < 45 and ema5 < ema20  // High digits → bet UNDER

// === VISUAL ===
barcolor(isLow ? color.green : color.red)
plot(rsi, "RSI", color.yellow)
plot(55, "RSI Over Level", color.green, linewidth=1)
plot(45, "RSI Under Level", color.red, linewidth=1)
plot(50, "RSI Mid", color.gray, linewidth=1)

plotshape(overEntry, "OVER", shape.labelup, location.bottom, color.green, text="OVER ▲")
plotshape(underEntry, "UNDER", shape.labeldown, location.top, color.red, text="UNDER ▼")
`,
  };
  return templates[strategy] || '// Strategy not found';
}

// ===== DBOT XML GENERATOR =====
app.post('/api/dbot-xml', (req, res) => {
  const { botType, digit, market, stake, takeProfit, stopLoss } = req.body;
  const xml = generateDBotXML({ botType, digit, market, stake, takeProfit, stopLoss });
  res.json({ xml });
});

function generateDBotXML({ botType = 'nuclear9', digit = 9, market = 'R_75', stake = 1, takeProfit = 12, stopLoss = 7 }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<xml xmlns="https://developers.google.com/blockly/xml">
  <!-- DerivEdge Pro — ${botType.toUpperCase()} Bot -->
  <!-- Digit: ${digit} | Market: ${market} | Stake: $${stake} -->
  <block type="trade" x="10" y="10">
    <field name="MARKET_TYPE">digits</field>
    <field name="SYMBOL">${market}</field>
    <field name="CONTRACT_TYPE">DIGITMATCH</field>
    <field name="DURATION">1</field>
    <field name="DURATION_TYPE">t</field>
    <field name="AMOUNT">${stake}</field>
    <field name="PREDICTION">${digit}</field>
    <next>
      <block type="trade_result_block">
        <statement name="AFTER_PURCHASE">
          <block type="variables_set">
            <field name="VAR">lastResult</field>
            <value name="VALUE">
              <block type="read_result">
                <field name="RESULT_TYPE">profit</field>
              </block>
            </value>
          </block>
        </statement>
      </block>
    </next>
  </block>
</xml>`;
}

// ===== SERVE FRONTEND =====
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== START =====
server.listen(PORT, () => {
  console.log(`[DerivEdge Pro] Server running on port ${PORT}`);
  connectToDerivWS();
});

module.exports = app;
