const axios = require('axios');

const API_BASE = 'https://holypot-backend.onrender.com/api';

// ─────────────────────────────────────────────────────────────
// Usuarios fake: test100 a test109  →  password: "testing123"
// ─────────────────────────────────────────────────────────────
const fakeUsers = [];
for (let i = 100; i <= 109; i++) {
  fakeUsers.push({ email: `test${i}@holypot.com`, password: 'testing123' });
}

// ─────────────────────────────────────────────────────────────
// Amigos reales: rellena con sus emails
// password que usaran para entrar
// ─────────────────────────────────────────────────────────────
const amigos = [
  { email: 'amigo1@gmail.com', password: 'holypot2024' }, // <-- cambia email
  { email: 'amigo2@gmail.com', password: 'holypot2024' }, // <-- cambia email
  { email: 'amigo3@gmail.com', password: 'holypot2024' }, // <-- cambia email
];

(async () => {
  const allUsers = [...amigos, ...fakeUsers];

  console.log(`\nFijando passwords para ${allUsers.length} usuarios...`);

  try {
    const { data } = await axios.post(`${API_BASE}/admin/fix-passwords`, { users: allUsers });
    console.log(`\n✓ Corregidos: ${data.fixed} / ${allUsers.length}`);

    const errors = data.results.filter(r => !r.status.startsWith('ok'));
    if (errors.length) {
      console.log('\nErrores:');
      errors.forEach(e => console.log(`  ✗ ${e.email}: ${e.status}`));
    }

    const ok = data.results.filter(r => r.status === 'ok');
    if (ok.length) {
      console.log('\n─────────────────────────────────');
      console.log('CREDENCIALES PARA INICIAR SESION:');
      console.log('─────────────────────────────────');
      amigos.forEach(u => console.log(`  ${u.email}  /  ${u.password}`));
      console.log(`\n  test100@holypot.com a test109@holypot.com  /  testing123`);
      console.log('─────────────────────────────────\n');
    }
  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
  }
})();
