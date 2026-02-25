require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const cron = require('node-cron');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const z = require('zod');
const cookieParser = require('cookie-parser');
const { Resend } = require('resend');

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET no configurado en .env');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

// ========== EMAIL VERIFICATION SETUP ==========
const resend = new Resend(process.env.RESEND_API_KEY);

// Función para generar token
function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Función para enviar email
async function sendVerificationEmail(email, token) {
  const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
  
  try {
    const { data, error } = await resend.emails.send({
      from: 'Holypot <onboarding@resend.dev>',
      to: email,
      subject: '🎯 Confirma tu email - Holypot',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #667eea; text-align: center;">🎯 Holypot</h1>
          <h2>¡Bienvenido!</h2>
          <p>Confirma tu email para comenzar a competir:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${verificationUrl}" style="background: #667eea; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
              ✅ Confirmar Email
            </a>
          </div>
          <p style="color: #666; font-size: 14px;">
            O copia este enlace:<br>
            <code>${verificationUrl}</code>
          </p>
          <p style="color: #999; font-size: 12px; margin-top: 30px;">
            Este enlace expira en 24 horas.
          </p>
        </div>
      `
    });

    if (error) {
      console.error('❌ Error enviando email:', error);
      return { success: false, error };
    }

    console.log('✅ Email enviado:', data);
    return { success: true, data };
  } catch (error) {
    console.error('❌ Error:', error);
    return { success: false, error: error.message };
  }
}
// =============================================

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true
  }
});

// ========== SOCKET.IO JWT AUTH MIDDLEWARE ==========
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) {
    // Conexiones anónimas permitidas (landing, datos públicos)
    socket.user = null;
    return next();
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      console.warn('Socket auth fallido:', err.message);
      socket.user = null;
      return next(); // Permitir pero sin autenticar
    }
    socket.user = decoded;
    next();
  });
});

io.on('connection', (socket) => {
  const userId = socket.user?.userId || 'anon';
  console.log(`🔌 Socket conectado: ${socket.id} (user: ${userId})`);

  socket.on('disconnect', () => {
    console.log(`🔌 Socket desconectado: ${socket.id}`);
  });
});
// ==================================================

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
const HCAPTCHA_SECRET = process.env.HCAPTCHA_SECRET;

async function verifyHCaptcha(token) {
  if (!HCAPTCHA_SECRET) return true; // skip if not configured (dev)
  try {
    const res = await axios.post('https://api.hcaptcha.com/siteverify', new URLSearchParams({
      secret: HCAPTCHA_SECRET,
      response: token
    }));
    return res.data?.success === true;
  } catch {
    return false;
  }
}

// ADMIN CREDENTIALS (desde .env)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('FATAL: ADMIN_EMAIL y ADMIN_PASSWORD deben estar en .env');
  process.exit(1);
}

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

// Configuración de redes de pago
const NETWORK_CONFIG = {
  polygon:  { nowpaymentsCurrency: 'usdtpoly',  fee: 0.50,  label: 'Polygon'   },
  trc20:    { nowpaymentsCurrency: 'usdttrc20', fee: 4.50,  label: 'TRC-20'    },
  ethereum: { nowpaymentsCurrency: 'usdt',       fee: 17.50, label: 'Ethereum'  }
};

// Verificar si una moneda está disponible para recibir pagos en NowPayments
async function checkNowPaymentsCurrencyAvailable(currency) {
  try {
    const response = await axios.get(`${NOWPAYMENTS_API}/currencies`, {
      headers: { 'x-api-key': API_KEY },
      params: { isFiat: false }
    });
    const available = response.data.currencies || [];
    return available.some(c => c.toLowerCase() === currency.toLowerCase());
  } catch (error) {
    console.error('❌ Error verificando moneda NowPayments:', error.response?.data || error.message);
    return true; // Permitir en caso de error para no bloquear pagos
  }
}

// 🆕 FUNCIÓN: Obtener balance real de NowPayments (por moneda)
async function getNowPaymentsBalance(currency = 'usdttrc20') {
  try {
    const response = await axios.get(`${NOWPAYMENTS_API}/balance`, {
      headers: { 'x-api-key': API_KEY }
    });
    const currencies = response.data.currencies || [];
    const found = currencies.find(c => c.currency === currency);
    return found ? parseFloat(found.available_balance || 0) : 0;
  } catch (error) {
    console.error('❌ Error obteniendo balance NowPayments:', error.response?.data || error.message);
    return 0;
  }
}

// 🆕 FUNCIÓN: Enviar pago individual vía NowPayments (legacy / fallback)
async function sendNowPaymentsPayout(walletAddress, amount, level, position, network = 'trc20') {
  try {
    const netCfg = NETWORK_CONFIG[network] || NETWORK_CONFIG.trc20;
    const response = await axios.post(`${NOWPAYMENTS_API}/payout`, {
      withdrawals: [{
        address: walletAddress,
        currency: netCfg.nowpaymentsCurrency,
        amount: amount.toFixed(2),
        ipn_callback_url: `${process.env.BACKEND_URL || 'https://holypot-backend.onrender.com'}/api/webhook-payout`
      }]
    }, {
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' }
    });

    console.log(`✅ Pago enviado a ${walletAddress}: ${amount} USDT (${network}) - Response:`, response.data);
    return {
      success: true,
      paymentId: response.data.id || response.data.withdrawals?.[0]?.id,
      data: response.data
    };
  } catch (error) {
    console.error('❌ Error enviando payout NowPayments:', error.response?.data || error.message);
    return { success: false, error: error.response?.data || error.message };
  }
}

// 🆕 FUNCIÓN: Batch settlement – agrupa payouts pendientes por red y envía en un solo request
async function processBatchPayouts(targetNetwork = null) {
  console.log(`🏦 Iniciando batch payout${targetNetwork ? ` para red: ${targetNetwork}` : ' (todas las redes)'}`);

  const whereClause = { status: 'pending', walletAddress: { not: null } };
  if (targetNetwork) whereClause.network = targetNetwork;

  const pendingPayouts = await prisma.payout.findMany({
    where: whereClause,
    include: { user: true }
  });

  if (pendingPayouts.length === 0) {
    console.log('✅ No hay payouts pendientes para procesar');
    return { processed: 0 };
  }

  // Agrupar por red
  const byNetwork = {};
  for (const p of pendingPayouts) {
    const net = p.network || 'trc20';
    if (!byNetwork[net]) byNetwork[net] = [];
    byNetwork[net].push(p);
  }

  let totalProcessed = 0;

  for (const [network, payouts] of Object.entries(byNetwork)) {
    const netCfg = NETWORK_CONFIG[network];
    if (!netCfg) { console.warn(`Red desconocida: ${network}`); continue; }

    const totalAmount = payouts.reduce((sum, p) => sum + p.amount, 0);
    console.log(`📦 Batch ${network}: ${payouts.length} payouts → ${totalAmount.toFixed(2)} USDT`);

    // Verificar saldo
    const balance = await getNowPaymentsBalance(netCfg.nowpaymentsCurrency);
    if (balance < totalAmount) {
      console.error(`❌ Saldo insuficiente en ${network}: ${balance} < ${totalAmount}`);
      continue;
    }

    // Crear registro batch
    const batch = await prisma.payoutBatch.create({
      data: { network, status: 'pending', totalAmount, payoutCount: payouts.length }
    });

    try {
      const withdrawals = payouts.map(p => ({
        address: p.walletAddress,
        currency: netCfg.nowpaymentsCurrency,
        amount: p.amount.toFixed(2),
        ipn_callback_url: `${process.env.BACKEND_URL || 'https://holypot-backend.onrender.com'}/api/webhook-payout`
      }));

      const response = await axios.post(`${NOWPAYMENTS_API}/payout`, { withdrawals }, {
        headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' }
      });

      const nowpaymentsId = (response.data.id || response.data.withdrawals?.[0]?.batch_id || '').toString();

      await prisma.payoutBatch.update({
        where: { id: batch.id },
        data: { status: 'sent', nowpaymentsId, sentAt: new Date() }
      });

      for (const payout of payouts) {
        await prisma.payout.update({
          where: { id: payout.id },
          data: { status: 'sent', batchId: batch.id, paymentId: nowpaymentsId }
        });
      }

      console.log(`✅ Batch ${network} enviado: ${payouts.length} payouts, ${totalAmount.toFixed(2)} USDT (batchId: ${batch.id})`);
      totalProcessed += payouts.length;
    } catch (error) {
      console.error(`❌ Batch ${network} falló:`, error.response?.data || error.message);
      await prisma.payoutBatch.update({ where: { id: batch.id }, data: { status: 'failed' } });
    }
  }

  return { processed: totalProcessed };
}

// Finnhub WebSocket real-time prices
// ========== FINNHUB WEBSOCKET CON RECONEXIÓN MEJORADA ==========
const livePrices = {};
let socketFinnhub = null;
let reconnectTimeout = null;

function getCurrentPrice(symbol) {
  return livePrices[symbol] || null;
}

// Función para conectar/reconectar Finnhub WebSocket
function connectFinnhub() {
  // Limpiar timeout anterior si existe
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  console.log('🔌 Conectando a Finnhub WebSocket...');
  
  socketFinnhub = new WebSocket(`wss://ws.finnhub.io?token=${process.env.FINNHUB_API_KEY}`);

  socketFinnhub.on('open', () => {
    console.log('✅ Finnhub WebSocket CONECTADO – suscribiendo activos 🚀');

    const symbols = {
      EURUSD: 'EUR_USD',
      GBPUSD: 'GBP_USD',
      USDJPY: 'USD_JPY',
      XAUUSD: 'XAU_USD',
      SPX500: 'SPX500_USD',   // OANDA CFD S&P 500 → OANDA:SPX500_USD
      NAS100: 'NAS100_USD'    // OANDA CFD NASDAQ 100 → OANDA:NAS100_USD
    };

    Object.keys(symbols).forEach((key, index) => {
      setTimeout(() => {
        const finnhubSym = symbols[key];
        socketFinnhub.send(JSON.stringify({ type: 'subscribe', symbol: `OANDA:${finnhubSym}` }));
        console.log(`📊 Suscripto a OANDA:${finnhubSym}`);
      }, index * 200); // 200ms entre cada suscripción (evitar rate limit)
    });
  });

  socketFinnhub.on('message', async (data) => {
    const msg = JSON.parse(data);
    
    // Log de datos recibidos (solo primeros 100 caracteres)
    console.log('📥 Finnhub mensaje:', data.toString().substring(0, 100));
    
    if (msg.type === 'trade' && msg.data) {
      for (const t of msg.data) {
        let fullSym = t.s;
        let symbol = fullSym.replace('OANDA:', '');
        // Los índices usan sufijo _USD pero NO se concatenan (SPX500_USD → SPX500, NAS100_USD → NAS100)
        if (symbol === 'SPX500_USD') symbol = 'SPX500';
        else if (symbol === 'NAS100_USD') symbol = 'NAS100';
        else symbol = symbol.replace('_USD', 'USD').replace('_JPY', 'JPY');
        const price = t.p;
        
        console.log(`💰 Precio actualizado: ${symbol} = ${price}`);
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

  socketFinnhub.on('error', (err) => {
    console.error('❌ Finnhub WS ERROR:', err.message);
  });

  socketFinnhub.on('close', () => {
    console.warn('⚠️ Finnhub WS CERRADO – reconectando en 5s...');
    reconnectTimeout = setTimeout(() => {
      connectFinnhub(); // ✅ Reconectar llamando a la misma función
    }, 5000);
  });
}

// ✅ Conectar al inicio
connectFinnhub();
// ================================================================

// ========== RATE LIMITING – TODOS LOS ENDPOINTS CRÍTICOS ==========
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados intentos de login – espera 15 min' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/login', loginLimiter);
app.use('/api/admin-login', loginLimiter);

const tradeLimiter = rateLimit({
  windowMs: 1000,
  max: 3,
  message: { error: 'Demasiados trades rápidos – espera' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/open-trade', tradeLimiter);
app.use('/api/close-trade', tradeLimiter);
app.use('/api/edit-position', tradeLimiter);

const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { error: 'Demasiadas solicitudes de pago – espera 1 min' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/create-payment', paymentLimiter);

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados registros – espera 1 hora' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/register', registerLimiter);
app.use('/api/resend-verification', registerLimiter);

const apiGeneralLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Demasiadas solicitudes – espera un momento' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', apiGeneralLimiter);
// ==================================================================

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
    const isAdmin = req.user.role === 'admin';
    if (isAdmin) {
      return res.json({ user: { id: null, email: req.user.email, nickname: 'Admin', walletAddress: null, role: 'admin' } });
    }
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, email: true, nickname: true, walletAddress: true }
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user: { ...user, role: 'user' } });
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
          const tp = p.takeProfit ? parseFloat(p.takeProfit) : null;
          const sl = p.stopLoss ? parseFloat(p.stopLoss) : null;
          if (p.direction === 'long') {
            if (tp && currentPrice >= tp) { shouldClose = true; reason = 'TP_hit'; }
            if (sl && currentPrice <= sl) { shouldClose = true; reason = 'SL_hit'; }
          } else {
            if (tp && currentPrice <= tp) { shouldClose = true; reason = 'TP_hit'; }
            if (sl && currentPrice >= sl) { shouldClose = true; reason = 'SL_hit'; }
          }
        }

        if (shouldClose) {
          const sign = p.direction === 'long' ? 1 : -1;
          const pnlPercent = sign * ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
          const pnlAmount = entry.virtualCapital * (p.lotSize || 0) * (pnlPercent / 100);
          const newCapital = entry.virtualCapital + pnlAmount;

          await prisma.entry.update({
            where: { id: entry.id },
            data: { virtualCapital: newCapital }
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

          // AUTO-DESCALIFICACIÓN: drawdown > 10% del capital inicial
          if (entry.status === 'confirmed') {
            const levelCfg = levelsConfig[entry.level];
            if (levelCfg && newCapital < levelCfg.initialCapital * 0.90) {
              // Cerrar todas las posiciones abiertas restantes
              const remaining = openPositions.filter(op => op.id !== p.id && !op.closedAt);
              for (const op of remaining) {
                const opPrice = getCurrentPrice(op.symbol);
                const opPnl = opPrice && op.entryPrice
                  ? (op.direction === 'long' ? 1 : -1) * ((opPrice - op.entryPrice) / op.entryPrice) * 100
                  : 0;
                await prisma.position.update({
                  where: { id: op.id },
                  data: { closedAt: new Date(), currentPnl: opPnl, closeReason: 'drawdown_disqualified' }
                });
              }
              await prisma.entry.update({
                where: { id: entry.id },
                data: { status: 'disqualified' }
              });
              const drawdownPct = (((levelCfg.initialCapital - newCapital) / levelCfg.initialCapital) * 100).toFixed(2);
              console.log(`⛔ Entry ${entry.id} descalificada — drawdown ${drawdownPct}%`);
              io.emit('entryDisqualified', {
                entryId: entry.id,
                reason: 'drawdown_exceeded',
                drawdownPercent: drawdownPct
              });
            }
          }
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

// ========== ENDPOINTS DE EMAIL VERIFICATION ==========

// REGISTRO CON VERIFICACIÓN
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, nickname } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña requeridos' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'Email ya registrado' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationToken = generateVerificationToken();
    const tokenExpiry = new Date();
    tokenExpiry.setHours(tokenExpiry.getHours() + 24);

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        nickname,
        emailVerified: false,
        verificationToken,
        tokenExpiry
      }
    });

    const emailResult = await sendVerificationEmail(email, verificationToken);

    res.status(201).json({
      message: 'Registro exitoso. Revisa tu email.',
      userId: user.id,
      emailSent: emailResult.success
    });
  } catch (error) {
    console.error('Error en registro:', error);
    res.status(500).json({ error: 'Error en el registro' });
  }
});

// VERIFICAR EMAIL
app.get('/api/verify-email', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ error: 'Token no proporcionado' });
    }

    const user = await prisma.user.findFirst({
      where: {
        verificationToken: token,
        emailVerified: false,
        tokenExpiry: { gt: new Date() }
      }
    });

    if (!user) {
      return res.status(400).json({ 
        error: 'Token inválido o expirado',
        code: 'INVALID_TOKEN'
      });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        verificationToken: null,
        tokenExpiry: null
      }
    });

    console.log(`✅ Email verificado: ${user.email}`);

    res.json({
      success: true,
      message: '¡Email verificado!'
    });
  } catch (error) {
    console.error('Error verificando email:', error);
    res.status(500).json({ error: 'Error al verificar' });
  }
});

// REENVIAR VERIFICACIÓN
app.post('/api/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email requerido' });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (user.emailVerified) {
      return res.status(400).json({ error: 'Email ya verificado' });
    }

    const verificationToken = generateVerificationToken();
    const tokenExpiry = new Date();
    tokenExpiry.setHours(tokenExpiry.getHours() + 24);

    await prisma.user.update({
      where: { id: user.id },
      data: { verificationToken, tokenExpiry }
    });

    const emailResult = await sendVerificationEmail(email, verificationToken);

    if (!emailResult.success) {
      return res.status(500).json({ error: 'Error enviando email' });
    }

    res.json({
      success: true,
      message: 'Email reenviado'
    });
  } catch (error) {
    console.error('Error reenviando:', error);
    res.status(500).json({ error: 'Error' });
  }
});

// =====================================================

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

    // ✅ AQUÍ: Buscar la entry más reciente confirmada del usuario (DESPUÉS de obtener user)
    const entry = await prisma.entry.findFirst({
      where: { 
        userId: user.id,
        status: "confirmed"
      },
      orderBy: { id: 'desc' }
    });

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('holypotToken', token, getCookieOptions());

    // ✅ AQUÍ: Devolver también el entryId
    res.json({ 
      success: true, 
      token,
      entryId: entry ? entry.id : null
    });
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

// ADMIN: Generar token de usuario para impersonación (Ver como usuario)
app.post('/api/admin/generate-user-token', authenticateAdmin, async (req, res) => {
  const { entryId } = req.body;
  if (!entryId) return res.status(400).json({ error: "entryId requerido" });

  try {
    const entry = await prisma.entry.findUnique({
      where: { id: entryId },
      include: { user: { select: { id: true, email: true } } }
    });

    if (!entry) return res.status(404).json({ error: "Entry no encontrada" });
    if (!entry.user) return res.status(404).json({ error: "Usuario no encontrado para esta entry" });

    const userToken = jwt.sign(
      { userId: entry.user.id, email: entry.user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ success: true, token: userToken, entryId: entry.id });
  } catch (error) {
    res.status(500).json({ error: "Error generando token de usuario", details: error.message });
  }
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
      // Verificar que el monto pagado cubra el precio esperado (tolerancia 0.5% por fluctuacion crypto)
      const paid = parseFloat(data.actually_paid || 0);
      const expected = parseFloat(data.price_amount || 0);
      if (expected > 0 && paid < expected * 0.995) {
        console.warn(`Pago parcial detectado: pagado=${paid}, esperado=${expected}, payment_id=${data.payment_id}`);
        return res.status(200).send('OK'); // Aceptar webhook pero NO confirmar entry
      }

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

// Webhook NowPayments PAYOUT (confirmación de pagos enviados)
app.post('/api/webhook-payout', express.raw({type: 'application/json'}), async (req, res) => {
  const body = req.body.toString();
  const signature = req.headers['x-nowpayments-sig'];
  const secret = process.env.NOWPAYMENTS_SECRET;

  if (secret) {
    const hash = crypto.createHmac('sha512', secret)
      .update(body)
      .digest('hex');
    if (hash !== signature) {
      console.warn('Webhook payout HMAC invalido');
      return res.status(401).send('Invalid signature');
    }
  }

  try {
    const data = JSON.parse(body);
    console.log('Webhook payout recibido:', data);

    if (data.status === 'FINISHED' || data.status === 'COMPLETED') {
      const nowpayId = (data.id || data.withdrawal_id || data.batch_withdrawal_id || '').toString();

      // Confirmar payouts individuales por paymentId
      await prisma.payout.updateMany({
        where: { paymentId: nowpayId },
        data: { status: 'confirmed' }
      });

      // Confirmar batch si existe
      await prisma.payoutBatch.updateMany({
        where: { nowpaymentsId: nowpayId },
        data: { status: 'confirmed', confirmedAt: new Date() }
      });

      console.log(`✅ Payout/Batch confirmado en blockchain: ${nowpayId}`);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error webhook payout:', error);
    res.status(400).send('Invalid');
  }
});

// ADMIN PAYOUTS - Lista todos los pagos del sistema
app.get('/api/admin/payouts', authenticateAdmin, async (req, res) => {
  try {
    const payouts = await prisma.payout.findMany({
      include: {
        user: {
          select: { email: true, nickname: true }
        }
      },
      orderBy: { date: 'desc' },
      take: 100 // Últimos 100 pagos
    });
    
    res.json(payouts);
  } catch (err) {
    console.error('Error admin payouts:', err);
    res.status(500).json({ error: 'Error cargando payouts' });
  }
});

// ADMIN – Payouts pendientes agrupados por red
app.get('/api/admin/pending-payouts', authenticateAdmin, async (req, res) => {
  try {
    const pending = await prisma.payout.findMany({
      where: { status: 'pending' },
      include: { user: { select: { email: true, nickname: true } } },
      orderBy: { date: 'desc' }
    });

    // Agrupar por red
    const byNetwork = {};
    for (const p of pending) {
      const net = p.network || 'trc20';
      if (!byNetwork[net]) byNetwork[net] = { network: net, label: NETWORK_CONFIG[net]?.label || net, payouts: [], totalAmount: 0 };
      byNetwork[net].payouts.push(p);
      byNetwork[net].totalAmount += p.amount;
    }

    res.json(Object.values(byNetwork));
  } catch (err) {
    res.status(500).json({ error: 'Error cargando payouts pendientes' });
  }
});

// ADMIN – Historial de batches
app.get('/api/admin/batch-payouts', authenticateAdmin, async (req, res) => {
  try {
    const batches = await prisma.payoutBatch.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { payouts: { include: { user: { select: { nickname: true } } } } }
    });
    res.json(batches);
  } catch (err) {
    res.status(500).json({ error: 'Error cargando batches' });
  }
});

// ADMIN – Trigger batch payout manual
app.post('/api/admin/trigger-batch-payout', authenticateAdmin, async (req, res) => {
  const { network } = req.body; // opcional: filtrar por red
  try {
    const result = await processBatchPayouts(network || null);
    res.json({ message: `Batch payout ejecutado: ${result.processed} payouts procesados`, ...result });
  } catch (err) {
    console.error('Error trigger batch payout:', err);
    res.status(500).json({ error: 'Error ejecutando batch payout', details: err.message });
  }
});

// 🆕 Competencias activas CON BALANCE REAL de NowPayments
app.get('/api/competitions/active', async (req, res) => {
  try {
    const entries = await prisma.entry.findMany({
      where: { status: "confirmed" },
      include: { user: true }
    });

    // Obtener balance REAL de NowPayments
    const realBalance = await getNowPaymentsBalance();
    console.log(`💰 Balance real NowPayments: ${realBalance} USDT`);

    // Calcular pool teorico total para distribuir balance real proporcionalmente
    let totalTeoricoPool = 0;
    const levelData = Object.entries(levelsConfig).map(([level, config]) => {
      const confirmed = entries.filter(e => e.level === level);
      const participants = confirmed.length;
      const ingresos = participants * config.entryPrice;
      const revenue = participants * config.comision;
      const pool = ingresos - revenue;
      totalTeoricoPool += pool;
      return { level, config, participants, pool };
    });

    const now = new Date();
    const utcNow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds());
    const endOfDayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59);
    const msLeft = endOfDayUTC - utcNow;
    const hoursLeft = Math.floor(msLeft / (1000 * 60 * 60));
    const minutesLeft = Math.floor((msLeft % (1000 * 60 * 60)) / (1000 * 60));

    const competitions = levelData.map(({ level, config, participants, pool }) => {
      // Pool real proporcional: si basic tiene 60% del pool teorico, recibe 60% del saldo real
      const realPoolForLevel = totalTeoricoPool > 0
        ? (pool / totalTeoricoPool) * realBalance
        : 0;

      return {
        level,
        name: config.name,
        entryPrice: config.entryPrice,
        initialCapital: config.initialCapital,
        participants,
        prizePool: pool,
        prizePoolReal: parseFloat(realPoolForLevel.toFixed(2)),
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
    level, acceptTerms, hCaptchaToken,
    paymentNetwork = 'polygon'
  } = req.body;

  if (!acceptTerms) return res.status(400).json({ error: 'Debes aceptar términos y condiciones' });

  const captchaValid = await verifyHCaptcha(hCaptchaToken);
  if (!captchaValid) return res.status(400).json({ error: 'Captcha inválido — recarga la página e intenta de nuevo' });

  // ========== FORZAR EMAIL VERIFICADO PARA COMPETIR ==========
  if (email) {
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser && existingUser.emailVerified === false) {
      return res.status(403).json({
        error: 'Debes verificar tu email antes de inscribirte. Revisa tu bandeja de entrada.',
        code: 'EMAIL_NOT_VERIFIED'
      });
    }
  }
  // =============================================================

  if (!levelsConfig[level]) return res.status(400).json({ error: 'Nivel inválido' });

  const now = new Date();
  const utcHour = now.getUTCHours();
  if (utcHour >= 18) {
    return res.status(400).json({ error: 'Inscripciones cerradas después de las 18:00 UTC. ¡Vuelve mañana a las 00:00 UTC!' });
  }

  const { entryPrice: total, initialCapital: capital } = levelsConfig[level];

  const validNetworks = Object.keys(NETWORK_CONFIG);
  const selectedNetwork = validNetworks.includes(paymentNetwork) ? paymentNetwork : 'polygon';
  const netCfg = NETWORK_CONFIG[selectedNetwork];

  // Verificar que la moneda esté disponible en NowPayments antes de crear el invoice
  const currencyAvailable = await checkNowPaymentsCurrencyAvailable(netCfg.nowpaymentsCurrency);
  if (!currencyAvailable) {
    console.error(`❌ Moneda no disponible en NowPayments: ${netCfg.nowpaymentsCurrency}`);
    return res.status(503).json({
      error: `La red ${netCfg.label} no está disponible en este momento. Por favor selecciona otra red de pago.`,
      code: 'CURRENCY_UNAVAILABLE'
    });
  }

  try {
    let user = await prisma.user.findUnique({ where: { email } });
    if (user && user.password) {
    } else {
      const hashedPassword = password ? await bcrypt.hash(password, 10) : undefined;
      user = await prisma.user.upsert({
        where: { email },
        update: { walletAddress, password: hashedPassword, ...(country && { country }) },
        create: { email, walletAddress, password: hashedPassword, ...(country && { country }) }
      });
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    const response = await axios.post(`${NOWPAYMENTS_API}/invoice`, {
      price_amount: total,
      price_currency: "usd",
      pay_currency: netCfg.nowpaymentsCurrency,
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
        paymentNetwork: selectedNetwork,
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
    console.error('❌ Error creando pago:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error creando pago', details: error.response?.data || error.message });
  }
});

// Confirm entry manual (admin only)
app.post('/api/confirm-entry', authenticateAdmin, async (req, res) => {
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

// Manual confirm (admin only)
app.post('/api/manual-confirm', authenticateAdmin, async (req, res) => {
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
// OPEN TRADE - Actualizado con validación de riesgo real
app.post('/api/open-trade', authenticateToken, async (req, res) => {
  // ── Bloquear trading después de las 21:00 UTC (cierre de competición) ──────
  const nowUTC = new Date();
  if (nowUTC.getUTCHours() >= 21) {
    return res.status(400).json({
      error: 'La competición del día ha cerrado. Las operaciones están bloqueadas hasta las 00:00 UTC.',
      code: 'COMPETITION_CLOSED'
    });
  }
  // ──────────────────────────────────────────────────────────────────────────

  const { entryId, symbol, direction, lotSize, takeProfit, stopLoss } = req.body;
  const dir = direction.toLowerCase();
  if (!['long', 'short'].includes(dir)) return res.status(400).json({ error: "Direction long/short" });
  const currentPrice = getCurrentPrice(symbol);
  if (!currentPrice) return res.status(400).json({ error: "Precio no disponible" });
  if (lotSize < 0.01 || lotSize > 1.0) return res.status(400).json({ error: "LotSize 0.01-1.0" });

  try {
    // ========== FORZAR EMAIL VERIFICADO PARA OPERAR ==========
    const trader = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (trader && trader.emailVerified === false) {
      return res.status(403).json({
        error: 'Debes verificar tu email antes de operar. Revisa tu bandeja de entrada.',
        code: 'EMAIL_NOT_VERIFIED'
      });
    }
    // ==========================================================

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

    // ✅ VALIDACIÓN DE RIESGO REAL
    // Configuración de instrumentos (copiar esto al inicio del archivo o importar desde config)
    const instrumentConfig = {
      'EURUSD': { pipValue: 10, pipMultiplier: 10000, displayName: 'EUR/USD' },
      'GBPUSD': { pipValue: 10, pipMultiplier: 10000, displayName: 'GBP/USD' },
      'USDJPY': { pipValue: 9.09, pipMultiplier: 100, displayName: 'USD/JPY' },
      'XAUUSD': { pipValue: 1, pipMultiplier: 10, displayName: 'Gold' },
      'SPX500': { pipValue: 50, pipMultiplier: 1, displayName: 'S&P 500' },
      'NAS100': { pipValue: 20, pipMultiplier: 1, displayName: 'NASDAQ 100' }
    };

    const config = instrumentConfig[symbol] || instrumentConfig['EURUSD'];
    
    // Calcular distancia en pips/puntos
    const slPrice = stopLoss ? parseFloat(stopLoss) : null;
    const distancePips = slPrice 
      ? Math.abs(currentPrice - slPrice) * config.pipMultiplier
      : 100; // Default: asume 100 pips si no hay SL (riesgo máximo estimado)
    
    // Calcular riesgo en USD y porcentaje
    const riskUSD = distancePips * config.pipValue * lotSize;
    const riskPercent = (riskUSD / entry.virtualCapital) * 100;

    // Bloquear si el riesgo excede el 10%
    if (riskPercent > 10) {
      return res.status(400).json({ 
        error: `Riesgo ${riskPercent.toFixed(1)}% excede máximo 10%. Reduce lotSize o ajusta SL.`,
        details: {
          riskPercent: riskPercent.toFixed(2),
          riskUSD: riskUSD.toFixed(2),
          distancePips: Math.round(distancePips),
          symbol: symbol,
          currentPrice: currentPrice,
          stopLoss: slPrice,
          lotSize: lotSize,
          virtualCapital: entry.virtualCapital
        }
      });
    }

    // ✅ Crear la posición (incluyendo datos de riesgo calculados)
    await prisma.position.create({
      data: {
        entryId,
        symbol,
        direction: dir,
        lotSize,
        entryPrice: currentPrice,
        takeProfit: takeProfit ? parseFloat(takeProfit) : null,
        stopLoss: stopLoss ? parseFloat(stopLoss) : null,
        // Opcional: guardar el riesgo calculado para referencia
        // calculatedRiskPercent: riskPercent,
        // calculatedRiskUSD: riskUSD
      }
    });

    emitLiveData();

    res.json({ 
      message: `¡Trade abierto! ${dir.toUpperCase()} ${symbol} ${lotSize} lot a ${currentPrice.toFixed(2)}`,
      riskInfo: {
        riskPercent: riskPercent.toFixed(2),
        riskUSD: riskUSD.toFixed(2),
        distancePips: Math.round(distancePips)
      }
    });
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
        country: e.user.country || null,
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
      user = await prisma.user.create({ data: { email, walletAddress, emailVerified: true } });
    } else {
      user = await prisma.user.update({ where: { id: user.id }, data: { walletAddress, emailVerified: true } });
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

// ONE-TIME: Borrar cuentas bot de prueba – admin auth requerido
// ENDPOINT: entradas descalificadas por drawdown
app.get('/api/admin/disqualified-entries', authenticateAdmin, async (req, res) => {
  try {
    const entries = await prisma.entry.findMany({
      where: { status: 'disqualified' },
      include: { user: true, positions: true },
      orderBy: { createdAt: 'desc' }
    });
    const result = entries.map(e => {
      const levelCfg = levelsConfig[e.level] || { initialCapital: 10000 };
      const drawdownPct = (((levelCfg.initialCapital - e.virtualCapital) / levelCfg.initialCapital) * 100).toFixed(2);
      return {
        entryId: e.id,
        email: e.user.email,
        nickname: e.user.nickname,
        level: e.level,
        virtualCapital: e.virtualCapital,
        initialCapital: levelCfg.initialCapital,
        drawdownPercent: drawdownPct,
        disqualifiedAt: e.positions
          .filter(p => p.closeReason === 'drawdown_disqualified' || p.closeReason === 'SL_hit')
          .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))[0]?.closedAt || null,
        totalPositions: e.positions.length
      };
    });
    res.json({ total: result.length, entries: result });
  } catch (error) {
    console.error('❌ Error /admin/disqualified-entries:', error.message);
    res.status(500).json({ error: 'Error obteniendo entradas descalificadas' });
  }
});

app.post('/api/admin/cleanup-bots', authenticateAdmin, async (req, res) => {
  const botPattern = /^test\d+@holypot\.com$/;
  try {
    const candidates = await prisma.user.findMany({
      where: { email: { contains: '@holypot.com' } },
      include: { entries: { include: { positions: true } } }
    });
    const bots = candidates.filter(u => botPattern.test(u.email));

    const deleted = [];
    for (const user of bots) {
      for (const entry of user.entries) {
        await prisma.position.deleteMany({ where: { entryId: entry.id } });
        await prisma.entry.delete({ where: { id: entry.id } });
      }
      await prisma.user.delete({ where: { id: user.id } });
      deleted.push(user.email);
    }

    emitLiveData();
    res.json({ message: `${deleted.length} cuentas bot eliminadas`, accounts: deleted });
  } catch (error) {
    res.status(500).json({ error: 'Error limpieza bots', details: error.message });
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

// ── DIAGNOSTICO NOWPayments (admin) ──────────────────────────────
app.get('/api/admin/nowpayments-status', authenticateAdmin, async (req, res) => {
  const results = { timestamp: new Date().toISOString(), api: {}, balance: {}, competitions: {}, entries: {}, payouts: {}, discrepancies: [] };

  // 1. API connectivity
  try {
    const status = await axios.get(`${NOWPAYMENTS_API}/status`, { headers: { 'x-api-key': API_KEY } });
    results.api = { connected: true, message: status.data?.message };
  } catch (err) {
    results.api = { connected: false, error: err.response?.data?.message || err.message, httpStatus: err.response?.status };
    return res.json(results);
  }

  // 2. Balance real
  try {
    const balRes = await axios.get(`${NOWPAYMENTS_API}/balance`, { headers: { 'x-api-key': API_KEY } });
    const currencies = balRes.data?.currencies || [];
    const usdt = currencies.find(c => c.currency === 'usdttrc20');
    results.balance = {
      usdtAvailable: usdt ? parseFloat(usdt.available_balance || 0) : 0,
      usdtPending: usdt ? parseFloat(usdt.pending_balance || 0) : 0,
      allCurrencies: currencies.map(c => ({ currency: c.currency, available: parseFloat(c.available_balance || 0) }))
    };
  } catch (err) {
    results.balance = { error: err.response?.data?.message || err.message };
  }

  // 3. Competencias activas con pools
  try {
    const confirmed = await prisma.entry.findMany({ where: { status: 'confirmed' } });
    let totalTeorico = 0;
    const comps = {};

    for (const [level, config] of Object.entries(levelsConfig)) {
      const count = confirmed.filter(e => e.level === level).length;
      const ingresos = count * config.entryPrice;
      const comision = count * config.comision;
      const pool = ingresos - comision;
      totalTeorico += pool;
      comps[level] = { participants: count, ingresos, platformFee: comision, prizePoolTeorico: pool };
    }

    results.competitions = { levels: comps, totalTeoricoPool: totalTeorico, realBalance: results.balance.usdtAvailable || 0, difference: (results.balance.usdtAvailable || 0) - totalTeorico };

    if (Math.abs(results.competitions.difference) > 1) {
      results.discrepancies.push({
        type: 'balance_mismatch',
        detail: `Saldo NOWPayments ($${results.balance.usdtAvailable}) difiere del pool teorico ($${totalTeorico}) por $${results.competitions.difference.toFixed(2)}`,
        action: results.competitions.difference < 0
          ? 'Verificar payouts enviados que redujeron saldo o comisiones de red'
          : 'Posibles pagos no procesados o fondos extra en la cuenta'
      });
    }
  } catch (err) {
    results.competitions = { error: err.message };
  }

  // 4. Entries: pending vs confirmed + ultimas 24h
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 3600000);
    const [allEntries, recent] = await Promise.all([
      prisma.entry.groupBy({ by: ['status'], _count: true }),
      prisma.entry.findMany({ where: { createdAt: { gte: twentyFourHoursAgo } }, include: { user: { select: { email: true } } }, orderBy: { createdAt: 'desc' } })
    ]);

    const statusCounts = {};
    allEntries.forEach(g => { statusCounts[g.status] = g._count; });

    const staleEntries = recent.filter(e => e.status === 'pending' && (Date.now() - new Date(e.createdAt).getTime()) > 2 * 3600000);

    results.entries = {
      statusCounts,
      last24h: recent.map(e => ({ id: e.id, level: e.level, status: e.status, paymentId: e.paymentId, email: e.user?.email, createdAt: e.createdAt })),
      staleCount: staleEntries.length
    };

    if (staleEntries.length > 0) {
      results.discrepancies.push({
        type: 'stale_pending_entries',
        detail: `${staleEntries.length} entries llevan >2h en "pending" — posible callback perdido`,
        action: 'Verificar estado de estos pagos en NOWPayments dashboard y confirmar manualmente si corresponde',
        entryIds: staleEntries.map(e => e.id)
      });
    }
  } catch (err) {
    results.entries = { error: err.message };
  }

  // 5. Payouts status
  try {
    const [payoutGroups, recentPayouts] = await Promise.all([
      prisma.payout.groupBy({ by: ['status'], _count: true, _sum: { amount: true } }),
      prisma.payout.findMany({ orderBy: { date: 'desc' }, take: 10, include: { user: { select: { email: true } } } })
    ]);

    const payoutSummary = {};
    payoutGroups.forEach(g => { payoutSummary[g.status] = { count: g._count, totalAmount: g._sum.amount || 0 }; });

    results.payouts = {
      summary: payoutSummary,
      recent: recentPayouts.map(p => ({ id: p.id, level: p.level, position: p.position, amount: p.amount, status: p.status, paymentId: p.paymentId, email: p.user?.email, date: p.date }))
    };

    const failedCount = payoutSummary.failed?.count || 0;
    const sentCount = payoutSummary.sent?.count || 0;

    if (failedCount > 0) {
      results.discrepancies.push({
        type: 'failed_payouts',
        detail: `${failedCount} payouts con status "failed"`,
        action: 'Reintentar envio o verificar wallets de los ganadores'
      });
    }
    if (sentCount > 0) {
      results.discrepancies.push({
        type: 'unconfirmed_payouts',
        detail: `${sentCount} payouts "sent" sin confirmacion blockchain`,
        action: 'Verificar webhook de payout o consultar estado en NOWPayments dashboard'
      });
    }
  } catch (err) {
    results.payouts = { error: err.message };
  }

  // 6. Pagos recientes NOWPayments (últimos 10)
  try {
    const npRes = await axios.get(`${NOWPAYMENTS_API}/payment/`, {
      headers: { 'x-api-key': API_KEY },
      params: { limit: 10, orderBy: 'created_at', sortBy: 'desc' }
    });
    const npPayments = npRes.data?.data || [];

    // Cruzar con DB
    if (npPayments.length > 0) {
      const npIds = npPayments.map(p => p.payment_id?.toString()).filter(Boolean);
      const dbEntries = await prisma.entry.findMany({
        where: { paymentId: { in: npIds } },
        select: { paymentId: true, status: true }
      });
      const dbMap = new Map(dbEntries.map(e => [e.paymentId, e.status]));

      const orphaned = npPayments.filter(p => {
        const id = p.payment_id?.toString();
        return id && !dbMap.has(id) && (p.payment_status === 'finished' || p.payment_status === 'confirmed');
      });

      if (orphaned.length > 0) {
        results.discrepancies.push({
          type: 'orphaned_payments',
          detail: `${orphaned.length} pagos confirmados en NOWPayments sin registro en DB`,
          action: 'Verificar si son pagos validos y crear entries manualmente',
          paymentIds: orphaned.map(p => p.payment_id)
        });
      }

      results.nowpaymentsRecent = npPayments.map(p => ({
        paymentId: p.payment_id,
        status: p.payment_status,
        priceAmount: p.price_amount,
        actuallyPaid: p.actually_paid,
        currency: p.pay_currency,
        createdAt: p.created_at,
        dbStatus: dbMap.get(p.payment_id?.toString()) || 'NOT_IN_DB'
      }));
    }
  } catch (err) {
    results.nowpaymentsRecent = { error: err.response?.data?.message || err.message };
  }

  results.healthScore = results.discrepancies.length === 0 ? 'HEALTHY' : results.discrepancies.length <= 2 ? 'WARNING' : 'CRITICAL';

  res.json(results);
});

app.get('/', (req, res) => res.json({ message: 'Holypot Trading corriendo! 🚀' }));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));

// 🆕 CRON CIERRE DIARIO 21:00 UTC + PAGOS AUTOMÁTICOS + ROLLOVER + CONSEJOS IA + LIMPIEZA VELAS
cron.schedule('0 21 * * *', async () => {
  console.log('🔥 CRON 21:00 UTC – Cierre competencia diaria + PAGOS AUTOMÁTICOS + rollover + consejos IA + limpieza velas');

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

      // ========== GUARDAR PAYOUTS PENDIENTES (el batch los enviará a las 02:00 AM) ==========
      const totalPrizesToPay = Math.min(3, finalRanking.length);
      console.log(`💾 ${level.toUpperCase()}: Guardando ${totalPrizesToPay} payouts pendientes para batch settlement`);

      for (let i = 0; i < totalPrizesToPay; i++) {
        const winner = finalRanking[i];
        const grossPrize = prizePool * prizes[i];
        const winnerNetwork = winner.entry.paymentNetwork || 'trc20';
        const netFee = NETWORK_CONFIG[winnerNetwork]?.fee || 1.5;
        const prizeAmount = Math.max(0, grossPrize - netFee);
        const walletAddress = winner.entry.user.walletAddress;

        if (!walletAddress) {
          console.log(`⚠️ ${i+1}º ${level.toUpperCase()}: Usuario sin wallet – omitido`);
          continue;
        }

        await prisma.payout.create({
          data: {
            userId: winner.entry.userId,
            level,
            position: i + 1,
            amount: prizeAmount,
            status: 'pending',
            network: winnerNetwork,
            walletAddress
          }
        });

        console.log(`💾 ${i+1}º ${level.toUpperCase()}: ${winner.entry.user.nickname || winner.entry.user.email} – ${prizeAmount.toFixed(2)} USDT neto (${winnerNetwork}) – pendiente batch`);
      }

      console.log(`✅ Competencia ${level.toUpperCase()} cerrada + ${totalPrizesToPay} payouts en cola para batch`);
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

    // ── Re-fetch capital final desde DB (los updates de la posición ya se aplicaron) ──
    const finalEntries = await prisma.entry.findMany({
      where: { id: { in: entriesToday.map(e => e.id) } },
      include: { user: { select: { id: true, nickname: true, email: true } }, positions: true }
    });

    // ── Emitir evento competitionEnded a todos los clientes conectados ──────────
    const competitionResults = {};
    for (const [level, originalEntries] of Object.entries(byLevel)) {
      const config = levelsConfig[level];
      const participants = originalEntries.length;

      if (participants < 5) {
        competitionResults[level] = { rollover: true, participants };
        continue;
      }

      const prizePool = participants * config.entryPrice - participants * config.comision;
      const prizes = [0.5, 0.3, 0.2];

      const levelFinal = finalEntries.filter(e => e.level === level);
      const ranked = levelFinal.map(e => ({
        entryId: e.id,
        nickname: e.user?.nickname || 'Anónimo',
        retorno: parseFloat(((e.virtualCapital - config.initialCapital) / config.initialCapital * 100).toFixed(2)),
        liveCapital: e.virtualCapital,
      })).sort((a, b) => b.retorno - a.retorno);

      competitionResults[level] = {
        rollover: false,
        participants,
        prizePool: parseFloat(prizePool.toFixed(2)),
        top3: ranked.slice(0, 3).map((t, i) => ({
          ...t,
          position: i + 1,
          prize: parseFloat((prizePool * prizes[i]).toFixed(2)),
        })),
        ranking: ranked.slice(0, 10),
      };
    }
    io.emit('competitionEnded', competitionResults);
    console.log('📣 Evento competitionEnded emitido a todos los clientes');

    // GENERACIÓN CONSEJOS IA (con Promise.allSettled para que un error no bloquee el cron)
    if (!process.env.GROK_API_KEY) {
      console.warn('⚠️ GROK_API_KEY no definida – consejo IA omitido');
    } else {
      await Promise.allSettled(finalEntries.map(async (entry) => {
        const symbolCount = {};
        entry.positions.forEach(p => {
          symbolCount[p.symbol] = (symbolCount[p.symbol] || 0) + 1;
        });

        const initial = levelsConfig[entry.level]?.initialCapital || 10000;
        const dailyReturn = ((entry.virtualCapital - initial) / initial) * 100;
        const buys  = entry.positions.filter(p => p.direction === 'long').length;
        const sells = entry.positions.filter(p => p.direction === 'short').length;
        const topAsset = Object.keys(symbolCount).sort((a, b) => symbolCount[b] - symbolCount[a])[0] || 'Ninguno';

        const prompt = `Analiza el desempeño del trader ${entry.user.nickname || 'Anónimo'} hoy:
- Retorno: ${dailyReturn.toFixed(2)}%
- LONG: ${buys} | SHORT: ${sells}
- Activo más operado: ${topAsset}
Genera un consejo breve y motivador en español (máx 250 caracteres, tono profesional):`;

        const response = await axios.post('https://api.x.ai/v1/chat/completions', {
          model: "grok-beta",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.7,
          max_tokens: 300
        }, {
          headers: { 'Authorization': `Bearer ${process.env.GROK_API_KEY}`, 'Content-Type': 'application/json' },
          timeout: 15000
        });

        const adviceText = response.data.choices[0].message.content.trim();
        await prisma.advice.create({
          data: { userId: entry.user.id, date: new Date(), text: adviceText }
        });
        console.log(`💡 Consejo IA generado para ${entry.user.nickname || entry.user.email}`);
      }));
    }

    emitLiveData();
  } catch (error) {
    console.error('Error en cron diario:', error);
  }
});

// 🆕 CRON BATCH SETTLEMENT 02:00 AM UTC – Envía todos los payouts pendientes agrupados por red
cron.schedule('0 2 * * *', async () => {
  console.log('🏦 CRON 02:00 UTC – Batch Settlement: enviando payouts pendientes...');
  try {
    const result = await processBatchPayouts();
    console.log(`✅ Batch Settlement completado: ${result.processed} payouts procesados`);
    emitLiveData();
  } catch (error) {
    console.error('❌ Error en cron batch settlement:', error);
  }
});
