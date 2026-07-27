const BASE = 'https://fapi.binance.com';
const timeframes = ['5m', '15m', '1h', '4h'];

async function get(path) {
  const response = await fetch(`${BASE}${path}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

const [time, premium, openInterest, aggregateTrades, exchange, ...klines] =
  await Promise.all([
    get('/fapi/v1/time'),
    get('/fapi/v1/premiumIndex?symbol=BTCUSDT'),
    get('/fapi/v1/openInterest?symbol=BTCUSDT'),
    get('/fapi/v1/aggTrades?symbol=BTCUSDT&limit=10'),
    get('/fapi/v1/exchangeInfo'),
    ...timeframes.map((timeframe) =>
      get(`/fapi/v1/klines?symbol=BTCUSDT&interval=${timeframe}&limit=251`),
    ),
  ]);

if (!Number.isFinite(time.serverTime)) throw new Error('Invalid server time');
if (premium.symbol !== 'BTCUSDT') throw new Error('Invalid premium symbol');
if (openInterest.symbol !== 'BTCUSDT')
  throw new Error('Invalid open-interest symbol');
if (!Array.isArray(aggregateTrades) || aggregateTrades.length === 0)
  throw new Error('Aggregate-trade REST fallback returned no rows');
if (
  !exchange.symbols.some(
    (item) => item.symbol === 'BTCUSDT' && item.contractType === 'PERPETUAL',
  )
)
  throw new Error('BTCUSDT perpetual product missing');
for (const [index, rows] of klines.entries())
  if (!Array.isArray(rows) || rows.length < 250)
    throw new Error(`${timeframes[index]} returned fewer than 250 candles`);

const streams = ['btcusdt@bookTicker', 'btcusdt@depth20@100ms'];
const received = new Set();
await Promise.all(
  streams.map(
    (stream) =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`wss://fstream.binance.com/ws/${stream}`);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error(`WebSocket smoke timeout for ${stream}`));
        }, 30_000);
        socket.addEventListener('message', (event) => {
          const payload = JSON.parse(String(event.data));
          if (payload.s !== 'BTCUSDT') {
            clearTimeout(timer);
            socket.close();
            reject(
              new Error(
                `Unexpected ${stream} payload: ${JSON.stringify(payload).slice(0, 300)}`,
              ),
            );
            return;
          }
          received.add(stream);
          clearTimeout(timer);
          socket.close();
          resolve();
        });
        socket.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error(`WebSocket smoke connection failed for ${stream}`));
        });
      }),
  ),
);

console.log(
  `Binance public smoke passed: ${timeframes.length} timeframes, aggregate-trade REST fallback, ${received.size} real-time streams.`,
);
