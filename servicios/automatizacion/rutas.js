// servicios/automatizacion/rutas.js
// Rutas del motor: aprobación de compras por enlace firmado y consultas del panel admin

const express = require('express');
const { esc, paginaSimple } = require('./plantillas');

const leerEntero = (valor, porDefecto, maximo) => Math.min(maximo, Math.max(1, parseInt(valor) || porDefecto));

function registrarRutas(app, auto, { db, requiereAdmin }) {
    const { compras, motor } = auto;

    // ---------- Aprobación del dueño desde el correo ----------
    // El enlace (GET) solo muestra la confirmación; la decisión exige pulsar el botón (POST).
    // Así el antivirus del correo, que abre los enlaces solo, no puede aprobar una compra.
    app.get('/api/compras/:id/decision', async (req, res) => {
        res.type('html');
        try {
            const id = parseInt(req.params.id);
            const { token } = req.query;
            const decision = req.query.decision === 'rechazar' ? 'rechazar' : 'aprobar';
            if (!(id > 0) || !compras.tokenValido(id, token)) {
                return res.status(403).send(paginaSimple('Enlace no válido', 'Este enlace no es válido o fue modificado.', '🔒'));
            }
            const s = await compras.obtenerSolicitud(id);
            if (!s) return res.status(404).send(paginaSimple('Solicitud no encontrada', 'Esta solicitud ya no existe.', '🔍'));
            if (s.estado !== 'pendiente') {
                return res.send(paginaSimple('Solicitud ya resuelta', `Esta solicitud quedó ${s.estado}. No hay nada más que hacer.`, 'ℹ️'));
            }
            const aprobar = decision === 'aprobar';
            const formulario = `<ul style="text-align:left;color:#555;">${s.productos.map(p => `<li>${p.cantidad_sugerida} x ${esc(p.nombre)}</li>`).join('')}</ul>
                <form method="post" action="/api/compras/${id}/decision">
                  <input type="hidden" name="token" value="${esc(token)}">
                  <input type="hidden" name="decision" value="${decision}">
                  <button style="border:0;cursor:pointer;background:${aprobar ? '#2f855a' : '#c0392b'};color:#fff;padding:14px 26px;border-radius:999px;font-size:16px;font-weight:bold;">${aprobar ? '✅ Confirmar compra' : '❌ Confirmar rechazo'}</button>
                </form>`;
            res.send(paginaSimple(aprobar ? '¿Aprobar esta compra?' : '¿Rechazar esta compra?', 'Revisa los productos y confirma tu decisión.', '📦', formulario));
        } catch (error) {
            console.error('Error en decisión de compra:', error);
            res.status(500).send(paginaSimple('Algo salió mal', 'Inténtalo de nuevo en unos minutos.', '⚠️'));
        }
    });

    app.post('/api/compras/:id/decision', express.urlencoded({ extended: false }), async (req, res) => {
        res.type('html');
        try {
            const id = parseInt(req.params.id);
            const { token, decision } = req.body;
            if (!(id > 0) || !compras.tokenValido(id, token) || !['aprobar', 'rechazar'].includes(decision)) {
                return res.status(403).send(paginaSimple('Enlace no válido', 'Este enlace no es válido o fue modificado.', '🔒'));
            }
            if (!await compras.aplicarDecision(id, decision, 'enlace del correo')) {
                return res.send(paginaSimple('Solicitud ya resuelta', 'Esta solicitud ya tenía una decisión. No se hizo ningún cambio.', 'ℹ️'));
            }
            res.send(decision === 'aprobar'
                ? paginaSimple('Compra aprobada', 'El inventario se está actualizando y la orden de compra se enviará al proveedor.', '✅')
                : paginaSimple('Compra rechazada', 'No se hará ningún pedido al proveedor. Puedes reabastecer manualmente desde el panel admin.', '❌'));
        } catch (error) {
            console.error('Error en decisión de compra:', error);
            res.status(500).send(paginaSimple('Algo salió mal', 'Inténtalo de nuevo en unos minutos.', '⚠️'));
        }
    });

    // ---------- Panel admin ----------
    app.get('/api/admin/automatizaciones/estado', requiereAdmin, async (req, res) => {
        try {
            const [[ultimas]] = await db.query(
                `SELECT COUNT(*) as total,
                        COALESCE(SUM(estado = 'exito'), 0) as exito,
                        COALESCE(SUM(estado = 'parcial'), 0) as parcial,
                        COALESCE(SUM(estado = 'error'), 0) as error
                 FROM automatizacion_ejecuciones WHERE inicio >= NOW() - INTERVAL 24 HOUR`
            );
            const [[cola]] = await db.query(`SELECT COUNT(*) as total FROM automatizacion_tareas WHERE estado = 'pendiente'`);
            res.json({
                canales: auto.canales.estado(),
                ia: auto.ia.estado(),
                flujos: motor.catalogo(),
                ultimas_24h: { total: ultimas.total, exito: Number(ultimas.exito), parcial: Number(ultimas.parcial), error: Number(ultimas.error) },
                tareas_pendientes: cola.total
            });
        } catch (error) {
            console.error('Error en estado del motor:', error);
            res.status(500).json({ error: 'Error al consultar el motor' });
        }
    });

    app.get('/api/admin/automatizaciones/ejecuciones', requiereAdmin, async (req, res) => {
        try {
            const condiciones = [];
            const valores = [];
            if (['en_curso', 'exito', 'parcial', 'error'].includes(req.query.estado)) {
                condiciones.push('estado = ?');
                valores.push(req.query.estado);
            }
            if (req.query.central) {
                condiciones.push('central = ?');
                valores.push(String(req.query.central));
            }
            const donde = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
            const [filas] = await db.query(
                `SELECT * FROM automatizacion_ejecuciones ${donde} ORDER BY id DESC LIMIT ?`,
                [...valores, leerEntero(req.query.limite, 50, 200)]
            );
            res.json(filas);
        } catch (error) {
            console.error('Error en bitácora:', error);
            res.status(500).json({ error: 'Error al consultar la bitácora' });
        }
    });

    // "Ejecutar ahora": permite probar un reporte programado sin esperar a su hora
    app.post('/api/admin/automatizaciones/ejecutar', requiereAdmin, async (req, res) => {
        try {
            const flujo = motor.catalogo().find(f => f.id === req.body.flujo && f.cron);
            if (!flujo) return res.status(400).json({ error: 'Ese flujo no se puede ejecutar manualmente' });
            const r = await motor.ejecutarPorId(flujo.id, {}, `manual:admin${req.sesion ? `#${req.sesion.id}` : ''}`);
            res.json({ success: r.ok, bitacora_id: r.bitacoraId, resultado: r.resultado ?? null, error: r.ok ? null : r.error.message });
        } catch (error) {
            console.error('Error al ejecutar flujo:', error);
            res.status(500).json({ error: 'Error al ejecutar el flujo' });
        }
    });

    app.get('/api/admin/compras', requiereAdmin, async (req, res) => {
        try {
            const [filas] = await db.query(
                `SELECT id, productos, total_estimado, estado, creado, expira, decidido_por, decidido_en
                 FROM solicitudes_compra ORDER BY id DESC LIMIT 30`
            );
            res.json(filas.map(f => ({ ...f, productos: typeof f.productos === 'string' ? JSON.parse(f.productos) : f.productos, total_estimado: parseFloat(f.total_estimado) })));
        } catch (error) {
            console.error('Error en compras:', error);
            res.status(500).json({ error: 'Error al consultar las compras' });
        }
    });

    app.post('/api/admin/compras/:id/decision', requiereAdmin, async (req, res) => {
        try {
            if (!['aprobar', 'rechazar'].includes(req.body.decision)) return res.status(400).json({ error: 'Decisión inválida' });
            const quien = req.sesion ? `admin #${req.sesion.id}` : 'api';
            const aplicada = await compras.aplicarDecision(parseInt(req.params.id), req.body.decision, quien);
            if (!aplicada) return res.status(409).json({ error: 'Esta solicitud ya tenía una decisión' });
            res.json({ success: true });
        } catch (error) {
            console.error('Error en decisión de compra:', error);
            res.status(500).json({ error: 'Error al registrar la decisión' });
        }
    });

    app.get('/api/admin/ia/auditoria', requiereAdmin, async (req, res) => {
        try {
            const [filas] = await db.query('SELECT * FROM ia_auditoria ORDER BY id DESC LIMIT ?', [leerEntero(req.query.limite, 50, 200)]);
            res.json(filas);
        } catch (error) {
            console.error('Error en auditoría de IA:', error);
            res.status(500).json({ error: 'Error al consultar la auditoría' });
        }
    });
}

module.exports = { registrarRutas };
