const axios = require('axios');

const API_BASE = 'https://holypot-backend.onrender.com/api';
const LEVEL = 'basic';

// ─────────────────────────────────────────────
// SECCION 1: Amigos reales
// Rellena con los datos de cada amigo
// ─────────────────────────────────────────────
const AMIGOS = [
  {
    email: 'rodrivit99@gmail.com',         // <-- cambia esto
    walletAddress: 'TMQSG6kih8ZWjtthSLFxc3abTASxwPftju',  // <-- wallet TRC-20 del amigo
    nickname: 'nioz',                // <-- nombre que vera en el ranking
  },
  {
    email: 'linaperez2701@gmail.com',         // <-- cambia esto
    walletAddress: 'TDaZh6SK41Tk7MwDLTEjScEyWZnBTfmmDr',
    nickname: 'TuAmor',
  },
  {
    email: 'amigo3@gmail.com',         // <-- cambia esto
    walletAddress: 'TWALLET_AMIGO_3',
    nickname: 'Amigo3',
  },
];

// ─────────────────────────────────────────────
// SECCION 2: Usuarios fake para poblar el ranking
// No toques esto
// ─────────────────────────────────────────────
const FAKE_WALLET = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const FAKE_COUNT = 10;
const FAKE_START = 100; // test100 a test109

async function crearAmigo({ email, walletAddress, nickname }) {
  console.log(`\n[AMIGO] Procesando ${email}...`);
  try {
    await axios.post(`${API_BASE}/register`, {
      email,
      password: 'holypot2024.24',
      walletAddress,
      nickname,
    });
    console.log(`  ✓ Usuario registrado`);
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    if (msg.includes('already') || msg.includes('existe') || msg.includes('unique')) {
      console.log(`  ~ Usuario ya existe, continuando...`);
    } else {
      console.error(`  ✗ Error registro: ${msg}`);
      return;
    }
  }

  try {
    await axios.post(`${API_BASE}/manual-create-confirm`, {
      email,
      walletAddress,
      level: LEVEL,
    });
    console.log(`  ✓ Entry confirmada – puede operar sin pagar`);
    console.log(`  → Login: ${email} / holypot2024.24`);
  } catch (err) {
    console.error(`  ✗ Error confirming entry: ${err.response?.data?.error || err.message}`);
  }
}

async function crearFake(index) {
  const email = `test${index}@holypot.com`;
  const nickname = `Trader${index}`;
  console.log(`\n[FAKE] Creando ${email}...`);

  try {
    await axios.post(`${API_BASE}/register`, {
      email,
      password: 'test123.456',
      walletAddress: FAKE_WALLET,
      nickname,
    });
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    if (!msg.includes('already') && !msg.includes('existe') && !msg.includes('unique')) {
      console.error(`  ✗ Error: ${msg}`);
      return;
    }
  }

  try {
    await axios.post(`${API_BASE}/manual-create-confirm`, {
      email,
      walletAddress: FAKE_WALLET,
      level: LEVEL,
    });
    console.log(`  ✓ ${nickname} listo`);
  } catch (err) {
    console.error(`  ✗ Error entry: ${err.response?.data?.error || err.message}`);
  }
}

(async () => {
  console.log('====================================');
  console.log('  HOLYPOT – Setup MVP');
  console.log(`  Nivel: ${LEVEL.toUpperCase()}`);
  console.log('====================================');

  // 1. Crear amigos reales
  console.log('\n>>> AMIGOS REALES');
  for (const amigo of AMIGOS) {
    await crearAmigo(amigo);
  }

  // 2. Crear usuarios fake
  console.log('\n>>> USUARIOS FAKE (para poblar ranking)');
  for (let i = FAKE_START; i < FAKE_START + FAKE_COUNT; i++) {
    await crearFake(i);
  }

  console.log('\n====================================');
  console.log('  SETUP COMPLETADO');
  console.log('  Amigos: login con holypot2024');
  console.log('  Fakes:  login con test123');
  console.log('====================================');
})();
