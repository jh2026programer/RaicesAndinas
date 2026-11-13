// servicios/vision/rutas.js
// Rutas del módulo de facturas. Todas exigen la sesión de un administrador.

const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const { TAMANO_MAXIMO } = require('./imagen');

const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: TAMANO_MAXIMO, files: 1 } }).single('factura');

const leerJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

function registrarRutas(app, facturas, { db, requiereAdmin }) {
    // Se necesita saber QUIÉN sube y revisa: la API key de integraciones no sirve aquí
    const requiereSesionAdmin = (req, res, next) => requiereAdmin(req, res, () => {
        if (!req.sesion) return res.status(403).json({ error: 'Esta acción requiere iniciar sesión como administrador.' });
        next();
    });

    app.post('/api/admin/facturas', requiereSesionAdmin, (req, res) => {
        subida(req, res, async (errorSubida) => {
            try {
                if (errorSubida) {
                    const mensaje = errorSubida.code === 'LIMIT_FILE_SIZE' ? 'El archivo pesa más de 10 MB.' : 'No se pudo recibir el archivo.';
                    return res.status(400).json({ error: mensaje });
                }
                if (!req.file) return res.status(400).json({ error: 'Selecciona una foto o un PDF.' });
                const r = await facturas.subir({
                    buffer: req.file.buffer,
                    nombreOriginal: req.file.originalname,
                    usuarioId: req.sesion.id,
                    origen: req.body.origen
                });
                if (r.error) return res.status(r.status).json({ error: r.error, id: r.id });
                res.status(202).json({ success: true, id: r.id });
            } catch (error) {
                console.error('Error al subir factura:', error);
                res.status(500).json({ error: 'Error al guardar la factura' });
            }
        });
    });

    app.get('/api/admin/facturas', requiereSesionAdmin, async (req, res) => {
        try {
            const [filas] = await db.query(
                `SELECT f.id, f.estado, f.motivo, f.confianza, f.modelo, f.origen, f.nombre_original, f.subido_en, f.proveedor, f.numero_factura, f.total,
                        f.zonas_tapadas, f.corregida, f.revisado_por, f.datos_ia, u.nombres as subido_por_nombre
                 FROM facturas f LEFT JOIN usuarios u ON f.subido_por = u.id
                 ORDER BY f.id DESC LIMIT 100`
            );
            res.json(filas.map(({ datos_ia, ...f }) => {
                const d = datos_ia ? leerJson(datos_ia).datos : null;
                return { ...f, proveedor: f.proveedor || d?.proveedor || null, numero_factura: f.numero_factura || d?.numero || null, total: f.total ?? d?.total ?? null };
            }));
        } catch (error) {
            console.error('Error al listar facturas:', error);
            res.status(500).json({ error: 'Error al consultar las facturas' });
        }
    });

    app.get('/api/admin/compras-registradas', requiereSesionAdmin, async (req, res) => {
        try {
            const [filas] = await db.query(
                `SELECT c.id, c.factura_id, c.proveedor, c.numero_factura, c.fecha_factura, c.total, c.registrada_en,
                        COUNT(d.id) as lineas, COALESCE(SUM(d.cantidad), 0) as unidades
                 FROM compras c LEFT JOIN compras_detalle d ON d.compra_id = c.id
                 GROUP BY c.id, c.factura_id, c.proveedor, c.numero_factura, c.fecha_factura, c.total, c.registrada_en
                 ORDER BY c.id DESC LIMIT 50`
            );
            res.json(filas.map(f => ({ ...f, total: parseFloat(f.total), unidades: Number(f.unidades) })));
        } catch (error) {
            console.error('Error al listar compras:', error);
            res.status(500).json({ error: 'Error al consultar las compras' });
        }
    });

    app.get('/api/admin/facturas/:id', requiereSesionAdmin, async (req, res) => {
        try {
            const [[f]] = await db.query(
                `SELECT f.*, u.nombres as subido_por_nombre, u.apellidos as subido_por_apellidos
                 FROM facturas f LEFT JOIN usuarios u ON f.subido_por = u.id WHERE f.id = ?`, [req.params.id]
            );
            if (!f) return res.status(404).json({ error: 'Factura no encontrada' });
            const [productos] = await db.query('SELECT id, nombre FROM productos ORDER BY nombre');
            const { archivo, archivo_anonimizado, hash_sha256, datos_ia, datos_finales, ...publico } = f;
            const [[compra]] = await db.query('SELECT id, registrada_en FROM compras WHERE factura_id = ?', [f.id]);
            res.json({
                ...publico,
                compra: compra || null,
                tiene_anonimizada: Boolean(archivo_anonimizado),
                es_pdf: f.tipo_mime === 'application/pdf',
                lectura: datos_finales ? leerJson(datos_finales) : (datos_ia ? leerJson(datos_ia) : null),
                lectura_ia: datos_ia ? leerJson(datos_ia) : null,
                productos
            });
        } catch (error) {
            console.error('Error al consultar factura:', error);
            res.status(500).json({ error: 'Error al consultar la factura' });
        }
    });

    // Control de acceso: las imágenes no son públicas, se entregan solo por aquí
    app.get('/api/admin/facturas/:id/imagen', requiereSesionAdmin, async (req, res) => {
        try {
            const [[f]] = await db.query('SELECT archivo, archivo_anonimizado, tipo_mime FROM facturas WHERE id = ?', [req.params.id]);
            if (!f) return res.status(404).json({ error: 'Factura no encontrada' });
            const anonimizada = req.query.version === 'anonimizada';
            const nombre = anonimizada ? f.archivo_anonimizado : f.archivo;
            if (!nombre || !fs.existsSync(facturas.rutaDe(nombre))) return res.status(404).json({ error: 'La imagen ya no está disponible' });
            res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            if (f.tipo_mime === 'application/pdf' && !anonimizada) {
                res.type('application/pdf');
                return fs.createReadStream(facturas.rutaDe(nombre)).pipe(res);
            }
            const vista = await sharp(facturas.rutaDe(nombre)).rotate().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
            res.type('image/jpeg').send(vista);
        } catch (error) {
            console.error('Error al entregar imagen:', error);
            res.status(500).json({ error: 'Error al consultar la imagen' });
        }
    });

    app.post('/api/admin/facturas/:id/reintentar', requiereSesionAdmin, async (req, res) => {
        try {
            const [r] = await db.query(
                `UPDATE facturas SET estado = 'procesando', motivo = NULL WHERE id = ? AND estado IN ('error', 'reintentando', 'no_legible')`, [req.params.id]
            );
            if (r.affectedRows === 0) return res.status(409).json({ error: 'Esta factura no se puede reintentar' });
            facturas.reprocesar(parseInt(req.params.id));
            res.json({ success: true });
        } catch (error) {
            console.error('Error al reintentar factura:', error);
            res.status(500).json({ error: 'Error al reintentar la factura' });
        }
    });

    app.post('/api/admin/facturas/:id/confirmar', requiereSesionAdmin, async (req, res) => {
        try {
            const r = await facturas.confirmar(parseInt(req.params.id), req.body.datos || {}, req.sesion.id, { forzar: req.body.forzar === true });
            if (r.error) return res.status(r.status).json({ error: r.error, confirmable: r.confirmable || false });
            res.json({ success: true, corregida: r.corregida });
        } catch (error) {
            console.error('Error al confirmar factura:', error);
            res.status(500).json({ error: 'Error al confirmar la factura' });
        }
    });

    app.post('/api/admin/facturas/:id/rechazar', requiereSesionAdmin, async (req, res) => {
        try {
            const r = await facturas.rechazar(parseInt(req.params.id), req.sesion.id, req.body.motivo);
            if (r.error) return res.status(r.status).json({ error: r.error });
            res.json({ success: true });
        } catch (error) {
            console.error('Error al rechazar factura:', error);
            res.status(500).json({ error: 'Error al rechazar la factura' });
        }
    });
}

module.exports = { registrarRutas };
