#!/usr/bin/env node
// test-nowpayments.js — Diagnóstico completo de integración NOWPayments
// Uso: node test-nowpayments.js

require('dotenv').config();
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const API = 'https://api.nowpayments.io/v1';
const KEY = process.env.NOWPAYMENTS_API_KEY;

const levelsConfig = {
  basic:   { name: 'Basic',   entryPrice: 12,  comision: 2, initialCapital: 10000  },
  medium:  { name: 'Medium',  entryPrice: 54,  comision: 4, initialCapital: 50000  },
  premium: { name: 'Premium', entryPrice: 107, comision: 7, initialCapital: 100000 }
};

const headers = { 'x-api-key': KEY, 'Content-Type': 'application/json' };

// ── Helpers ──────────────────────────────────────────────────────
function sep(title) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function ok(msg)   { console.log(`  [OK]   ${msg}`); }
function warn(msg) { console.log(`  [WARN] ${msg}`); }
function fail(msg) { console.log(`  [FAIL] ${msg}`); }
function info(msg) { console.log(`  [INFO] ${msg}`); }

// ── 1. Verificar conexión API (IP dinámica) ─────────────────────
async function testConnection() {
  sep('1. CONEXION API NOWPayments (IP Dinamica)');
  try {
    const res = await axios.get(`${API}/status`, { headers });
    if (res.data?.message === 'OK') {
      ok(`API accesible — status: ${res.data.message}`);
      return true;
    }
    warn(`Respuesta inesperada: ${JSON.stringify(res.data)}`);
    return true;
  } catch (err) {
    fail(`No se pudo conectar: ${err.response?.status || ''} ${err.response?.data?.message || err.message}`);
    if (err.response?.status === 403) {
      fail('IP rechazada — verifica que Dynamic IP este habilitado en NOWPayments dashboard');
    }
    return false;
  }
}

// ── 2. Obtener saldo actual ──────────────────────────────────────
async function getBalance() {
  sep('2. SALDO ACTUAL NOWPayments');
  try {
    const res = await axios.get(`${API}/balance`, { headers });
    const currencies = res.data?.currencies || [];

    if (currencies.length === 0) {
      warn('No se encontraron monedas en el balance');
      return 0;
    }

    let usdtBalance = 0;
    currencies.forEach(c => {
      const avail = parseFloat(c.available_balance || 0);
      const pend  = parseFloat(c.pending_balance || 0);
      info(`${c.currency}: disponible=${avail}, pendiente=${pend}`);
      if (c.currency === 'usdttrc20') usdtBalance = avail;
    });

    ok(`Saldo USDT TRC-20: ${usdtBalance} USDT`);
    return usdtBalance;
  } catch (err) {
    fail(`Error obteniendo balance: ${err.response?.data?.message || err.message}`);
    return 0;
  }
}

// ── 3. Calcular real pool por competencia ────────────────────────
async function calculatePools(realBalance) {
  sep('3. POOL POR COMPETENCIA (Teorico vs Real)');
  try {
    const entries = await prisma.entry.findMany({ where: { status: 'confirmed' } });

    let totalTeorico = 0;
    const pools = {};

    for (const [level, config] of Object.entries(levelsConfig)) {
      const count = entries.filter(e => e.level === level).length;
      const ingresos = count * config.entryPrice;
      const comision = count * config.comision;
      const pool = ingresos - comision;
      totalTeorico += pool;

      pools[level] = { participants: count, ingresos, comision, poolTeorico: pool };
      info(`${config.name.padEnd(8)} | ${count} participantes | Ingresos: $${ingresos} | Comision: $${comision} | Pool: $${pool}`);
    }

    console.log('  ─'.repeat(20));
    info(`Pool teorico total: $${totalTeorico}`);
    info(`Saldo real NOWPayments: $${realBalance}`);

    const diff = realBalance - totalTeorico;
    if (Math.abs(diff) < 1) {
      ok(`Diferencia despreciable: $${diff.toFixed(2)}`);
    } else if (diff > 0) {
      warn(`Excedente en NOWPayments: +$${diff.toFixed(2)} (posibles pagos no procesados o comisiones acumuladas)`);
    } else {
      warn(`Deficit en NOWPayments: $${diff.toFixed(2)} (posibles payouts ya enviados o comisiones de red)`);
      warn('ACCION: Verificar payouts enviados que redujeron el saldo');
    }

    return { pools, totalTeorico };
  } catch (err) {
    fail(`Error consultando DB: ${err.message}`);
    return { pools: {}, totalTeorico: 0 };
  }
}

// ── 4. Listar últimos pagos recibidos ────────────────────────────
async function listRecentPayments() {
  sep('4. ULTIMOS 10 PAGOS RECIBIDOS (NOWPayments)');
  try {
    const res = await axios.get(`${API}/payment/`, {
      headers,
      params: { limit: 10, orderBy: 'created_at', sortBy: 'desc' }
    });

    const payments = res.data?.data || [];
    if (payments.length === 0) {
      warn('No se encontraron pagos recientes en NOWPayments');
      return payments;
    }

    payments.forEach((p, i) => {
      const date = new Date(p.created_at).toISOString().slice(0, 16);
      info(`${(i + 1 + '.').padEnd(4)} ID:${p.payment_id} | ${p.payment_status.padEnd(10)} | $${p.price_amount} USD | ${p.actually_paid || '?'} ${p.pay_currency} | ${date}`);
    });

    ok(`${payments.length} pagos listados`);
    return payments;
  } catch (err) {
    if (err.response?.status === 400 || err.response?.status === 404) {
      warn(`Endpoint /payment/ no disponible o sin datos: ${err.response?.data?.message || err.message}`);
    } else {
      fail(`Error listando pagos: ${err.response?.data?.message || err.message}`);
    }
    return [];
  }
}

// ── 5. Verificar callbacks pendientes ────────────────────────────
async function checkPendingCallbacks() {
  sep('5. ENTRIES PENDIENTES EN DB (sin confirmar)');
  try {
    const pending = await prisma.entry.findMany({
      where: { status: 'pending' },
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20
    });

    if (pending.length === 0) {
      ok('No hay entries pendientes — todos los callbacks fueron procesados');
      return pending;
    }

    warn(`${pending.length} entries con status "pending":`);
    pending.forEach(e => {
      const age = Math.round((Date.now() - new Date(e.createdAt).getTime()) / 3600000);
      const flag = age > 2 ? ' [STALE]' : '';
      info(`  ${e.id.slice(0, 8)}... | ${e.level.padEnd(8)} | paymentId: ${e.paymentId || 'N/A'} | ${e.user?.email || '?'} | hace ${age}h${flag}`);
    });

    const stale = pending.filter(e => (Date.now() - new Date(e.createdAt).getTime()) > 2 * 3600000);
    if (stale.length > 0) {
      warn(`ACCION: ${stale.length} entries tienen >2h pendientes — verificar manualmente en NOWPayments dashboard`);
    }

    return pending;
  } catch (err) {
    fail(`Error consultando DB: ${err.message}`);
    return [];
  }
}

// ── 6. Comparar deposits DB vs NOWPayments ───────────────────────
async function compareDeposits(nowPayments) {
  sep('6. COMPARACION: DB vs NOWPayments');
  try {
    const allEntries = await prisma.entry.findMany({
      where: { paymentId: { not: null } },
      select: { paymentId: true, status: true, level: true }
    });

    const dbPaymentIds = new Set(allEntries.map(e => e.paymentId));
    const npPaymentIds = new Set(nowPayments.map(p => p.payment_id?.toString()));

    info(`Entries con paymentId en DB: ${allEntries.length}`);
    info(`Pagos en NOWPayments (muestra): ${nowPayments.length}`);

    // Pagos en NP no registrados en DB
    const notInDb = nowPayments.filter(p => !dbPaymentIds.has(p.payment_id?.toString()));
    if (notInDb.length > 0) {
      warn(`${notInDb.length} pagos en NOWPayments NO encontrados en DB:`);
      notInDb.forEach(p => {
        info(`  payment_id: ${p.payment_id} | status: ${p.payment_status} | $${p.price_amount}`);
      });
      warn('ACCION: Verificar si son pagos de otro servicio o entries huerfanas');
    } else {
      ok('Todos los pagos de la muestra NOWPayments estan en DB');
    }

    // Entries confirmed en DB — verificar coherencia
    const confirmed = allEntries.filter(e => e.status === 'confirmed').length;
    const pendingDb = allEntries.filter(e => e.status === 'pending').length;
    info(`DB: ${confirmed} confirmed, ${pendingDb} pending`);

    return { dbTotal: allEntries.length, confirmed, pending: pendingDb, notInDb: notInDb.length };
  } catch (err) {
    fail(`Error en comparacion: ${err.message}`);
    return {};
  }
}

// ── 7. Verificar payouts ─────────────────────────────────────────
async function checkPayouts() {
  sep('7. ESTADO DE PAYOUTS');
  try {
    const payouts = await prisma.payout.findMany({
      include: { user: { select: { email: true } } },
      orderBy: { date: 'desc' },
      take: 20
    });

    if (payouts.length === 0) {
      info('No hay payouts registrados en DB');
      return;
    }

    const byStatus = {};
    payouts.forEach(p => {
      byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    });

    Object.entries(byStatus).forEach(([s, c]) => info(`${s}: ${c} payouts`));
    console.log('  ─'.repeat(20));

    payouts.forEach(p => {
      const date = p.date.toISOString().slice(0, 16);
      const flag = p.status === 'failed' ? ' [REQUIERE ATENCION]' :
                   p.status === 'sent' ? ' [PENDIENTE CONFIRMACION]' : '';
      info(`  #${p.id} | ${p.level.padEnd(8)} | Pos ${p.position} | $${p.amount.toFixed(2)} | ${p.status.padEnd(10)} | ${p.user?.email || '?'} | ${date}${flag}`);
    });

    const failed = payouts.filter(p => p.status === 'failed');
    if (failed.length > 0) {
      warn(`ACCION: ${failed.length} payouts fallidos — reintentar manualmente o verificar wallets`);
    }

    const sent = payouts.filter(p => p.status === 'sent');
    if (sent.length > 0) {
      warn(`ACCION: ${sent.length} payouts "sent" sin confirmar — verificar blockchain o webhook`);
    }

    const totalPaid = payouts.filter(p => p.status === 'confirmed').reduce((s, p) => s + p.amount, 0);
    const totalPending = payouts.filter(p => p.status === 'sent').reduce((s, p) => s + p.amount, 0);
    info(`Total confirmado: $${totalPaid.toFixed(2)} | Pendiente confirmacion: $${totalPending.toFixed(2)}`);
  } catch (err) {
    fail(`Error consultando payouts: ${err.message}`);
  }
}

// ── 8. Verificar API key y currencies disponibles ────────────────
async function checkAvailableCurrencies() {
  sep('8. VERIFICACION API KEY & MONEDAS');
  try {
    const res = await axios.get(`${API}/merchant/coins`, { headers });
    const coins = res.data?.selectedCurrencies || res.data?.currencies || [];

    if (coins.length === 0) {
      warn('No se encontraron monedas habilitadas');
      return;
    }

    const hasUsdt = coins.includes('usdttrc20') || coins.some(c => c === 'usdttrc20');
    if (hasUsdt) {
      ok('USDT TRC-20 esta habilitado en tu cuenta');
    } else {
      fail('USDT TRC-20 NO encontrado en monedas habilitadas');
      warn('ACCION: Habilitar usdttrc20 en NOWPayments dashboard > Coins Settings');
    }

    info(`Total monedas habilitadas: ${coins.length}`);
  } catch (err) {
    if (err.response?.status === 401) {
      fail('API Key invalida o expirada');
    } else {
      warn(`No se pudo verificar monedas: ${err.response?.data?.message || err.message}`);
    }
  }
}

// ── MAIN ─────────────────────────────────────────────────────────
async function main() {
  console.log('\n  HOLYPOT — Diagnostico NOWPayments');
  console.log(`  Fecha: ${new Date().toISOString()}`);
  console.log(`  API Key: ${KEY ? KEY.slice(0, 8) + '...' + KEY.slice(-4) : 'NO CONFIGURADA'}`);
  console.log(`  Secret: ${process.env.NOWPAYMENTS_SECRET ? 'Configurado' : 'NO CONFIGURADO'}`);

  if (!KEY) {
    fail('NOWPAYMENTS_API_KEY no esta en .env — abortando');
    process.exit(1);
  }

  const connected = await testConnection();
  if (!connected) {
    fail('No se pudo conectar a NOWPayments — abortando demas pruebas');
    await prisma.$disconnect();
    process.exit(1);
  }

  const balance = await getBalance();
  const { totalTeorico } = await calculatePools(balance);
  const npPayments = await listRecentPayments();
  await checkPendingCallbacks();
  await compareDeposits(npPayments);
  await checkPayouts();
  await checkAvailableCurrencies();

  // ── Resumen final ──
  sep('RESUMEN FINAL');
  info(`Saldo NOWPayments:    $${balance} USDT`);
  info(`Pool teorico total:   $${totalTeorico} USDT`);
  info(`Diferencia:           $${(balance - totalTeorico).toFixed(2)} USDT`);
  ok('Diagnostico completado\n');

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('\nError fatal:', err);
  await prisma.$disconnect();
  process.exit(1);
});
