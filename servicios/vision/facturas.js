// servicios/vision/facturas.js
// C06 · Centro de Facturas: conecta el lector de facturas con el motor, la base de datos y el almacenamiento

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { identificarArchivo } = require('./imagen');
const { crearExtractor } = require('./extractor');
const { leerFactura } = require('./lector');
const { validarFactura, nitValido, normalizar } = require('./validacion');

const CENTRAL = 'C06 Facturas';
// Fuera de "public": las imágenes solo se entregan por una ruta que exige rol de administrador
const CARPETA_FACTURAS = path.join(__dirname, '..', '..', 'uploads', 'facturas');
const MAX_REENCOLADOS = 3;
const MINUTOS_ATASCADA = 5;

const leerJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// Convierte lo que el administrador revisó en el formato que entiende el validador
function aExtraccion(d) {
    const campo = (valor) => ({ valor: valor === '' || valor === undefined ? null : valor, confianza: 1 });
    const numero = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
    return {
        proveedor: campo(String(d.proveedor ?? '').trim()),
        nit: campo(String(d.nit ?? '').trim()),
        numero: campo(String(d.numero ?? '').trim()),
        fecha: campo(String(d.fecha ?? '').trim()),
        subtotal: campo(numero(d.subtotal)),
        iva: campo(numero(d.iva) ?? 0),
        total: campo(numero(d.total)),
        items: (Array.isArray(d.items) ? d.items : []).map(i => ({
            descripcion: String(i.descripcion ?? '').trim(), cantidad: numero(i.cantidad), valor_unitario: numero(i.valor_unitario), subtotal: numero(i.subtotal), confianza: 1
        }))
    };
}

function registrar(motor, { db, ia, extractor = crearExtractor(), carpeta = CARPETA_FACTURAS }) {
    const rutaDe = (archivo) => path.join(carpeta, path.basename(archivo));

    async function catalogo() {
        const [filas] = await db.query('SELECT id, nombre FROM productos ORDER BY nombre');
        return filas;
    }

    const cambiarEstado = (id, estado, extra = {}) => {
        const campos = Object.keys(extra);
        return db.query(
            `UPDATE facturas SET estado = ?${campos.map(c => `, ${c} = ?`).join('')} WHERE id = ?`,
            [estado, ...campos.map(c => extra[c]), id]
        );
    };

    // De una en una: el OCR consume mucha CPU y el nivel gratuito de la IA limita las peticiones por minuto
    let fila = Promise.resolve();
    const enFila = (fn) => {
        const turno = fila.then(fn, fn);
        fila = turno.catch(() => {});
        return turno;
    };

    motor.registrar({
        id: 'C06.procesar-factura', central: CENTRAL, flujo: 'Leer factura con IA', evento: 'factura.subida',
        ejecutar: ({ factura_id }, ctx) => enFila(async () => {
            const [[f]] = await db.query('SELECT * FROM facturas WHERE id = ?', [factura_id]);
            if (!f) return { omitido_por: 'La factura ya no existe' };

            try {
                const archivo = await fs.readFile(rutaDe(f.archivo));
                const resultado = await leerFactura({
                    archivo,
                    tipo: f.tipo_mime,
                    catalogo: await catalogo(),
                    extractor,
                    auditar: ia.auditar,
                    usuarioId: f.subido_por,
                    entrada: `factura #${f.id}`,
                    alPaso: (nombre, fn) => pasoSinGuardar(ctx, nombre, fn)
                });

                const anon = resultado.anon;
                if (anon.imagen) {
                    const nombre = `${path.parse(f.archivo).name}-anonimizada.jpg`;
                    await fs.writeFile(rutaDe(nombre), anon.imagen);
                    await db.query('UPDATE facturas SET archivo_anonimizado = ?, zonas_tapadas = ? WHERE id = ?', [nombre, anon.zonas.length, f.id]);
                }

                if (resultado.estado === 'no_legible') {
                    await cambiarEstado(f.id, 'no_legible', { motivo: resultado.motivo });
                    return { factura: f.id, estado: 'no_legible', motivo: resultado.motivo };
                }

                const v = resultado.validacion;
                await cambiarEstado(f.id, resultado.estado, {
                    datos_ia: JSON.stringify(v),
                    confianza: v.confianza_global,
                    modelo: `${resultado.lectura.proveedor}/${resultado.lectura.modelo} (${resultado.lectura.modo})`,
                    motivo: null
                });
                await ia.auditar({
                    funcion: 'vision_decision', usuarioId: f.subido_por, proveedor: resultado.lectura.proveedor, modelo: resultado.lectura.modelo,
                    entrada: `factura #${f.id}, ${anon.zonas.length} zonas tapadas`,
                    resultado: `${resultado.estado}: ${v.alertas.join(' ') || 'sin alertas'}`,
                    confianza: v.confianza_global, exito: true, duracion: 0
                });
                return { factura: f.id, estado: resultado.estado, confianza: v.confianza_global, zonas_tapadas: anon.zonas.length, alertas: v.alertas.length };
            } catch (error) {
                // Sin modelos disponibles: el motor la reintenta más tarde desde la cola
                const agotada = (ctx.reencolados || 0) >= MAX_REENCOLADOS;
                await cambiarEstado(f.id, agotada ? 'error' : 'reintentando', {
                    motivo: agotada ? 'No se pudo leer tras varios intentos. Pulsa "Reintentar".' : 'La IA no está disponible: se reintentará sola en unos minutos.'
                });
                throw error;
            }
        })
    });

    // Las imágenes no se guardan como resultado del paso (la cola de reintentos solo guarda JSON)
    async function pasoSinGuardar(ctx, nombre, fn) {
        let valor;
        await ctx.paso(nombre, async () => {
            valor = await fn();
            return { ok: true };
        }, { intentos: 1, repetirSiempre: true });
        return valor;
    }

    return {
        carpeta,
        rutaDe,

        // Guarda el archivo, registra quién lo subió y dispara la lectura. Devuelve { id } o { error, status }.
        async subir({ buffer, nombreOriginal, usuarioId, origen }) {
            const info = identificarArchivo(buffer);
            if (info.error) return { error: info.error, status: 400 };

            const hash = crypto.createHash('sha256').update(buffer).digest('hex');
            const [repetidas] = await db.query(
                `SELECT id FROM facturas WHERE hash_sha256 = ? AND estado NOT IN ('rechazada', 'no_legible', 'error')`, [hash]
            );
            if (repetidas.length) return { error: `Esta imagen ya se subió (factura #${repetidas[0].id}).`, status: 409, id: repetidas[0].id };

            await fs.mkdir(carpeta, { recursive: true });
            const archivo = `${crypto.randomUUID()}.${info.extension}`;
            await fs.writeFile(rutaDe(archivo), buffer);
            const [r] = await db.query(
                `INSERT INTO facturas (archivo, nombre_original, tipo_mime, tamano, hash_sha256, origen, subido_por)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [archivo, String(nombreOriginal || '').slice(0, 200), info.tipo, buffer.length, hash, origen === 'celular' ? 'celular' : 'web', usuarioId]
            );
            motor.emitir('factura.subida', { factura_id: r.insertId });
            return { id: r.insertId };
        },

        reprocesar(id) {
            motor.emitir('factura.subida', { factura_id: id });
        },

        // Tras un reinicio, las que quedaron a medias se vuelven a leer
        async recuperarAtascadas() {
            const [filas] = await db.query(
                `SELECT id FROM facturas WHERE estado = 'procesando' AND subido_en < NOW() - INTERVAL ? MINUTE`, [MINUTOS_ATASCADA]
            );
            filas.forEach(f => motor.emitir('factura.subida', { factura_id: f.id }));
        },

        // El administrador confirma, con sus correcciones. Las reglas se aplican otra vez en el servidor.
        async confirmar(id, datos, usuarioId, { forzar = false } = {}) {
            const [[f]] = await db.query('SELECT * FROM facturas WHERE id = ?', [id]);
            if (!f) return { error: 'Factura no encontrada', status: 404 };
            if (!['lista', 'por_revisar'].includes(f.estado)) return { error: `Esta factura está en estado "${f.estado}" y no se puede confirmar.`, status: 409 };

            const v = validarFactura(aExtraccion(datos), await catalogo());
            const d = v.datos;
            const faltan = [['proveedor', 'el proveedor'], ['numero', 'el número'], ['fecha', 'la fecha'], ['total', 'el total']].filter(([c]) => d[c] === null).map(([, n]) => n);
            if (faltan.length) return { error: `Falta ${faltan.join(', ')}.`, status: 422 };
            if (d.items.length === 0) return { error: 'La factura debe tener al menos un producto.', status: 422 };
            if (d.nit && !nitValido(d.nit) && !forzar) return { error: 'El NIT no es válido: el dígito de verificación no coincide.', status: 422, confirmable: true };
            if (!v.totales_ok && !forzar) return { error: 'Los totales no cuadran con los productos.', status: 422, confirmable: true };

            const [duplicadas] = await db.query(
                `SELECT id, proveedor FROM facturas WHERE estado = 'confirmada' AND numero_factura = ? AND id <> ?`, [d.numero, id]
            );
            const repetida = duplicadas.find(x => normalizar(x.proveedor) === normalizar(d.proveedor));
            if (repetida) return { error: `Esta factura ya se confirmó antes (factura #${repetida.id}).`, status: 409 };

            const original = leerJson(f.datos_ia)?.datos;
            const corregida = JSON.stringify(sinExtras(original)) !== JSON.stringify(sinExtras(d));

            // Solo si sigue sin confirmar: dos clics no generan dos registros
            const [r] = await db.query(
                `UPDATE facturas
                 SET estado = 'confirmada', datos_finales = ?, proveedor = ?, nit = ?, numero_factura = ?, fecha_factura = ?, total = ?,
                     corregida = ?, revisado_por = ?, revisado_en = NOW(), motivo = NULL
                 WHERE id = ? AND estado IN ('lista', 'por_revisar')`,
                [JSON.stringify(v), d.proveedor, d.nit, d.numero, d.fecha, d.total, corregida ? 1 : 0, usuarioId, id]
            );
            if (r.affectedRows === 0) return { error: 'Esta factura ya se confirmó.', status: 409 };

            await ia.auditar({
                funcion: 'vision_confirmacion', usuarioId, proveedor: 'humano', modelo: f.modelo || '-',
                entrada: `factura #${id}`, resultado: corregida ? 'Confirmada con correcciones del administrador' : 'Confirmada sin cambios',
                confianza: f.confianza, exito: true, duracion: 0
            });
            motor.emitir('factura.confirmada', { factura_id: id });
            return { ok: true, corregida };
        },

        // Rechazar borra las imágenes: no se guardan datos que ya no sirven
        async rechazar(id, usuarioId, motivo) {
            const [[f]] = await db.query('SELECT * FROM facturas WHERE id = ?', [id]);
            if (!f) return { error: 'Factura no encontrada', status: 404 };
            if (f.estado === 'confirmada') return { error: 'Una factura confirmada no se puede rechazar.', status: 409 };
            await cambiarEstado(id, 'rechazada', { motivo: String(motivo || 'Rechazada por el administrador').slice(0, 250), revisado_por: usuarioId, revisado_en: new Date(), archivo_anonimizado: null });
            await Promise.allSettled([fs.unlink(rutaDe(f.archivo)), ...(f.archivo_anonimizado ? [fs.unlink(rutaDe(f.archivo_anonimizado))] : [])]);
            return { ok: true };
        }
    };
}

// Para comparar lo que leyó la IA con lo confirmado, sin los datos calculados
function sinExtras(d) {
    if (!d) return null;
    return {
        proveedor: d.proveedor ?? null, nit: d.nit ?? null, numero: d.numero ?? null, fecha: d.fecha ?? null,
        subtotal: d.subtotal ?? null, iva: d.iva ?? 0, total: d.total ?? null,
        items: (d.items || []).map(i => [i.descripcion, i.cantidad, i.valor_unitario, i.subtotal])
    };
}

module.exports = { registrar, aExtraccion, sinExtras, CARPETA_FACTURAS };
