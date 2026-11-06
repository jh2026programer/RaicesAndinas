// servicios/vision/compras.js
// Integración: una factura confirmada dispara el proceso de inventario en el motor.
// Registra la compra, ajusta el stock, concilia las solicitudes de compra y avisa por Telegram.

const { pesos } = require('../automatizacion/plantillas');

const CENTRAL = 'C06 Facturas';
const DIAS_CONCILIACION = 60;

const leerJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// Calcula cuánto mover el stock sin tocar la base de datos.
// Al aprobar una solicitud el stock YA se sumó: si llega su factura, solo se ajusta la diferencia.
function calcularMovimientos(items, solicitudes) {
    const cantidades = new Map();
    for (const it of items) {
        if (it.producto_id) cantidades.set(it.producto_id, (cantidades.get(it.producto_id) || 0) + Number(it.cantidad));
    }

    const actualizadas = solicitudes.map(s => ({ ...s, productos: s.productos.map(p => ({ ...p })), tocada: false }));
    const movimientos = [];
    for (const [producto_id, cantidad] of cantidades) {
        let ya_sumado = 0;
        for (const s of actualizadas) {
            for (const p of s.productos) {
                if (p.id !== producto_id || p.facturado) continue;
                if (s.estado === 'aprobada') ya_sumado += Number(p.cantidad_sugerida);
                p.facturado = true;
                s.tocada = true;
            }
        }
        movimientos.push({ producto_id, cantidad_factura: cantidad, ya_sumado, ajuste: cantidad - ya_sumado });
    }

    const cierres = actualizadas.filter(s => s.tocada).map(s => {
        const completa = s.productos.every(p => p.facturado);
        const estado = !completa ? s.estado : (s.estado === 'aprobada' ? 'facturada' : 'cumplida');
        return { id: s.id, productos: s.productos, estado, cerrada: completa };
    });
    return { movimientos, cierres };
}

function telegramCompra({ factura_id, datos, stock, cierres, sinCatalogo }) {
    return [
        `🧾 COMPRA REGISTRADA DESDE UNA FACTURA #${factura_id}`,
        '',
        `🏢 ${datos.proveedor}`,
        `📄 ${datos.numero} · ${datos.fecha}`,
        `💰 ${pesos(datos.total)}`,
        '',
        ...stock.map(m => (m.ya_sumado > 0
            ? `📦 ${m.nombre}: factura ${m.cantidad_factura}, ya se habían sumado ${m.ya_sumado} al aprobar → ajuste ${m.ajuste >= 0 ? '+' : ''}${m.ajuste}, ahora hay ${m.stock}`
            : `📦 ${m.nombre}: +${m.ajuste} → ahora hay ${m.stock}`)),
        ...(sinCatalogo.length ? ['', `⚠️ Sin producto en el catálogo (no suman stock): ${sinCatalogo.join(', ')}`] : []),
        ...(stock.some(m => m.ajuste < 0) ? ['', '⚠️ Llegó menos de lo aprobado: revisa con el proveedor.'] : []),
        ...(cierres.length ? ['', `✅ Solicitud(es) de compra cerrada(s): ${cierres.map(c => `#${c}`).join(', ')}`] : [])
    ].join('\n');
}

function registrar(motor, { db, canales }) {
    // Todo o nada. La UNIQUE de factura_id impide registrar dos veces la misma factura,
    // aunque el motor reintente el flujo.
    async function aplicarCompra(factura_id) {
        const conexion = await db.getConnection();
        try {
            await conexion.beginTransaction();
            const [[f]] = await conexion.query('SELECT * FROM facturas WHERE id = ? FOR UPDATE', [factura_id]);
            if (!f || f.estado !== 'confirmada') throw new Error(`La factura #${factura_id} no está confirmada`);
            const { datos } = leerJson(f.datos_finales);

            const [yaExiste] = await conexion.query('SELECT id FROM compras WHERE factura_id = ?', [factura_id]);
            if (yaExiste.length) {
                await conexion.rollback();
                return { ya_registrada: true, compra: yaExiste[0].id };
            }

            const [filas] = await conexion.query(
                `SELECT id, estado, productos FROM solicitudes_compra
                 WHERE estado = 'pendiente' OR (estado = 'aprobada' AND decidido_en >= NOW() - INTERVAL ? DAY)
                 ORDER BY id FOR UPDATE`,
                [DIAS_CONCILIACION]
            );
            const { movimientos, cierres } = calcularMovimientos(datos.items, filas.map(s => ({ ...s, productos: leerJson(s.productos) })));

            const [compra] = await conexion.query(
                `INSERT INTO compras (factura_id, proveedor, nit, numero_factura, fecha_factura, subtotal, iva, total, registrada_por)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [factura_id, datos.proveedor, datos.nit, datos.numero, datos.fecha, datos.subtotal, datos.iva || 0, datos.total, f.revisado_por]
            );
            for (const it of datos.items) {
                await conexion.query(
                    `INSERT INTO compras_detalle (compra_id, producto_id, descripcion, cantidad, valor_unitario, subtotal)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [compra.insertId, it.producto_id || null, it.descripcion, it.cantidad, it.valor_unitario, it.subtotal]
                );
            }

            const stock = [];
            for (const m of movimientos) {
                await conexion.query('UPDATE productos SET stock = GREATEST(0, stock + ?) WHERE id = ?', [m.ajuste, m.producto_id]);
                const [[p]] = await conexion.query('SELECT nombre, stock FROM productos WHERE id = ?', [m.producto_id]);
                stock.push({ ...m, nombre: p.nombre, stock: p.stock });
            }

            for (const c of cierres) {
                await conexion.query(
                    `UPDATE solicitudes_compra SET productos = ?, estado = ?, decidido_por = IF(? , ?, decidido_por), decidido_en = IF(?, NOW(), decidido_en) WHERE id = ?`,
                    [JSON.stringify(c.productos), c.estado, c.cerrada, `factura #${factura_id}`, c.cerrada, c.id]
                );
            }

            await conexion.commit();
            return {
                compra: compra.insertId,
                stock,
                cierres: cierres.filter(c => c.cerrada).map(c => c.id),
                sinCatalogo: datos.items.filter(i => !i.producto_id).map(i => i.descripcion),
                datos: { proveedor: datos.proveedor, numero: datos.numero, fecha: datos.fecha, total: datos.total }
            };
        } catch (error) {
            await conexion.rollback();
            throw error;
        } finally {
            conexion.release();
        }
    }

    motor.registrar({
        id: 'C06.factura-confirmada', central: CENTRAL, flujo: 'Factura confirmada: compra y stock', evento: 'factura.confirmada',
        async ejecutar({ factura_id }, ctx) {
            const r = await ctx.paso('Registrar compra y ajustar stock', () => aplicarCompra(factura_id));
            if (r.ya_registrada) return { factura: factura_id, compra: r.compra, repetida: true };
            await ctx.paso('Telegram: compra registrada', () => canales.telegram(telegramCompra({ factura_id, ...r })));
            return {
                factura: factura_id, compra: r.compra,
                ajustes: r.stock.map(m => ({ producto: m.nombre, ajuste: m.ajuste, stock: m.stock })),
                solicitudes_cerradas: r.cierres
            };
        }
    });
}

module.exports = { registrar, calcularMovimientos, telegramCompra };
