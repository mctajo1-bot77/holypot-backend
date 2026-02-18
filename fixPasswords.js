const axios = require('axios');

const API_BASE = 'https://holypot-backend.onrender.com/api';
const LEVEL = 'basic';
const FAKE_WALLET = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

// ─────────────────────────────────────────────────────────────
// Amigos reales – pon sus emails reales aqui
// ─────────────────────────────────────────────────────────────
const amigos = [
  { email: 'amigo1@gmail.com', walletAddress: 'TWALLET_AMIGO_1', nickname: 'Amigo1' },
  { email: 'amigo2@gmail.com', walletAddress: 'TWALLET_AMIGO_2', nickname: 'Amigo2' },
  { email: 'amigo3@gmail.com', walletAddress: 'TWALLET_AMIGO_3', nickname: 'Amigo3' },
];

// ─────────────────────────────────────────────────────────────
// Usuarios fake test100 a test109
// ─────────────────────────────────────────────────────────────
const fakeUsers = [];
for (let i = 100; i <= 109; i++) {
  fakeUsers.push({ email: `test${i}@holypot.com`, walletAddress: FAKE_WALLET, nickname: `Trader${i}` });
}

async function fixUser({ email, walletAddress, nickname, password }) {
  try {
    await axios.post(`${API_BASE}/manual-create-confirm`, {
      email,
      walletAddress,
      nickname,
      password,
      level: LEVEL,
    });
    console.log(`  ✓ ${email} – password y emailVerified OK`);
    return true;
  } catch (err) {
    console.error(`  ✗ ${email}: ${err.response?.data?.error || err.message}`);
    return false;
  }
}

(async () => {
  console.log('\n====================================');
  console.log('  HOLYPOT – Fix Passwords');
  console.log('====================================');

  let ok = 0;

  console.log('\n>>> AMIGOS REALES (password: holypot2024)');
  for (const amigo of amigos) {
    const result = await fixUser({ ...amigo, password: 'holypot2024' });
    if (result) ok++;
  }

  console.log('\n>>> USUARIOS FAKE (password: testing123)');
  for (const fake of fakeUsers) {
    const result = await fixUser({ ...fake, password: 'testing123' });
    if (result) ok++;
  }

  const total = amigos.length + fakeUsers.length;
  console.log(`\n✓ Corregidos: ${ok} / ${total}`);
  console.log('\n─────────────────────────────────');
  console.log('CREDENCIALES PARA INICIAR SESION:');
  console.log('─────────────────────────────────');
  amigos.forEach(u => console.log(`  ${u.email}  /  holypot2024`));
  console.log(`  test100@holypot.com ... test109@holypot.com  /  testing123`);
  console.log('─────────────────────────────────\n');
})();
