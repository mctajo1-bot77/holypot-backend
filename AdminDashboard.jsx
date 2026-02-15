import React, { useState, useEffect } from 'react';
import apiClient from '@/api'; // Path correcto
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { io } from "socket.io-client";
import background from "@/assets/background.jpg";

// Socket dinámico
const socket = io(import.meta.env.VITE_API_URL || 'http://localhost:5000', {
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  timeout: 10000
});

const formatNumber = (num) => {
  return new Intl.NumberFormat('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(num || 0);
};

const AdminDashboard = () => {
  const [data, setData] = useState(null);
  const [payouts, setPayouts] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const fetchData = async () => {
    try {
      const res = await apiClient.get('/admin/data');
      setData(res.data || { overview: { inscripcionesTotal: 0, participantesActivos: 0, revenuePlataforma: 0, prizePoolTotal: 0 }, competencias: {}, usuarios: [] });
      try {
        const payoutsRes = await apiClient.get('/admin/payouts');
        setPayouts(payoutsRes.data || []);
      } catch (payoutErr) {
        console.warn('Payouts endpoint no disponible – usando []');
        setPayouts([]);
      }
      setLoading(false);
    } catch (err) {
      setLoading(false);
      alert('Error cargando datos admin – sesión expirada');
      navigate('/admin-login');
    }
  };

  useEffect(() => {
    fetchData();
    socket.on('liveUpdate', fetchData);
    return () => socket.off('liveUpdate');
  }, [navigate]);

  // ✅ FIX: Obtener token de usuario real del backend antes de abrir el dashboard
  const viewAsUser = async (entryId) => {
    try {
      const res = await apiClient.post('/admin/generate-user-token', { entryId });

      // Preservar el token admin en holypotAdminToken antes de sobreescribir holypotToken
      const adminToken = localStorage.getItem('holypotToken') || localStorage.getItem('holypotAdminToken');
      if (adminToken) {
        localStorage.setItem('holypotAdminToken', adminToken);
      }

      // Establecer el token del usuario y su entryId para el dashboard
      localStorage.setItem('holypotToken', res.data.token);
      localStorage.setItem('holypotEntryId', res.data.entryId);

      // Abrir dashboard en nueva pestaña
      window.open('/dashboard', '_blank');
    } catch (err) {
      alert('Error al ver como usuario: ' + (err.response?.data?.error || err.message));
    }
  };

  const exportCSV = (level) => {
    const csv = data?.competencias?.[level]?.top3CSV || '';
    const blob = new Blob([`Wallet,Amount USDT\n${csv}`], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `holypot_${level}_pagos.csv`;
    a.click();
  };

  if (loading) return <p className="text-center text-3xl mt-40 text-gray-200">Cargando panel admin...</p>;
  if (!data) return <p className="text-center text-3xl mt-40 text-gray-200">Sin datos disponibles – sesión expirada o error de conexión</p>;

  return (
    <div className="min-h-screen text-white relative overflow-hidden">
      {/* FONDO ESPACIO + OVERLAY */}
      <div className="fixed inset-0 -z-10">
        <img src={background} alt="Fondo" className="w-full h-full object-cover" />
        <div className="absolute inset-0 bg-black/60" />
      </div>

      {/* HEADER GLASS AZUL SUTIL */}
      <header className="relative bg-primary/65 backdrop-blur-md border-b border-holy/20 shadow-md py-8">
        <div className="max-w-7xl mx-auto px-6 text-center">
          <h1 className="text-5xl font-bold text-holy">Panel Admin Holypot 🚀</h1>
          <Button
            onClick={() => navigate('/admin-login')}
            className="mt-6 bg-gradient-to-r from-holy to-purple-600 text-black text-xl px-8 py-4 font-bold rounded-full hover:scale-105 transition"
          >
            Logout
          </Button>
        </div>
      </header>

      {/* OVERVIEW LIVE GLASS */}
      <div className="max-w-7xl mx-auto px-8 py-16">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-12 mb-16">
          <div className="relative group">
            <div className="absolute inset-0 bg-gradient-to-br from-holy/30 to-transparent rounded-3xl blur-xl group-hover:blur-2xl transition" />
            <Card className="relative bg-black/30 backdrop-blur-xl border border-holy/40 rounded-3xl shadow-2xl p-8 text-center hover:scale-105 transition-all duration-500">
              <CardTitle className="text-2xl mb-4 text-gray-200">Inscripciones totales</CardTitle>
              <p className="text-5xl font-bold text-holy">{data.overview?.inscripcionesTotal ?? 0}</p>
            </Card>
          </div>
          <div className="relative group">
            <div className="absolute inset-0 bg-gradient-to-br from-profit/30 to-transparent rounded-3xl blur-xl group-hover:blur-2xl transition" />
            <Card className="relative bg-black/30 backdrop-blur-xl border border-profit/40 rounded-3xl shadow-2xl p-8 text-center hover:scale-105 transition-all duration-500">
              <CardTitle className="text-2xl mb-4 text-gray-200">Revenue plataforma</CardTitle>
              <p className="text-5xl font-bold text-profit">{formatNumber(data.overview?.revenuePlataforma ?? 0)} USDT</p>
            </Card>
          </div>
          <div className="relative group">
            <div className="absolute inset-0 bg-gradient-to-br from-blue-500/30 to-transparent rounded-3xl blur-xl group-hover:blur-2xl transition" />
            <Card className="relative bg-black/30 backdrop-blur-xl border border-blue-500/40 rounded-3xl shadow-2xl p-8 text-center hover:scale-105 transition-all duration-500">
              <CardTitle className="text-2xl mb-4 text-gray-200">Prize pool total</CardTitle>
              <p className="text-5xl font-bold text-holy">{formatNumber(data.overview?.prizePoolTotal ?? 0)} USDT</p>
            </Card>
          </div>
        </div>

        {/* TABS COMPETENCIAS / USUARIOS / PAYOUTS */}
        <Tabs defaultValue="competencias" className="max-w-7xl mx-auto">
          <TabsList className="grid w-full grid-cols-3 mb-8 bg-black/40 backdrop-blur-md border border-holy/20 rounded-xl">
            <TabsTrigger value="competencias" className="text-xl py-4 text-white">Competencias</TabsTrigger>
            <TabsTrigger value="usuarios" className="text-xl py-4 text-white">Usuarios</TabsTrigger>
            <TabsTrigger value="payouts" className="text-xl py-4 text-white">Payouts</TabsTrigger>
          </TabsList>

          <TabsContent value="competencias">
            {Object.keys(data.competencias || {}).map(level => (
              <div key={level} className="relative group mb-16">
                <div className="absolute inset-0 bg-gradient-to-br from-holy/20 to-transparent rounded-3xl blur-xl group-hover:blur-2xl transition" />
                <Card className="relative bg-black/30 backdrop-blur-xl border border-holy/40 rounded-3xl shadow-2xl p-10 hover:scale-103 transition-all duration-500">
                  <CardHeader>
                    <CardTitle className="text-3xl text-holy">
                      {level.toUpperCase()} – {data.competencias[level]?.participantes ?? 0} participantes – Prize pool: {formatNumber(data.competencias[level]?.prizePool ?? 0)} USDT
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader className="bg-black/40">
                          <TableRow>
                            <TableHead className="text-holy">Pos</TableHead>
                            <TableHead className="text-holy">Trader</TableHead>
                            <TableHead className="text-holy">Wallet</TableHead>
                            <TableHead className="text-holy">Retorno %</TableHead>
                            <TableHead className="text-holy">Capital Live</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(data.competencias[level]?.ranking || []).map((r, i) => (
                            <TableRow key={i} className="hover:bg-white/10 transition">
                              <TableCell className="font-bold text-gray-200">#{i + 1}</TableCell>
                              <TableCell className="text-gray-200">{r.displayName || 'Anónimo'}</TableCell>
                              <TableCell className="font-mono text-sm text-gray-300">{r.wallet || ''}</TableCell>
                              <TableCell className="text-gray-200">{r.retorno || '0%'}</TableCell>
                              <TableCell className="text-gray-200">{formatNumber(r.liveCapital || 0)} USDT</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    <Button
                      onClick={() => exportCSV(level)}
                      className="mt-8 bg-gradient-to-r from-holy to-green-600 text-black text-xl px-8 py-5 font-bold rounded-full shadow-lg hover:scale-105 transition"
                    >
                      Exportar CSV pagos top 3
                    </Button>
                  </CardContent>
                </Card>
              </div>
            ))}
          </TabsContent>

          <TabsContent value="usuarios">
            <div className="relative group">
              <div className="absolute inset-0 bg-gradient-to-br from-holy/20 to-transparent rounded-3xl blur-xl group-hover:blur-2xl transition" />
              <Card className="relative bg-black/30 backdrop-blur-xl border border-holy/40 rounded-3xl shadow-2xl p-10">
                <CardHeader>
                  <CardTitle className="text-3xl text-holy">Lista completa de usuarios (capital live)</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader className="bg-black/40">
                        <TableRow>
                          <TableHead className="text-holy">Trader</TableHead>
                          <TableHead className="text-holy">Wallet</TableHead>
                          <TableHead className="text-holy">Level</TableHead>
                          <TableHead className="text-holy">Status</TableHead>
                          <TableHead className="text-holy">Capital Live</TableHead>
                          <TableHead className="text-holy">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(data.usuarios || []).map(u => (
                          <TableRow key={u.id} className="hover:bg-white/10 transition">
                            <TableCell className="text-gray-200">{u.displayName || 'Anónimo'}</TableCell>
                            <TableCell className="font-mono text-sm text-gray-300">{u.wallet || ''}</TableCell>
                            <TableCell className="text-gray-200">{u.level?.toUpperCase() || ''}</TableCell>
                            <TableCell className="text-gray-200">{u.status || ''}</TableCell>
                            <TableCell className="text-gray-200">{formatNumber(u.virtualCapital || 0)} USDT</TableCell>
                            <TableCell>
                              <Button
                                onClick={() => viewAsUser(u.id)}
                                className="bg-gradient-to-r from-holy to-blue-600 text-black px-6 py-3 font-bold rounded-full hover:scale-105 transition"
                              >
                                Ver como usuario
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="payouts">
            <div className="relative group">
              <div className="absolute inset-0 bg-gradient-to-br from-holy/20 to-transparent rounded-3xl blur-xl group-hover:blur-2xl transition" />
              <Card className="relative bg-black/30 backdrop-blur-xl border border-holy/40 rounded-3xl shadow-2xl p-10">
                <CardHeader>
                  <CardTitle className="text-3xl text-holy text-center">Historial Payouts (premios pagados)</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader className="bg-black/40">
                        <TableRow>
                          <TableHead className="text-holy">Fecha</TableHead>
                          <TableHead className="text-holy">Trader</TableHead>
                          <TableHead className="text-holy">Level</TableHead>
                          <TableHead className="text-holy">Posición</TableHead>
                          <TableHead className="text-holy">Premio</TableHead>
                          <TableHead className="text-holy">Status</TableHead>
                          <TableHead className="text-holy">Payment ID</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {payouts.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={7} className="text-center py-8 text-gray-400">
                              No hay payouts aún – ¡espera primeras competencias!
                            </TableCell>
                          </TableRow>
                        ) : (
                          payouts.map((p) => (
                            <TableRow key={p.id} className="hover:bg-white/10 transition">
                              <TableCell className="text-gray-200">{new Date(p.date).toLocaleDateString('es-ES')}</TableCell>
                              <TableCell className="text-gray-200">{p.user?.nickname || 'Anónimo'}</TableCell>
                              <TableCell className="text-gray-200">{p.level?.toUpperCase() || ''}</TableCell>
                              <TableCell className="text-gray-200">#{p.position || 0}</TableCell>
                              <TableCell className="text-profit font-bold">{formatNumber(p.amount || 0)} USDT</TableCell>
                              <TableCell>
                                <Badge variant={p.status === 'confirmed' ? "default" : "secondary"} className={p.status === 'confirmed' ? "bg-profit text-black" : "bg-gray-600 text-white"}>
                                  {p.status === 'confirmed' ? 'Confirmado' : 'Pending'}
                                </Badge>
                              </TableCell>
                              <TableCell className="font-mono text-sm text-gray-300">{p.paymentId || '-'}</TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
};

export default AdminDashboard;
