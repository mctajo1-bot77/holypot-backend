import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate, Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import background from "@/assets/background.jpg";

axios.defaults.withCredentials = true;

const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : 'http://localhost:5000/api';

const LoginPage = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await axios.post(`${API_BASE}/login`, { email, password }, { withCredentials: true });

      // ✅ FIX: Limpiar TODOS los tokens previos (sesión admin, datos viejos, etc.)
      localStorage.removeItem('holypotAdminToken');
      localStorage.removeItem('holypotToken');
      localStorage.removeItem('holypotEntryId');

      // Guardar token del usuario
      if (res.data.token) {
        localStorage.setItem('holypotToken', res.data.token);
      }

      // Guardar entryId si existe
      if (res.data.entryId) {
        localStorage.setItem('holypotEntryId', res.data.entryId);
      }

      // Navegar al dashboard
      navigate('/dashboard');
    } catch (err) {
      alert('Error al iniciar sesión: ' + (err.response?.data?.error || 'Credenciales incorrectas'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen text-white relative overflow-hidden">
      {/* FONDO */}
      <div className="fixed inset-0 -z-10">
        <img
          src={background}
          alt="Fondo Holypot"
          className="w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-black/60" />
      </div>

      {/* HEADER */}
      <header className="relative z-10 py-8 text-center">
        <h1 className="text-6xl font-bold text-holy animate-pulse">Holypot Trading 🚀</h1>
        <p className="text-2xl text-gray-300 mt-4">Inicia sesión y vuelve a competir</p>
      </header>

      {/* CARD LOGIN CENTRAL */}
      <div className="max-w-md mx-auto px-8 py-16">
        <div className="relative group">
          <div className="absolute inset-0 bg-gradient-to-br from-holy/30 to-transparent rounded-3xl blur-xl group-hover:blur-2xl transition duration-700" />
          <Card className="relative bg-black/30 backdrop-blur-xl border border-holy/40 rounded-3xl shadow-2xl p-10 hover:scale-105 transition-all duration-500">
            <CardHeader className="text-center">
              <CardTitle className="text-4xl font-bold text-holy mb-8">
                Iniciar Sesión
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleLogin} className="space-y-8">
                <div>
                  <Label htmlFor="email" className="text-gray-200">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="bg-black/40 border-borderSubtle text-white mt-2"
                  />
                </div>
                <div>
                  <Label htmlFor="password" className="text-gray-200">Contraseña</Label>
                  <Input
                    id="password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="bg-black/40 border-borderSubtle text-white mt-2"
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full bg-gradient-to-r from-holy to-purple-600 text-black text-3xl py-8 font-bold rounded-full shadow-lg hover:shadow-holy/50 hover:scale-105 transition duration-300"
                  disabled={loading}
                >
                  {loading ? 'Iniciando...' : 'INICIAR SESIÓN'}
                </Button>
              </form>
              <div className="mt-8 text-center text-gray-300">
                <p>
                  ¿No tienes cuenta?{' '}
                  <Button asChild variant="link" className="text-holy text-xl underline hover:text-holyGlow">
                    <Link to="/">Regístrate aquí</Link>
                  </Button>
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* FOOTER SIMPLE */}
      <footer className="absolute bottom-8 left-0 right-0 text-center text-gray-400 text-sm">
        Holypot Trading © 2026 – Competencias de habilidad, no gambling.
      </footer>
    </div>
  );
};

export default LoginPage;
