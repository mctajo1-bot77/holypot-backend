# Holypot Trading – Integraciones con APIs Externas

> Última revisión contra el backend real: 2026-02-15
> Fuente: `index.js` + `prisma/schema.prisma`

---

## 1. Finnhub – Precios en Tiempo Real

**Rol:** Única fuente de precios de mercado. El backend suscribe por WebSocket y distribuye a clientes via Socket.io.

| Dato | Valor |
|------|-------|
| Sitio | https://finnhub.io |
| Autenticación | API Key via query param: `wss://ws.finnhub.io?token=<FINNHUB_API_KEY>` |
| Variable de entorno | `FINNHUB_API_KEY` |
| Tier | Free tier (60 req/min REST; WebSocket sin límite explícito documentado) |
| Protocolo usado | **Solo WebSocket** (`wss://ws.finnhub.io`) – no se usan endpoints REST de Finnhub |

### Símbolos exactos enviados a Finnhub

| Símbolo Frontend | Símbolo Finnhub (exacto) | Tipo |
|-----------------|--------------------------|------|
| `EURUSD` | `OANDA:EUR_USD` | FX |
| `GBPUSD` | `OANDA:GBP_USD` | FX |
| `USDJPY` | `OANDA:USD_JPY` | FX |
| `XAUUSD` | `OANDA:XAU_USD` | Commodities |
| `SPX500` | `OANDA:SPX500` | Index |
| `NAS100` | `OANDA:NAS100` | Index |

> El símbolo `OANDA:` es solo el **formato de símbolo de Finnhub** para ese feed de precios.
> **OANDA no se usa como API separada** (ver sección 2).

### Suscripción (código real en `index.js`)

```javascript
const symbols = {
  EURUSD: 'EUR_USD',
  GBPUSD: 'GBP_USD',
  USDJPY: 'USD_JPY',
  XAUUSD: 'XAU_USD',
  SPX500: 'SPX500',
  NAS100: 'NAS100'
};

// Suscripción al WebSocket de Finnhub
Object.values(symbols).forEach(finnhubSym => {
  socketFinnhub.send(JSON.stringify({ type: 'subscribe', symbol: `OANDA:${finnhubSym}` }));
});

// Parsing del mensaje recibido
let symbol = fullSym.replace('OANDA:', '');
symbol = symbol.replace('_USD', 'USD').replace('_JPY', 'JPY');
// Resultado: 'EURUSD', 'GBPUSD', etc. – formato usado internamente
```

### Flujo en el Sistema

```
Finnhub WebSocket (wss://ws.finnhub.io)
  → Backend recibe precio { s: "OANDA:EUR_USD", p: 1.0870 }
  → Normaliza símbolo a "EURUSD"
  → Actualiza cache en memoria (livePrices)
  → Recalcula P&L de posiciones abiertas
  → Guarda vela OHLC en DailyCandle (DB)
  → io.emit('liveUpdate', { positions, livePrices, liveCapital })
  → Frontend Dashboard recibe actualización ~cada 1s
```

---

## 2. OANDA

**OANDA NO se usa como API en este backend.**

El prefijo `OANDA:` que aparece en el código es el formato de símbolo que usa **Finnhub** para identificar ese feed de datos. No hay llamadas a ningún endpoint de la API de OANDA (`developer.oanda.com`).

| Lo que el frontend infería | Realidad |
|---------------------------|---------|
| Datos de velas de OANDA | Las velas vienen de Finnhub (guardadas en tabla `DailyCandle`) |
| Validación de spreads de OANDA | No implementado |
| Precios históricos de OANDA | No implementado |

### Endpoint de velas (`/api/candles/{symbol}`)

Sirve datos de la tabla `DailyCandle`, construida a partir de los precios de Finnhub en tiempo real:

```
GET /api/candles/{symbol}?from=...
← array OHLC de la tabla DailyCandle (PostgreSQL)
```

---

## 3. NOWPayments – Pagos USDT On-Chain

**Rol:** Pasarela de pagos cripto para el fee de entrada y el pago de premios.

| Dato | Valor |
|------|-------|
| Sitio | https://nowpayments.io |
| Autenticación REST | Header `x-api-key: <NOWPAYMENTS_API_KEY>` |
| Variable de entorno | `NOWPAYMENTS_API_KEY` |
| Base URL | `https://api.nowpayments.io/v1` |
| Red USDT | **TRC-20** (`pay_currency: "usdttrc20"`) |
| Endpoint de pago | `POST /v1/invoice` (no `/v1/payment`) |
| Endpoint de payout | `POST /v1/payout` |
| Endpoint de balance | `GET /v1/balance` |

### Red confirmada: TRC-20

```javascript
// Valor exacto en index.js
pay_currency: "usdttrc20"
price_currency: "usd"
```

### Flujo de Pago (cobro de fee de entrada)

```
1. Backend crea invoice → NOWPayments:
   POST https://api.nowpayments.io/v1/invoice
   {
     price_amount: 12 | 59 | 107,
     price_currency: "usd",
     pay_currency: "usdttrc20",
     order_id: entryId,
     order_description: "Holypot {level} Entry",
     ipn_callback_url: "{BACKEND_URL}/webhook/nowpayments",
     success_url: "{FRONTEND_URL}/dashboard",
     cancel_url: "{FRONTEND_URL}/"
   }

2. NOWPayments responde → { invoice_url, id }
3. Frontend redirige usuario a invoice_url
4. Usuario paga USDT (TRC-20) desde su wallet
5. NOWPayments llama webhook:
   POST /webhook/nowpayments
   { payment_status, order_id (=entryId), payment_id, actually_paid }
6. Backend actualiza Entry.status = 'confirmed'
```

### Manejo de estados del webhook

| Estado NOWPayments | Acción en Backend |
|-------------------|------------------|
| `waiting` | Sin acción |
| `confirming` | Sin acción |
| `finished` | **Activar entry** → `Entry.status = 'confirmed'` |
| `confirmed` | **Activar entry** → `Entry.status = 'confirmed'` |
| `partially_paid` | **Sin acción** – no está implementado el manejo parcial |
| `failed` | Sin acción explícita (entry queda en `pending`) |
| `expired` | Sin acción explícita (entry queda en `pending`) |

> **Nota:** El backend verifica `payment_status === 'finished' || payment_status === 'confirmed'`.
> El status `partially_paid` actualmente no se maneja.

### Verificación del Webhook (IPN)

```javascript
// Header a verificar:
// x-nowpayments-sig: HMAC-SHA512 del payload ordenado
// Variable de entorno: NOWPAYMENTS_IPN_SECRET
```

---

## 4. hCaptcha – Protección Anti-Bot en Registro

**Rol:** Evitar registros automatizados.

| Dato | Valor |
|------|-------|
| Sitio | https://www.hcaptcha.com |
| Sitekey (Frontend) | `a0b26f92-ba34-47aa-be42-c936e488a6f4` |
| Variable de entorno | `HCAPTCHA_SECRET` |
| Endpoint de verificación | `POST https://hcaptcha.com/siteverify` |

### Flujo

```
1. LandingPage renderiza widget hCaptcha con sitekey
2. Usuario completa captcha → hCaptcha devuelve token
3. Frontend envía token en POST /api/create-payment { captchaToken, ... }
4. Backend verifica:
   POST https://hcaptcha.com/siteverify
   { secret: process.env.HCAPTCHA_SECRET, response: captchaToken }
5. Si { success: true } → continúa el registro
```

---

## 5. TradingView Widget – Charts de Mercado

**Rol:** Gráfico de mercado en tiempo real en el Dashboard principal.
**Nota:** El frontend usa este widget directamente via CDN. El backend no interviene.

| Dato | Valor |
|------|-------|
| Fuente | Script CDN de TradingView |
| Autenticación | Ninguna (widget público) |
| Datos | TradingView propios (independiente de Finnhub/OANDA) |

> Los símbolos exactos del widget están en `TradingViewChart.jsx` del frontend.
> Son independientes de los que usa el backend para calcular P&L.

---

## 6. Socket.io – Comunicación en Tiempo Real

**Rol:** Actualizaciones en vivo sin polling HTTP.

| Dato | Valor |
|------|-------|
| Librería servidor | `socket.io` |
| Librería cliente | `socket.io-client` |
| URL | `process.env.FRONTEND_URL` (CORS allowlist) |
| Transports | `websocket` con fallback a `polling` |

### Autenticación WebSocket

**NO implementada.** El servidor Socket.io no tiene:
- Middleware `io.use()` para verificar JWT
- Handler `io.on('connection')` para identificar clientes

Las emisiones son broadcasts a **todos los clientes conectados** sin distinción:

```javascript
io.emit('liveUpdate', dataToEmit);       // a todos
io.emit('tradeClosedAuto', { ... });     // a todos
```

> Cualquier cliente puede conectarse sin JWT. Los datos enviados en `liveUpdate`
> contienen las posiciones del usuario autenticado (identificado por `holypotEntryId`
> en el lado del frontend), pero el backend no filtra por conexión.

### Eventos

| Evento | Emisor | Receptor | Payload |
|--------|--------|----------|---------|
| `liveUpdate` | Backend (~1s) | Dashboard, AdminDashboard | `{ positions, livePrices, liveCapital }` |
| `tradeClosedAuto` | Backend (TP/SL hit) | Dashboard | `{ reason: 'TP_hit'\|'SL_hit', position: {...} }` |

### Configuración del servidor

```javascript
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true
  }
});
```

---

## Variables de Entorno Requeridas

```env
# NOWPayments
NOWPAYMENTS_API_KEY=...
NOWPAYMENTS_IPN_SECRET=...

# Finnhub
FINNHUB_API_KEY=...

# hCaptcha
HCAPTCHA_SECRET=...

# Base de datos
DATABASE_URL=postgresql://...

# App
FRONTEND_URL=https://...
JWT_SECRET=...
```
