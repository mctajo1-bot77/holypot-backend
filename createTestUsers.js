const axios = require('axios');
const API_BASE = 'http://localhost:5000/api';

async function createTestUser(index) {
  const email = `test${index}@holypot.com`;
  const nickname = `TestTrader${index}`;
  const password = 'test123';
  const wallet = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const level = 'basic';

  try {
    // Register (crea user con password)
    await axios.post(`${API_BASE}/register`, {
      email,
      password,
      walletAddress: wallet,
      nickname
    });
    console.log(`User ${email} creado`);

    // Manual-create-confirm (crea entry confirmed)
    await axios.post(`${API_BASE}/manual-create-confirm`, {
      email,
      walletAddress: wallet,
      level
    });
    console.log(`Entry confirmed para ${email}`);
  } catch (err) {
    console.error(`Error user ${email}:`, err.response?.data || err.message);
  }
}

// Crea 20 users (cambia 20 por menos si quieres)
(async () => {
  for (let i = 51; i <= 70; i++) { // test51 a test70 (distintos anteriores)
    await createTestUser(i);
  }
  console.log('¡20 users test creados con password "test123" + entry confirmed!');
})();