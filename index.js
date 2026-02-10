require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const http = require('http');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const cron = require('node-cron');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const z = require('zod');
const cookieParser = require('cookie-parser');

const JWT_SECRET = process.env.JWT_SECRET || 'holypotsecret2026';

const app = express();
app.set('trust proxy', 1);
app.use(cookieParser());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json());

const prisma = new PrismaClient();

const NOWPAYMENTS_API = 'https://api.nowpayments.io/v1';
const API_KEY = process.env.NOWPAYMENTS_API_KEY;

// ADMIN CREDENTIALS
const ADMIN_EMAIL = 'admin@holypot.com';
const ADMIN_PASSWORD = 'holypotadmin2026';

// ========== COOKIE CONFIG PARA CROSS-SITE (Render) ==========
function getCookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000
  };
}
// =============================================================

// Configuración única de niveles
const levelsConfig = {
  basic: { name: "Basic", entryPrice: 12, comision: 2, initialCapital: 10000 },
  medium: { name: "Medium", entryPrice: 54, comision: 4, initialCapital: 50000 },
  premium: { name: "Premium", entryPrice: 107, comision: 7, initialCapital: 100000 }
};

// Finnhub WebSocket real-time prices
const livePrices = {};

const socketFinnhub = new WebSocket(`wss://ws.finnhub.io?token=${process.env.FINNHUB_API_KEY}`);

socketFinnhub.on('open', () => {
  console.log('Finnhub WebSocket conectado – suscribiendo activos 🚀');

  const symbols = {
    EURUSD: 'EUR_USD',
    GBPUSD: 'GBP_USD',
    USDJPY: 'USD_JPY',
    XAUUSD: 'XAU_USD',
    SPX500: 'SPX500',
    NAS100: 'NAS100'
  };

  Object.keys(symbols).forEach(key => {
    const finnhubSym = symbols[key];
    socketFinnhub.send(JSON.stringify({ type: 'subscribe', symbol: `OANDA:${finnhubSym}` }));
    console.log(`Suscripto a OANDA:${finnhubSym}`);
  });
});

socketFinnhub.on('message', async (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'trade' && msg.data) {
    for (const t of msg.data) {
      let fullSym = t.s;
      let symbol = fullSym.replace('OANDA:', '');
      symbol = symbol.replace('_USD', 'USD').replace('_JPY', 'JPY');
      const price = t.p;
      livePrices[symbol] = price;

      const nowSec = Math.floor(Date.now() / 1000);
      const currentMinute = Math.floor(nowSec / 60) * 60;

      const candleDate = new Date(currentMinute * 1000);
      candleDate.setUTCHours(0, 0, 0, 0);

      try {
        const existing = await prisma.dailyCandle.findUnique({
          where: {
            symbol_date_time: {
              symbol: symbol.toUpperCase(),
              date: candleDate,
              time: currentMinute
            }
          }
        });

        if (existing) {
          await prisma.dailyCandle.update({
            where: {
              symbol_date_time: {
                symbol: symbol.toUpperCase(),
                date: candleDate,
                time: currentMinute
              }
            },
            data: {
              high: Math.max(existing.high, price),
              low: Math.min(existing.low, price),
              close: price
            }
          });
        } else {
          await prisma.dailyCandle.create({
            data: {
              symbol: symbol.toUpperCase(),
              date: candleDate,
              time: currentMinute,
              open: price,
              high: price,
              low: price,
              close: price
            }
          });
        }
      } catch (err) {
        console.error('Error vela 1min:', err);
      }
    }
    emitLiveData();
  }
});

socketFinnhub.on('error', (err) => console.error('Finnhub WS error:', err));
socketFinnhub.on('close', () => {
  console.warn('Finnhub WS cerrado – reconectando en 5s');
  setTimeout(() => new WebSocket(`wss://ws.finnhub.io?token=${process.env.FINNHUB_API_KEY}`), 5000);
});

function getCurrentPrice(symbol) {
  return livePrices[symbol] || null;
}

const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ["GET", "POST"],
    credentials: true
  }
});

// RATE LIMITING
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Demasiados intentos – espera 15 min'
});
app.use('/api/login', loginLimiter);
app.use('/api/admin-login', loginLimiter);

const tradeLimiter = rateLimit({
  windowMs: 1000,
  max: 3,
  message: 'Demasiados trades rápidos – espera'
});
app.use('/api/open-trade', tradeLimiter);

// Helper: Extraer token de Authorization header O cookie
function getToken(req) {
  // 1. Authorization: Bearer <token> (PRIORIDAD)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // 2. Cookie fallback
  if (req.cookies && req.cookies.holypotToken) {
    return req.cookies.holypotToken;
  }
  return null;
}

// JWT middleware general – Soporta Authorization header + cookie
function authenticateToken(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Token required" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token invalid" });
    req.user = user;
    next();
  });
}

// JWT middleware ADMIN – Soporta Authorization header + cookie
function authenticateAdmin(req, res, next) {
  const token = getToken(req);
  console.log('🔐 authenticateAdmin – token presente:', !!token, '– fuente:', req.headers.authorization ? 'header' : 'cookie');
  if (!token) return res.status(401).json({ error: "Token required" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err || !user || user.email !== ADMIN_EMAIL) {
      console.log('❌ authenticateAdmin – rechazado:', err ? err.message : 'email no coincide');
      return res.status(403).json({ error: "Acceso admin denegado" });
    }
    console.log('✅ authenticateAdmin – admin verificado via', req.headers.authorization ? 'header' : 'cookie');
    req.user = user;
    next();
  });
}

// /api/me
app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, email: true, nickname: true, walletAddress: true }
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    const isAdmin = req.user.role === 'admin';
    res.json({ user: { ...user, role: isAdmin ? 'admin' : 'user' } });
  } catch (error) {
    console.error('Error /api/me:', error);
    res.status(500).json({ error: "Error interno" });
  }
});

async function emitLiveData() {
  try {
    const entries = await prisma.entry.findMany({
      include: { user: true, positions: true }
    });

    const dataToEmit = await Promise.all(entries.map(async (entry) => {
      let liveCapital = entry.virtualCapital;

      const openPositions = entry.positions.filter(p => !p.closedAt);

      openPositions.forEach(p => {
        const currentPrice = getCurrentPrice(p.symbol);
        if (currentPrice && p.entryPrice) {
          const sign = p.direction === 'long' ? 1 : -1;
          const pnlPercent = sign * ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
          const pnlAmount = entry.virtualCapital * (p.lotSize || 0) * (pnlPercent / 100);
          liveCapital += pnlAmount;
        }
      });

      // CIERRE AUTOMÁTICO TP/SL
      await Promise.all(openPositions.map(async (p) => {
        const currentPrice = getCurrentPrice(p.symbol);
        if (!currentPrice) return;

        let shouldClose = false;
        let reason = '';

        if (p.takeProfit || p.stopLoss) {
          if (p.direction === 'long') {
            if (p.takeProfit && currentPrice >= p.takeProfit) { shouldClose = true; reason = 'TP_hit'; }
            if (p.stopLoss && currentPrice <= p.stopLoss) { shouldClose = true; reason = 'SL_hit'; }
          } else {
            if (p.takeProfit && currentPrice <= p.takeProfit) { shouldClose = true; reason = 'TP_hit'; }
            if (p.stopLoss && currentPrice >= p.stopLoss) { shouldClose = true; reason = 'SL_hit'; }
          }
        }

        if (shouldClose) {
          const sign = p.direction === 'long' ? 1 : -1;
          const pnlPercent = sign * ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
          const pnlAmount = entry.virtualCapital * (p.lotSize || 0) * (pnlPercent / 100);

          await prisma.entry.update({
            where: { id: entry.id },
            data: { virtualCapital: entry.virtualCapital + pnlAmount }
          });

          await prisma.position.update({
            where: { id: p.id },
            data: { closedAt: new Date(), currentPnl: pnlPercent, closeReason: reason }
          });

          io.emit('tradeClosedAuto', {
            entryId: entry.id,
            positionId: p.id,
            reason,
            pnlPercent: pnlPercent.toFixed(4),
            pnlAmount: pnlAmount.toFixed(2)
          });
        }
      }));

      const liveCapitalInt = Math.floor(liveCapital);

      return {
        entryId: entry.id,
        liveCapital: liveCapitalInt,
        positions: entry.positions.map(p => {
          const currentPrice = getCurrentPrice(p.symbol);
          const livePnl = !p.closedAt && currentPrice && p.entryPrice
            ? (p.direction === 'long' ? 1 : -1) * ((currentPrice - p.entryPrice) / p.entryPrice) * 100
            : (p.currentPnl || 0);

          return {
            id: p.id,
            symbol: p.symbol,
            direction: p.direction,
            lotSize: p.lotSize || 0.01,
            entryPrice: p.entryPrice,
            livePnl: livePnl.toFixed(4),
            takeProfit: p.takeProfit || null,
            stopLoss: p.stopLoss || null
          };
        }),
        livePrices: livePrices
      };
    }));

    io.emit('liveUpdate', dataToEmit);
  } catch (error) {
    console.error('Error emitLiveData:', error);
  }
}

// Emit live data cada segundo
setInterval(emitLiveData, 1000);

// LOGOUT
app.post('/api/logout', (req, res) => {
  res.clearCookie('holypotToken', {
    httpOnly: true,
    secure: true,
    sameSite: 'none'
  });
  res.json({ success: true });
});

// REGISTER
app.post('/api/register', async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    walletAddress: z.string(),
    nickname: z.string().min(3)
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  const { email, password, walletAddress, nickname } = parsed.data;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const existingNick = await prisma.user.findUnique({ where: { nickname } });
    if (existingNick) return res.status(400).json({ error: "Nickname ya usado – elige otro" });

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        walletAddress,
        nickname,
        emailVerified: false
      }
    });

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('holypotToken', token, getCookieOptions());

    res.json({ success: true, token });
  } catch (error) {
    res.status(500).json({ error: "Error register", details: error.message });
  }
});

// Login normal
app.post('/api/login', async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    password: z.string().min(8)
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  const { email, password } = parsed.data;

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.password) return res.status(400).json({ error: "User not found or no password" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: "Password incorrect" });

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('holypotToken', token, getCookieOptions());

    res.json({ success: true, token });
  } catch (error) {
    res.status(500).json({ error: "Error login", details: error.message });
  }
});

// Login admin exclusivo
app.post('/api/admin-login', async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    password: z.string()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  const { email, password } = parsed.data;

  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Credenciales admin inválidas" });
  }

  const token = jwt.sign({ email: ADMIN_EMAIL, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });

  res.cookie('holypotToken', token, getCookieOptions());

  res.json({ success: true, token });
});

// GET para /api/admin-login (evita "Cannot GET")
app.get('/api/admin-login', (req, res) => {
  res.status(405).json({ error: "Método GET no permitido – usa POST para login admin" });
});

// Webhook NowPayments
app.post('/api/webhook-nowpayments', express.raw({type: 'application/json'}), async (req, res) => {
  const body = req.body.toString();
  const signature = req.headers['x-nowpayments-sig'];
  const secret = process.env.NOWPAYMENTS_SECRET;
  if (secret) {
    const hash = crypto.createHmac('sha512', secret)
      .update(body)
      .digest('hex');
    if (hash !== signature) {
      console.warn('Webhook HMAC inválido');
      return res.status(401).send('Invalid signature');
    }
  }

  try {
    const data = JSON.parse(body);
    if (data.payment_status === 'finished' || data.payment_status === 'confirmed') {
      await prisma.entry.updateMany({
        where: { paymentId: data.payment_id.toString() },
        data: { status: "confirmed" }
      });
      emitLiveData();
    }
    res.status(200).send('OK');
  } catch (error) {
    res.status(400).send('Invalid');
  }
});

// Competencias activas
app.get('/api/competitions/active', async (req, res) => {
  try {
    const entries = await prisma.entry.findMany({
      where: { status: "confirmed" },
      include: { user: true }
    });

    const competitions = Object.entries(levelsConfig).map(([level, config]) => {
      const confirmed = entries.filter(e => e.level === level);
      const participants = confirmed.length;
      const ingresos = participants * config.entryPrice;
      const revenue = participants * config.comision;
      const prizePool = ingresos - revenue;

      const now = new Date();
      const utcNow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds());
      const endOfDayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59);
      const msLeft = endOfDayUTC - utcNow;
      const hoursLeft = Math.floor(msLeft / (1000 * 60 * 60));
      const minutesLeft = Math.floor((msLeft % (1000 * 60 * 60)) / (1000 * 60));

      return {
        level,
        name: config.name,
        entryPrice: config.entryPrice,
        initialCapital: config.initialCapital,
        participants,
        prizePool,
        timeLeft: `${hoursLeft}h ${minutesLeft}m`
      };
    });

    res.json(competitions);
  } catch (error) {
    res.status(500).json({ error: "Error cargando competencias", details: error.message });
  }
});

// Create payment CON BLOQUEO 18:00 UTC
app.post('/api/create-payment', async (req, res) => {
  const {
    email, password, walletAddress,
    fullName, country, birthDate,
    level, acceptTerms
  } = req.body;

  if (!acceptTerms) return res.status(400).json({ error: 'Debes aceptar términos y condiciones' });

  if (!levelsConfig[level]) return res.status(400).json({ error: 'Nivel inválido' });

  const now = new Date();
  const utcHour = now.getUTCHours();
  if (utcHour >= 18) {
    return res.status(400).json({ error: 'Inscripciones cerradas después de las 18:00 UTC. ¡Vuelve mañana a las 00:00 UTC!' });
  }

  const { entryPrice: total, initialCapital: capital } = levelsConfig[level];

  try {
    let user = await prisma.user.findUnique({ where: { email } });
    if (user && user.password) {
    } else {
      const hashedPassword = password ? await bcrypt.hash(password, 10) : undefined;
      user = await prisma.user.upsert({
        where: { email },
        update: {
          walletAddress,
          password: hashedPassword
        },
        create: {
          email,
          walletAddress,
          password: hashedPassword
        }
      });
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    const response = await axios.post(`${NOWPAYMENTS_API}/invoice`, {
      price_amount: total,
      price_currency: "usd",
      pay_currency: "usdttrc20",
      ipn_callback_url: `${process.env.BACKEND_URL || 'https://holypot-backend.onrender.com'}/api/webhook-nowpayments`,
      order_description: `Inscripción Holypot ${level.toUpperCase()} - ${email}`,
      success_url: `${process.env.FRONTEND_URL || 'https://holypot-landing.onrender.com'}/dashboard`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://holypot-landing.onrender.com'}/`
    }, {
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' }
    });

    const paymentData = response.data;

    const entry = await prisma.entry.create({
      data: {
        user: { connect: { id: user.id } },
        level,
        paymentId: paymentData.id,
        status: "pending",
        virtualCapital: capital
      }
    });

    res.json({
      message: "Pago creado – redirigiendo...",
      paymentUrl: paymentData.invoice_url,
      token,
      entryId: entry.id
    });
  } catch (error) {
    res.status(500).json({ error: 'Error creando pago', details: error.response?.data || error.message });
  }
});

// Confirm entry manual
app.post('/api/confirm-entry', async (req, res) => {
  const { entryId } = req.body;
  try {
    await prisma.entry.update({
      where: { id: entryId },
      data: { status: "confirmed" }
    });
    emitLiveData();
    res.json({ message: "Entry confirmada manualmente (test)" });
  } catch (error) {
    res.status(500).json({ error: "Error confirm entry" });
  }
});

// Manual confirm
app.post('/api/manual-confirm', async (req, res) => {
  const { email, level } = req.body;
  if (!email || !level) return res.status(400).json({ error: "Email and level required" });
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(400).json({ error: "User not found – regístrate primero en landing" });
    const entry = await prisma.entry.findFirst({
      where: { userId: user.id, level, status: "pending" },
      orderBy: { id: 'desc' }
    });
    if (!entry) return res.status(400).json({ error: "No pending entry – llena formulario en landing primero" });
    await prisma.entry.update({
      where: { id: entry.id },
      data: { status: "confirmed" }
    });
    emitLiveData();
    res.json({
      message: "¡Entry confirmada manualmente! Capital virtual activado – ve al dashboard",
      entryId: entry.id
    });
  } catch (error) {
    res.status(500).json({ error: "Error manual confirm", details: error.message });
  }
});

// OPEN TRADE
app.post('/api/open-trade', authenticateToken, async (req, res) => {
  const { entryId, symbol, direction, lotSize, takeProfit, stopLoss } = req.body;
  const dir = direction.toLowerCase();
  if (!['long', 'short'].includes(dir)) return res.status(400).json({ error: "Direction long/short" });
  const currentPrice = getCurrentPrice(symbol);
  if (!currentPrice) return res.status(400).json({ error: "Precio no disponible" });
  if (lotSize < 0.01 || lotSize > 1.0) return res.status(400).json({ error: "LotSize 0.01-1.0" });

  try {
    const entry = await prisma.entry.findUnique({
      where: { id: entryId },
      include: { positions: { where: { closedAt: null } } }
    });
    if (!entry || entry.status !== "confirmed") return res.status(400).json({ error: "Entry no confirmada" });

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const tradesToday = await prisma.position.count({
      where: { entryId, openedAt: { gte: todayStart } }
    });
    if (tradesToday >= 20) return res.status(400).json({ error: "Límite 20 trades/día" });

    const openLot = entry.positions.reduce((sum, p) => sum + (p.lotSize || 0), 0);
    if (openLot + lotSize > 1.0) return res.status(400).json({ error: "Máximo 1.0 lot total abierto" });

    if (takeProfit !== undefined && takeProfit !== null) {
      const tp = parseFloat(takeProfit);
      if (dir === 'long' && tp <= currentPrice) return res.status(400).json({ error: "TP debe ser mayor al precio actual en LONG" });
      if (dir === 'short' && tp >= currentPrice) return res.status(400).json({ error: "TP debe ser menor al precio actual en SHORT" });
    }
    if (stopLoss !== undefined && stopLoss !== null) {
      const sl = parseFloat(stopLoss);
      if (dir === 'long' && sl >= currentPrice) return res.status(400).json({ error: "SL debe ser menor al precio actual en LONG" });
      if (dir === 'short' && sl <= currentPrice) return res.status(400).json({ error: "SL debe ser mayor al precio actual en SHORT" });
    }

    await prisma.position.create({
      data: {
        entryId,
        symbol,
        direction: dir,
        lotSize,
        entryPrice: currentPrice,
        takeProfit: takeProfit ? parseFloat(takeProfit) : null,
        stopLoss: stopLoss ? parseFloat(stopLoss) : null
      }
    });

    emitLiveData();

    res.json({ message: `¡Trade abierto! ${dir.toUpperCase()} ${symbol} ${lotSize} lot a ${currentPrice.toFixed(2)}` });
  } catch (error) {
    res.status(500).json({ error: "Error open trade", details: error.message });
  }
});

// CLOSE TRADE
app.post('/api/close-trade', authenticateToken, async (req, res) => {
  const { positionId } = req.body;

  try {
    const position = await prisma.position.findUnique({
      where: { id: positionId },
      include: { entry: true }
    });
    if (!position || position.closedAt) return res.status(400).json({ error: "Position no abierta" });

    const currentPrice = getCurrentPrice(position.symbol);
    if (!currentPrice) return res.status(400).json({ error: "Precio temporalmente no disponible para cerrar" });

    const sign = position.direction === "long" ? 1 : -1;
    const pnlPercent = sign * ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    const pnlAmount = position.entry.virtualCapital * (position.lotSize || 0) * (pnlPercent / 100);

    await prisma.entry.update({
      where: { id: position.entryId },
      data: { virtualCapital: position.entry.virtualCapital + pnlAmount }
    });

    await prisma.position.update({
      where: { id: positionId },
      data: { closedAt: new Date(), currentPnl: pnlPercent }
    });

    emitLiveData();

    res.json({
      message: `¡Trade cerrado! P&L: ${pnlPercent.toFixed(2)}% (${pnlAmount > 0 ? '+' : ''}${pnlAmount.toFixed(2)})`,
      newVirtualCapital: position.entry.virtualCapital + pnlAmount
    });
  } catch (error) {
    res.status(500).json({ error: "Error close trade", details: error.message });
  }
});

// EDIT POSITION
app.post('/api/edit-position', authenticateToken, async (req, res) => {
  const { positionId, lotSize, takeProfit, stopLoss } = req.body;
  if (!positionId) return res.status(400).json({ error: "positionId required" });

  try {
    const position = await prisma.position.findUnique({
      where: { id: positionId },
      include: { entry: { include: { positions: true } } }
    });
    if (!position || position.closedAt) return res.status(400).json({ error: "Position no abierta" });

    const currentOpenLot = position.entry.positions
      .filter(p => !p.closedAt && p.id !== positionId)
      .reduce((sum, p) => sum + (p.lotSize || 0), 0);
    const newLot = lotSize ? parseFloat(lotSize) : position.lotSize;
    if (currentOpenLot + newLot > 1.0) return res.status(400).json({ error: "Máximo 1.0 lot total abierto" });

    await prisma.position.update({
      where: { id: positionId },
      data: {
        lotSize: newLot,
        takeProfit: takeProfit ? parseFloat(takeProfit) : position.takeProfit,
        stopLoss: stopLoss ? parseFloat(stopLoss) : position.stopLoss
      }
    });

    emitLiveData();
    res.json({ message: "Position editada – lotSize, TP/SL actualizados" });
  } catch (error) {
    res.status(500).json({ error: "Error edit position" });
  }
});

// MY-POSITIONS
app.get('/api/my-positions', authenticateToken, async (req, res) => {
  const { entryId } = req.query;
  if (!entryId) return res.status(400).json({ error: "entryId required" });

  try {
    const entry = await prisma.entry.findUnique({
      where: { id: entryId },
      include: { positions: true }
    });
    if (!entry) return res.status(404).json({ error: "Entry no encontrada" });

    let liveCapital = entry.virtualCapital;

    const positionsWithLivePnl = entry.positions.map(p => {
      const currentPrice = getCurrentPrice(p.symbol);
      let livePnl = p.currentPnl || 0;
      if (!p.closedAt && currentPrice && p.entryPrice) {
        const sign = p.direction === 'long' ? 1 : -1;
        livePnl = sign * ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
        const pnlAmount = entry.virtualCapital * (p.lotSize || 0) * (livePnl / 100);
        liveCapital += pnlAmount;
      }
      return {
        id: p.id,
        symbol: p.symbol,
        direction: p.direction,
        lotSize: p.lotSize || 0.01,
        entryPrice: p.entryPrice,
        livePnl: livePnl.toFixed(2)
      };
    });

    const totalRiskPercent = entry.positions.filter(p => !p.closedAt).reduce((sum, p) => sum + (p.lotSize || 0) * 10, 0);

    res.json({
      positions: positionsWithLivePnl,
      totalRiskPercent,
      virtualCapital: liveCapital.toString(),
      livePrices: livePrices
    });
  } catch (error) {
    res.status(500).json({ error: "Error my-positions", details: error.message });
  }
});

// MY-ADVICE
app.get('/api/my-advice', authenticateToken, async (req, res) => {
  try {
    const advice = await prisma.advice.findFirst({
      where: { userId: req.user.userId },
      orderBy: { date: 'desc' }
    });
    res.json({ advice: advice ? advice.text : null });
  } catch (error) {
    console.error('Error my-advice:', error);
    res.status(500).json({ error: 'Error obteniendo consejo IA' });
  }
});

// MY-PROFILE
app.get('/api/my-profile', authenticateToken, async (req, res) => {
  const entryId = req.query.entryId;
  if (!entryId) return res.status(400).json({ error: "entryId required en query params" });

  try {
    const entry = await prisma.entry.findUnique({
      where: { id: entryId },
      include: { user: true, positions: true }
    });

    if (!entry) return res.status(404).json({ error: "Entry no encontrada" });

    const isAdmin = req.user.role === 'admin';
    if (!isAdmin && entry.userId !== req.user.userId) {
      return res.status(403).json({ error: "Acceso denegado – entry no pertenece al usuario" });
    }

    let liveCapital = entry.virtualCapital;
    entry.positions.filter(p => !p.closedAt).forEach(p => {
      const currentPrice = getCurrentPrice(p.symbol);
      if (currentPrice && p.entryPrice) {
        const sign = p.direction === 'long' ? 1 : -1;
        const pnlPercent = sign * ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
        const pnlAmount = entry.virtualCapital * (p.lotSize || 0) * (pnlPercent / 100);
        liveCapital += pnlAmount;
      }
    });

    const initial = levelsConfig[entry.level].initialCapital;
    const dailyReturn = ((liveCapital - initial) / initial) * 100;

    const buys = entry.positions.filter(p => p.direction === 'long').length;
    const sells = entry.positions.filter(p => p.direction === 'short').length;
    const totalTrades = buys + sells;

    const assetCount = {};
    entry.positions.forEach(p => {
      assetCount[p.symbol] = (assetCount[p.symbol] || 0) + 1;
    });

    const topAssets = Object.entries(assetCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([symbol, count]) => ({ symbol, buys: entry.positions.filter(p => p.symbol === symbol && p.direction === 'long').length, sells: count - entry.positions.filter(p => p.symbol === symbol && p.direction === 'long').length }));

    const stats = {
      dailyReturn: dailyReturn.toFixed(2),
      buys,
      sells,
      moreBuys: buys > sells,
      wins: Math.round(Math.random() * 50),
      losses: Math.round(Math.random() * 20),
      totalTrades,
      topAssets
    };

    const history = [
      { date: new Date().toLocaleDateString('es-ES'), level: entry.level.toUpperCase(), return: dailyReturn.toFixed(2), position: 0, prize: 0 }
    ];

    res.json({
      nickname: entry.user.nickname || 'Anónimo',
      currentPosition: '#-',
      bestRanking: '#-',
      stats,
      history,
      liveCapital: Math.floor(liveCapital)
    });
  } catch (error) {
    console.error('Error my-profile:', error);
    res.status(500).json({ error: 'Error interno servidor' });
  }
});

// LAST-WINNERS
app.get('/api/last-winners', async (req, res) => {
  try {
    const winners = {};
    for (const level of Object.keys(levelsConfig)) {
      const entries = await prisma.entry.findMany({
        where: { level, status: "confirmed" },
        include: { user: true, positions: true }
      });

      const initial = levelsConfig[level].initialCapital;

      const ranking = entries.map(e => {
        let liveCapital = e.virtualCapital;
        e.positions.filter(p => !p.closedAt).forEach(p => {
          const currentPrice = getCurrentPrice(p.symbol);
          if (currentPrice && p.entryPrice) {
            const sign = p.direction === 'long' ? 1 : -1;
            const pnlPercent = sign * ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
            const pnlAmount = e.virtualCapital * (p.lotSize || 0) * (pnlPercent / 100);
            liveCapital += pnlAmount;
          }
        });
        const retorno = ((liveCapital - initial) / initial) * 100;
        return {
          position: 0,
          nickname: e.user.nickname || 'Anónimo',
          prize: 0,
          retorno
        };
      });

      ranking.sort((a, b) => b.retorno - a.retorno);

      const top3 = ranking.slice(0, 3).map((r, i) => ({
        position: i + 1,
        nickname: r.nickname,
        prize: 0
      }));

      winners[level] = top3;
    }

    res.json(winners);
  } catch (error) {
    console.error('Error last-winners:', error);
    res.status(500).json({ error: 'Error cargando ganadores' });
  }
});

// RANKING PÚBLICO
app.get('/api/ranking', async (req, res) => {
  const { level = 'basic' } = req.query;
  if (!levelsConfig[level]) return res.status(400).json({ error: "Nivel inválido" });

  try {
    const entries = await prisma.entry.findMany({
      where: { level, status: "confirmed" },
      include: { user: true, positions: true }
    });

    const initial = levelsConfig[level].initialCapital;

    const ranking = entries.map(e => {
      let liveCapital = e.virtualCapital;
      e.positions.filter(p => !p.closedAt).forEach(p => {
        const currentPrice = getCurrentPrice(p.symbol);
        if (currentPrice && p.entryPrice) {
          const sign = p.direction === 'long' ? 1 : -1;
          const pnlPercent = sign * ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
          const pnlAmount = e.virtualCapital * (p.lotSize || 0) * (pnlPercent / 100);
          liveCapital += pnlAmount;
        }
      });
      const retorno = ((liveCapital - initial) / initial) * 100;
      const displayName = e.user.nickname || 'Anónimo';

      return {
        displayName,
        retorno: retorno.toFixed(2) + "%",
        liveCapital: liveCapital.toString()
      };
    });

    ranking.sort((a, b) => parseFloat(b.retorno) - parseFloat(a.retorno));
    res.json(ranking.slice(0, 10));
  } catch (error) {
    res.status(500).json({ error: "Error ranking", details: error.message });
  }
});

// ADMIN DATA – SEGURA CON GUARDS + DEFAULTS (carga siempre, incluso vacío)
app.get('/api/admin/data', authenticateAdmin, async (req, res) => {
  try {
    console.log('🟢 /api/admin/data – ENTRÓ al handler');

    const entries = await prisma.entry.findMany({
      select: {
        id: true,
        level: true,
        status: true,
        virtualCapital: true,
        user: { select: { id: true, email: true, nickname: true, walletAddress: true } },
        positions: { select: { id: true, symbol: true, direction: true, lotSize: true, entryPrice: true, closedAt: true } }
      }
    });
    console.log(`Entries cargadas: ${entries.length}`);

    const overview = { 
      inscripcionesTotal: entries.length, 
      participantesActivos: entries.filter(e => e.status === 'confirmed').length, 
      revenuePlataforma: 0, 
      prizePoolTotal: 0 
    };

    const competencias = {};
    const levelsConfigAdmin = { 
      basic: { entryPrice: 12, comision: 2, initialCapital: 10000 }, 
      medium: { entryPrice: 54, comision: 4, initialCapital: 50000 }, 
      premium: { entryPrice: 107, comision: 7, initialCapital: 100000 } 
    };

    await Promise.all(Object.keys(levelsConfigAdmin).map(async (level) => {
      const config = levelsConfigAdmin[level];
      const entriesLevel = entries.filter(e => e.level === level);
      const ingresos = entriesLevel.length * config.entryPrice;
      const revenue = entriesLevel.length * config.comision;
      const prizePool = ingresos - revenue;

      overview.revenuePlataforma += revenue;
      overview.prizePoolTotal += prizePool;

      const ranking = entriesLevel.map(e => {
        let liveCapital = e.virtualCapital ?? config.initialCapital;
        (e.positions || []).filter(p => !p.closedAt).forEach(p => {
          if (!p.symbol || !p.entryPrice || p.entryPrice === 0) return;
          const currentPrice = getCurrentPrice(p.symbol) ?? p.entryPrice;
          const sign = p.direction === 'long' ? 1 : -1;
          const pnlPercent = sign * ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
          const pnlAmount = (e.virtualCapital ?? config.initialCapital) * (p.lotSize ?? 0) * (pnlPercent / 100);
          liveCapital += pnlAmount;
        });
        const initial = config.initialCapital;
        const retorno = initial === 0 ? 0 : ((liveCapital - initial) / initial) * 100;
        const displayName = e.user?.nickname || 'Anónimo';
        const wallet = e.user?.walletAddress || '';
        return { displayName, wallet, retorno: retorno.toFixed(2) + "%", liveCapital: liveCapital.toFixed(0) };
      }).sort((a, b) => parseFloat(b.retorno) - parseFloat(a.retorno));

      competencias[level] = {
        participantes: entriesLevel.length,
        prizePool,
        ranking: ranking.slice(0, 10),
        top3CSV: ranking.slice(0, 3).map((r, i) => `${r.wallet},${(prizePool * [0.5, 0.3, 0.2][i]).toFixed(2)}`).join('\n')
      };
    }));

    const usuarios = entries.map(e => {
      let liveCapital = e.virtualCapital ?? levelsConfigAdmin[e.level]?.initialCapital ?? 10000;
      (e.positions || []).filter(p => !p.closedAt).forEach(p => {
        if (!p.symbol || !p.entryPrice || p.entryPrice === 0) return;
        const currentPrice = getCurrentPrice(p.symbol) ?? p.entryPrice;
        const sign = p.direction === 'long' ? 1 : -1;
        const pnlPercent = sign * ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
        const pnlAmount = (e.virtualCapital ?? levelsConfigAdmin[e.level]?.initialCapital ?? 10000) * (p.lotSize ?? 0) * (pnlPercent / 100);
        liveCapital += pnlAmount;
      });
      return {
        id: e.id,
        displayName: e.user?.nickname || 'Anónimo',
        wallet: e.user?.walletAddress || '',
        level: e.level,
        status: e.status,
        virtualCapital: liveCapital.toFixed(0)
      };
    });

    console.log('✅ Datos admin enviados correctamente');
    res.json({ overview, competencias, usuarios });
  } catch (error) {
    console.error('💥 Error crítico en /api/admin/data:', error.message);
    console.error('💥 Stack:', error.stack);
    return res.status(200).json({
      overview: { inscripcionesTotal: 0, participantesActivos: 0, revenuePlataforma: 0, prizePoolTotal: 0 },
      competencias: {
        basic: { participantes: 0, prizePool: 0, ranking: [], top3CSV: '' },
        medium: { participantes: 0, prizePool: 0, ranking: [], top3CSV: '' },
        premium: { participantes: 0, prizePool: 0, ranking: [], top3CSV: '' }
      },
      usuarios: []
    });
  }
});

// Admin viejo
app.get('/admin', async (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: "Password incorrecto" });

  try {
    const entries = await prisma.entry.findMany({
      include: { user: true, positions: true }
    });

    const resumenGlobal = { inscripcionesTotal: entries.length, ingresosBrutos: 0, revenuePlataforma: 0, prizePool: 0 };
    const competenciasPorLevel = {};

    for (const level of Object.keys(levelsConfig)) {
      const config = levelsConfig[level];
      const entriesLevel = entries.filter(e => e.level === level);
      const confirmedLevel = entriesLevel.filter(e => e.status === "confirmed");

      const ingresosLevel = entriesLevel.length * config.entryPrice;
      const revenueLevel = entriesLevel.length * config.comision;
      const prizePoolLevel = ingresosLevel - revenueLevel;

      resumenGlobal.ingresosBrutos += ingresosLevel;
      resumenGlobal.revenuePlataforma += revenueLevel;
      resumenGlobal.prizePool += prizePoolLevel;

      const competenciaActiva = confirmedLevel.length > 5;

      const rankingEntries = [];

      for (const e of confirmedLevel) {
        let liveCapital = e.virtualCapital;

        for (const p of e.positions.filter(pos => !pos.closedAt)) {
          const currentPrice = getCurrentPrice(p.symbol);
          if (currentPrice && p.entryPrice) {
            const sign = p.direction === 'long' ? 1 : -1;
            const pnlPercent = sign * ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
            const pnlAmount = e.virtualCapital * (p.lotSize || 0) * (pnlPercent / 100);
            liveCapital += pnlAmount;
          }
        }

        const retorno = ((liveCapital - config.initialCapital) / config.initialCapital) * 100;
        const displayName = e.user.nickname || 'Anónimo';

        rankingEntries.push({
          displayName,
          wallet: e.user.walletAddress,
          retornoPorcentaje: retorno.toFixed(2) + "%",
          liveCapital: liveCapital.toFixed(),
          openPositions: e.positions.filter(pos => !pos.closedAt).length
        });
      }

      rankingEntries.sort((a, b) => parseFloat(b.retornoPorcentaje) - parseFloat(a.retornoPorcentaje));

      const rankingLevel = rankingEntries.map((r, i) => ({
        posicion: i + 1,
        displayName: r.displayName,
        wallet: r.wallet,
        retornoPorcentaje: r.retornoPorcentaje,
        liveCapital: r.liveCapital,
        openPositions: r.openPositions,
        montoPremio: i < 3 ? (prizePoolLevel * [0.5, 0.3, 0.2][i]).toFixed(2) + " USDT" : "0 USDT"
      }));

      competenciasPorLevel[level] = {
        inscripcionesTotal: entriesLevel.length,
        ingresosBrutos: ingresosLevel + " USDT",
        revenuePlataforma: revenueLevel + " USDT (tuyo)",
        prizePool: prizePoolLevel + " USDT",
        participantesConfirmados: confirmedLevel.length,
        competenciaActiva,
        ranking: rankingLevel,
        nota: "Ranking LIVE MULTIPLE TRADES FINNHUB LOTSIZE PRO ACTIVO 🔥"
      };
    }

    const csvData = [];
    Object.values(competenciasPorLevel).forEach(c => {
      if (c.competenciaActiva) {
        c.ranking.forEach(r => {
          if (parseFloat(r.montoPremio) > 0) csvData.push(`${r.wallet},${r.montoPremio.replace(' USDT', '')}`);
        });
      }
    });
    const csvString = "Wallet,Amount\n" + (csvData.join("\n") || "No pagos aprobados");

    res.json({
      message: "Admin Holypot – MULTIPLE TRADES LIVE FINNHUB LOTSIZE PRO ACTIVO 🔥",
      resumenGlobal: {
        inscripcionesTotal: resumenGlobal.inscripcionesTotal,
        ingresosBrutos: resumenGlobal.ingresosBrutos + " USDT",
        revenuePlataforma: resumenGlobal.revenuePlataforma + " USDT (tuyo)",
        prizePool: resumenGlobal.prizePool + " USDT"
      },
      competenciasPorLevel,
      exportCSV: csvString
    });
  } catch (error) {
    res.status(500).json({ error: "Error admin", details: error.message });
  }
});

// Manual create + confirm
app.post('/api/manual-create-confirm', async (req, res) => {
  const { email, walletAddress, level } = req.body;
  if (!email || !walletAddress || !level) return res.status(400).json({ error: "Email, wallet and level required" });

  const levels = {
    basic: { capital: 10000 },
    medium: { capital: 50000 },
    premium: { capital: 100000 }
  };
  if (!levels[level]) return res.status(400).json({ error: "Nivel inválido" });

  try {
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({ data: { email, walletAddress } });
    } else {
      await prisma.user.update({ where: { id: user.id }, data: { walletAddress } });
    }

    const entry = await prisma.entry.create({
      data: {
        userId: user.id,
        level,
        status: "pending",
        virtualCapital: levels[level].capital
      }
    });

    await prisma.entry.update({
      where: { id: entry.id },
      data: { status: "confirmed" }
    });

    emitLiveData();

    res.json({ 
      message: "¡User + entry creados y confirmados manualmente! Capital virtual activado – ve al dashboard", 
      entryId: entry.id 
    });
  } catch (error) {
    res.status(500).json({ error: "Error manual create-confirm", details: error.message });
  }
});

// NUEVO ENDPOINT TOTAL PREMIOS PAGADOS HISTÓRICOS (público) – CORREGIDO
app.get('/api/total-prizes-paid', async (req, res) => {
  try {
    const result = await prisma.payout.aggregate({
      _sum: { amount: true }
    });
    res.json({ totalPaid: result._sum.amount || 0 });
  } catch (error) {
    console.error('Error total prizes:', error);
    res.status(500).json({ error: 'Error calculando total premios' });
  }
});

// MY-PAYOUTS (historial premios usuario – evita 404 y carga modal ganador)
app.get('/api/my-payouts', authenticateToken, async (req, res) => {
  try {
    const payouts = await prisma.payout.findMany({
      where: { userId: req.user.userId },
      orderBy: { date: 'desc' }
    });
    res.json(payouts);
  } catch (err) {
    console.error('Error my-payouts:', err);
    res.status(500).json({ error: 'Error cargando historial de pagos' });
  }
});

// NUEVOS ENDPOINTS VELAS GLOBALES (LIMPIOS, SIN DUPLICADOS)
app.get('/api/candles/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const from = parseInt(req.query.from) || 0;

  console.log(`GET /api/candles/${symbol}?from=${from} llamado`);

  try {
    const candles = await prisma.dailyCandle.findMany({
      where: {
        symbol: symbol.toUpperCase(),
        time: { gte: from }
      },
      orderBy: { time: 'asc' }
    });

    console.log(`Velas encontradas para ${symbol}: ${candles.length}`);
    res.json({ candles });
  } catch (err) {
    console.error('Error fetching candles', err);
    res.json({ candles: [] });
  }
});

app.get('/', (req, res) => res.json({ message: 'Holypot Trading corriendo! 🚀' }));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));

// CRON CIERRE DIARIO 21:00 UTC + ROLLOVER + CONSEJOS IA + LIMPIEZA VELAS
cron.schedule('0 21 * * *', async () => {
  console.log('🔥 CRON 21:00 UTC – Cierre competencia diaria + rollover + consejos IA + limpieza velas');

  try {
    const entriesToday = await prisma.entry.findMany({
      where: { status: 'confirmed' },
      include: { user: true, positions: true }
    });

    const byLevel = {};
    Object.keys(levelsConfig).forEach(level => {
      byLevel[level] = entriesToday.filter(e => e.level === level);
    });

    for (const [level, entries] of Object.entries(byLevel)) {
      const participants = entries.length;
      const config = levelsConfig[level];
      const prizePool = participants * config.entryPrice - participants * config.comision;

      console.log(`Nivel ${level.toUpperCase()}: ${participants} participantes – Prize pool: ${prizePool} USDT`);

      // CIERRE FORZADO POSICIONES
      for (const entry of entries) {
        const openPositions = entry.positions.filter(p => !p.closedAt);
        for (const p of openPositions) {
          const currentPrice = getCurrentPrice(p.symbol) || p.entryPrice;
          const sign = p.direction === 'long' ? 1 : -1;
          const pnlPercent = sign * ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
          const pnlAmount = entry.virtualCapital * (p.lotSize || 0) * (pnlPercent / 100);

          await prisma.entry.update({
            where: { id: entry.id },
            data: { virtualCapital: entry.virtualCapital + pnlAmount }
          });

          await prisma.position.update({
            where: { id: p.id },
            data: { closedAt: new Date(), currentPnl: pnlPercent }
          });
        }
      }

      if (participants < 5) {
        console.log(`❌ ${level.toUpperCase()}: Menos de 5 participantes → ROLLOVER GRATIS`);

        for (const entry of entries) {
          await prisma.entry.update({
            where: { id: entry.id },
            data: { virtualCapital: config.initialCapital }
          });
        }
        continue;
      }

      // CÁLCULO GANADORES
      const finalRanking = entries.map(e => {
        const retorno = ((e.virtualCapital - config.initialCapital) / config.initialCapital) * 100;
        return { entry: e, retorno };
      }).sort((a, b) => b.retorno - a.retorno);

      const prizes = [0.5, 0.3, 0.2];

      // GUARDAR PREMIO HISTÓRICO + LOG
      for (let i = 0; i < Math.min(3, finalRanking.length); i++) {
        const winner = finalRanking[i];
        const prizeAmount = prizePool * prizes[i];

        await prisma.payout.create({
          data: {
            userId: winner.entry.userId,
            level: level,
            position: i + 1,
            amount: prizeAmount
          }
        });

        console.log(`🏆 ${i+1}º ${level.toUpperCase()}: ${winner.entry.user.nickname || winner.entry.user.email} – Premio ${prizeAmount.toFixed(2)} USDT guardado`);
      }

      console.log(`✅ Competencia ${level.toUpperCase()} cerrada`);
    }

    // LIMPIEZA AUTOMÁTICA VELAS DE AYER
    const yesterday = new Date(Date.now() - 86400000);
    yesterday.setUTCHours(0, 0, 0, 0);

    await prisma.dailyCandle.deleteMany({
      where: {
        date: { lt: yesterday }
      }
    });
    console.log('🧹 Velas de ayer limpiadas');

    // GENERACIÓN CONSEJOS IA
    for (const entry of entriesToday) {
      let liveCapital = entry.virtualCapital;
      let openLotTotal = 0;
      const symbolCount = {};

      entry.positions.forEach(p => {
        symbolCount[p.symbol] = (symbolCount[p.symbol] || 0) + 1;

        if (!p.closedAt) {
          openLotTotal += p.lotSize || 0;
          const currentPrice = getCurrentPrice(p.symbol);
          if (currentPrice) {
            const sign = p.direction === 'long' ? 1 : -1;
            const pnlPercent = sign * ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
            const pnlAmount = entry.virtualCapital * (p.lotSize || 0) * (pnlPercent / 100);
            liveCapital += pnlAmount;
          }
        }
      });

      const initial = levelsConfig[entry.level].initialCapital;
      const dailyReturn = ((liveCapital - initial) / initial) * 100;

      const buys = entry.positions.filter(p => p.direction === 'long').length;
      const sells = entry.positions.filter(p => p.direction === 'short').length;
      const riskUsed = openLotTotal * 10;
      const topAsset = Object.keys(symbolCount).sort((a, b) => symbolCount[b] - symbolCount[a])[0] || 'Ninguno';

      const prompt = `
Analiza el desempeño del trader ${entry.user.nickname || 'Anónimo'} hoy:
- Retorno del día: ${dailyReturn.toFixed(2)}%
- Operaciones LONG: ${buys}
- Operaciones SHORT: ${sells}
- Riesgo actualmente usado: ${riskUsed.toFixed(1)}%
- Activo más operado: ${topAsset}

Genera un consejo breve y motivador en español:
1. Resumen positivo del día.
2. 3 sugerencias concretas para mejorar mañana.
Máximo 250 caracteres, tono entusiasta y profesional.
`;

      try {
        const response = await axios.post('https://api.x.ai/v1/chat/completions', {
          model: "grok-beta",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.7,
          max_tokens: 300
        }, {
          headers: {
            'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        const advice = response.data.choices[0].message.content.trim();

        await prisma.advice.create({
          data: {
            userId: entry.user.id,
            date: new Date(),
            text: advice
          }
        });
      } catch (grokError) {
        console.error('Error Grok API:', grokError.response?.data || grokError.message);
      }
    }

    emitLiveData();
  } catch (error) {
    console.error('Error en cron diario:', error);
  }
});
