const axios = require('axios');

const API_BASE = 'https://holypot-backend.onrender.com/api';

(async () => {
  try {
    const { data } = await axios.get(`${API_BASE}/admin/confirmed-users`);

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log(`  USUARIOS CON ENTRY CONFIRMADA – Total: ${data.total}`);
    console.log('══════════════════════════════════════════════════════════════');

    const ok     = data.users.filter(u => u.hasPassword && u.emailVerified);
    const noPass = data.users.filter(u => !u.hasPassword);
    const noVer  = data.users.filter(u => u.hasPassword && !u.emailVerified);

    if (ok.length) {
      console.log(`\n✅ PUEDEN INICIAR SESION (${ok.length}):`);
      console.log('─────────────────────────────────────────────────────');
      ok.forEach(u => {
        const pass = u.email.includes('@holypot.com') ? 'testing123' : 'holypot2024';
        console.log(`  📧 ${(u.email || '').padEnd(35)} | 🔑 ${pass} | 👤 ${u.nickname || '(sin nickname)'}`);
      });
    }

    if (noPass.length) {
      console.log(`\n❌ SIN PASSWORD – NO PUEDEN ENTRAR (${noPass.length}):`);
      console.log('─────────────────────────────────────────────────────');
      noPass.forEach(u => console.log(`  📧 ${u.email}`));
      console.log('\n  → Corre: node fixPasswords.js  para arreglarlos');
    }

    if (noVer.length) {
      console.log(`\n⚠️  TIENEN PASSWORD PERO EMAIL NO VERIFICADO (${noVer.length}):`);
      noVer.forEach(u => console.log(`  📧 ${u.email}`));
    }

    console.log('\n══════════════════════════════════════════════════════════════\n');
  } catch (err) {
    if (err.response?.status === 404) {
      console.error('\n❌ Endpoint no encontrado. Espera el deploy de Render y vuelve a intentar.\n');
    } else {
      console.error('Error:', err.response?.data || err.message);
    }
  }
})();
