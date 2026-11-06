// servicios/automatizacion/inventario.js
// C02 · Centro de Inventario: analiza ventas, redacta la orden con IA y espera la aprobación del dueño

const crypto = require('crypto');
const consultas = require('../consultas');
const { pesos, esc, tiendaUrl, plantillaCorreo, textoIAaHtml } = require('./plantillas');

const CENTRAL = 'C02 Inventario';
const HORAS_APROBACION = 24;

// Calcula cuánto comprar: cubrir 3 semanas de demanda + el stock mínimo
function cantidadSugerida(p) {
    const dias = p.dias || 30;
    const demandaDiaria = p.unidades / dias;
    const objetivo = Math.ceil(demandaDiaria * 21) + p.stock_minimo;
    const sugerido = Math.max(objetivo - p.stock, p.stock_minimo * 2, 5);
    return {
        id: p.id, nombre: p.nombre, stock: p.stock, stock_minimo: p.stock_minimo, precio: p.precio,
        vendidas_30_dias: p.unidades,
        demanda_semanal: Math.round(demandaDiaria * 7 * 10) / 10,
        cantidad_sugerida: sugerido,
        costo_estimado: Math.round(sugerido * p.precio * 0.6) // costo de compra ≈ 60 % del precio de venta
    };
}

const resumenCompra = (productos) => productos.map(p => `${p.cantidad_sugerida} x ${p.nombre}`).join(', ');

function promptOrden(productos) {
    const lineas = productos.map(p =>
        `- ${p.nombre}: quedan ${p.stock} (mínimo ${p.stock_minimo}), se vendieron ${p.vendidas_30_dias} en 30 días → pedir ${p.cantidad_sugerida} unidades (costo aprox. ${pesos(p.costo_estimado)})`
    ).join('\n');
    return [
        'Eres el encargado de compras de "Raíces Andinas", una tienda colombiana de productos andinos.',
        'Redacta en español un mensaje breve y formal (máximo 90 palabras) dirigido al proveedor solicitando la compra de estos productos.',
        'No inventes precios ni productos. No uses encabezados ni markdown, solo texto plano.',
        '',
        'PRODUCTOS A PEDIR:',
        lineas
    ].join('\n');
}

function telegramAlerta(productos, total) {
    return [
        '📉 ALERTA DE STOCK',
        '',
        ...productos.map(p => `${p.stock === 0 ? '🔴 AGOTADO' : '🟡'} ${p.nombre}: quedan ${p.stock} (mínimo ${p.stock_minimo})`),
        '',
        `🧮 Sugerencia de compra calculada (≈ ${pesos(total)}).`,
        '📧 Te envié un correo para que apruebes o rechaces la compra.'
    ].join('\n');
}

function correoAprobacion({ productos, total, orden, enlace }) {
    const filas = productos.map(p => `
        <tr style="border-bottom:1px solid #eee;">
          <td style="padding:8px;">${esc(p.nombre)}</td>
          <td style="padding:8px;text-align:center;">${p.stock} / ${p.stock_minimo}</td>
          <td style="padding:8px;text-align:center;">${p.vendidas_30_dias}</td>
          <td style="padding:8px;text-align:center;"><strong>${p.cantidad_sugerida}</strong></td>
          <td style="padding:8px;text-align:right;">${pesos(p.costo_estimado)}</td>
        </tr>`).join('');

    const boton = (url, texto, color) =>
        `<a href="${url}" style="display:inline-block;margin:6px;background:${color};color:#fff;padding:14px 26px;border-radius:999px;text-decoration:none;font-weight:bold;">${texto}</a>`;

    return plantillaCorreo(
        '📦 Aprobación de compra requerida',
        `<p>Algunos productos llegaron a su stock mínimo. Según las ventas de los últimos 30 días, esta es la compra sugerida:</p>
         <table style="width:100%;border-collapse:collapse;font-size:14px;">
           <tr style="background:#f0ede4;"><th style="text-align:left;padding:8px;">Producto</th><th style="padding:8px;">Stock / mín.</th><th style="padding:8px;">Vendidas 30 d</th><th style="padding:8px;">Pedir</th><th style="text-align:right;padding:8px;">Costo aprox.</th></tr>
           ${filas}
         </table>
         <p style="text-align:right;font-size:16px;"><strong>Total estimado: ${pesos(total)}</strong></p>
         <h3 style="color:#1a3c2a;">✉️ Orden de compra (redactada con IA)</h3>
         <p style="background:#f7f5f0;padding:14px;border-radius:8px;">${textoIAaHtml(orden)}</p>
         <p style="text-align:center;margin-top:24px;">
           ${boton(`${enlace}&decision=aprobar`, '✅ Aprobar compra', '#2f855a')}
           ${boton(`${enlace}&decision=rechazar`, '❌ Rechazar', '#c0392b')}
         </p>
         <p style="color:#888;font-size:13px;text-align:center;">Si apruebas, el inventario de la tienda se actualiza solo y se envía la orden al proveedor.<br>Si no respondes en ${HORAS_APROBACION} horas, la solicitud se cancela.</p>`
    );
}

function correoOrdenProveedor({ productos, total, orden }) {
    return plantillaCorreo(
        '🧾 Orden de compra - Raíces Andinas',
        `<p>${textoIAaHtml(orden)}</p>
         <table style="width:100%;border-collapse:collapse;font-size:14px;">
           <tr style="background:#f0ede4;"><th style="text-align:left;padding:8px;">Producto</th><th style="padding:8px;">Cantidad</th></tr>
           ${productos.map(p => `<tr style="border-bottom:1px solid #eee;"><td style="padding:8px;">${esc(p.nombre)}</td><td style="padding:8px;text-align:center;">${p.cantidad_sugerida}</td></tr>`).join('')}
         </table>
         <p>Valor estimado: <strong>${pesos(total)}</strong></p>`
    );
}

function registrar(motor, { db, canales, ia, firmar, entorno = process.env }) {
    const tokenCompra = (id) => firmar(`compra:${id}`);

    async function obtenerSolicitud(id) {
        const [filas] = await db.query('SELECT * FROM solicitudes_compra WHERE id = ?', [id]);
        if (filas.length === 0) return null;
        const s = filas[0];
        return { ...s, productos: typeof s.productos === 'string' ? JSON.parse(s.productos) : s.productos, total_estimado: parseFloat(s.total_estimado) };
    }

    // No pedir dos veces lo mismo: se omiten productos que ya esperan una decisión
    async function productosEnEspera() {
        const [filas] = await db.query(`SELECT productos FROM solicitudes_compra WHERE estado = 'pendiente'`);
        const ids = new Set();
        for (const f of filas) {
            const lista = typeof f.productos === 'string' ? JSON.parse(f.productos) : f.productos;
            lista.forEach(p => ids.add(p.id));
        }
        return ids;
    }

    motor.registrar({
        id: 'C02.stock-bajo', central: CENTRAL, flujo: 'Stock bajo: solicitar aprobación', evento: 'stock.bajo',
        async ejecutar({ productos: recibidos }, ctx) {
            const enEspera = await ctx.paso('Revisar solicitudes pendientes', async () => [...await productosEnEspera()]);
            const nuevos = recibidos.filter(p => !enEspera.includes(p.id));
            if (nuevos.length === 0) return { omitido_por: 'Ya hay una solicitud pendiente para estos productos' };

            // Bucle: un análisis por producto
            const analizados = [];
            for (const p of nuevos) {
                const [ventas] = await ctx.paso(`Ventas de 30 días: ${p.nombre}`, () => consultas.ventasProductos(db, 30, p.id));
                if (ventas) analizados.push(cantidadSugerida(ventas));
            }
            if (analizados.length === 0) return { omitido_por: 'Los productos ya no existen' };
            const total = analizados.reduce((s, p) => s + p.costo_estimado, 0);
            const resumen = resumenCompra(analizados);

            // Si la IA no responde, la compra no se detiene: se usa un texto base
            const orden = await ctx.paso('IA: redactar orden de compra', async () => {
                const generado = await ia.generarTexto({
                    funcion: 'orden_compra',
                    sistema: promptOrden(analizados),
                    pregunta: 'Redacta el mensaje de la orden de compra para el proveedor.'
                }).catch(() => null);
                return generado || `Cordial saludo. Solicitamos el despacho de: ${resumen}. Quedamos atentos a la confirmación. Gracias.`;
            }, { intentos: 1 });

            const solicitudId = await ctx.paso('Crear solicitud de compra', async () => {
                const [r] = await db.query(
                    `INSERT INTO solicitudes_compra (productos, total_estimado, orden, expira)
                     VALUES (?, ?, ?, NOW() + INTERVAL ? HOUR)`,
                    [JSON.stringify(analizados), total, orden, HORAS_APROBACION]
                );
                return r.insertId;
            });

            await ctx.paso('Programar vencimiento', () => ctx.programar('C02.compra-vencida', { solicitud_id: solicitudId }, HORAS_APROBACION * 60));

            const enlace = `${tiendaUrl()}/api/compras/${solicitudId}/decision?token=${tokenCompra(solicitudId)}`;
            await ctx.ramas(
                () => ctx.paso('Telegram: alerta de stock', () => canales.telegram(telegramAlerta(analizados, total))),
                () => ctx.paso('Correo: pedir aprobación al dueño', () => canales.correo({
                    para: entorno.ADMIN_EMAIL,
                    asunto: `📦 Aprobar compra: ${resumen}`,
                    html: correoAprobacion({ productos: analizados, total, orden, enlace })
                }))
            );
            return { solicitud: solicitudId, resumen, total_estimado: total };
        }
    });

    motor.registrar({
        id: 'C02.compra-aprobada', central: CENTRAL, flujo: 'Compra aprobada: reabastecer',
        async ejecutar({ solicitud_id }, ctx) {
            const s = await obtenerSolicitud(solicitud_id);
            const resultados = await ctx.paso('Actualizar stock en la tienda', async () => {
                const conexion = await db.getConnection();
                try {
                    await conexion.beginTransaction();
                    const lista = [];
                    for (const p of s.productos) {
                        const r = await consultas.reabastecer(conexion, p.id, p.cantidad_sugerida);
                        if (r) lista.push(r);
                    }
                    await conexion.commit();
                    return lista;
                } catch (error) {
                    await conexion.rollback();
                    throw error;
                } finally {
                    conexion.release();
                }
            });

            const resumen = resumenCompra(s.productos);
            await ctx.ramas(
                () => ctx.paso('Correo: orden al proveedor', () => canales.correo({
                    para: entorno.PROVEEDOR_EMAIL || entorno.ADMIN_EMAIL,
                    asunto: `🧾 Orden de compra Raíces Andinas: ${resumen}`,
                    html: correoOrdenProveedor({ productos: s.productos, total: s.total_estimado, orden: s.orden })
                })),
                () => ctx.paso('Telegram: compra aprobada', () => canales.telegram([
                    '✅ COMPRA APROBADA Y REABASTECIDA',
                    '',
                    ...resultados.map(r => `📦 ${r.nombre}: +${r.agregado} → ahora hay ${r.stock}`),
                    '',
                    '📧 Orden de compra enviada al proveedor.'
                ].join('\n')))
            );
            return { solicitud: solicitud_id, reabastecidos: resultados.map(r => ({ nombre: r.nombre, agregado: r.agregado, stock: r.stock })) };
        }
    });

    motor.registrar({
        id: 'C02.compra-rechazada', central: CENTRAL, flujo: 'Compra rechazada',
        async ejecutar({ solicitud_id }, ctx) {
            const s = await obtenerSolicitud(solicitud_id);
            await ctx.paso('Telegram: compra rechazada', () => canales.telegram(`❌ Compra RECHAZADA por el dueño:\n${resumenCompra(s.productos)}`));
            return { solicitud: solicitud_id, decision: 'rechazada' };
        }
    });

    motor.registrar({
        id: 'C02.compra-vencida', central: CENTRAL, flujo: 'Compra sin respuesta en 24 h',
        async ejecutar({ solicitud_id }, ctx) {
            const vencio = await ctx.paso('Vencer solicitud', () => decidir(solicitud_id, 'vencida'));
            if (!vencio) return { solicitud: solicitud_id, vencida: false, motivo: 'El dueño ya decidió' };
            const s = await obtenerSolicitud(solicitud_id);
            await ctx.paso('Telegram: sin respuesta', () => canales.telegram(`⏰ Nadie aprobó la compra en ${HORAS_APROBACION} h y se canceló:\n${resumenCompra(s.productos)}`));
            return { solicitud: solicitud_id, vencida: true };
        }
    });

    // Cambia el estado solo si sigue pendiente: dos clics en el enlace no suman el stock dos veces
    async function decidir(id, estado, decididoPor = null) {
        const [r] = await db.query(
            `UPDATE solicitudes_compra SET estado = ?, decidido_por = ?, decidido_en = NOW()
             WHERE id = ? AND estado = 'pendiente'`,
            [estado, decididoPor, id]
        );
        return r.affectedRows === 1;
    }

    // Lo usan la página del enlace firmado y el panel admin
    async function aplicarDecision(id, decision, decididoPor) {
        const estado = decision === 'aprobar' ? 'aprobada' : 'rechazada';
        if (!await decidir(id, estado, decididoPor)) return false;
        motor.ejecutarPorId(decision === 'aprobar' ? 'C02.compra-aprobada' : 'C02.compra-rechazada', { solicitud_id: id }, `decision:${decididoPor}`);
        return true;
    }

    const tokenValido = (id, token) => {
        const esperado = Buffer.from(tokenCompra(id));
        const recibido = Buffer.from(String(token));
        return esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido);
    };

    return { obtenerSolicitud, aplicarDecision, tokenValido };
}

module.exports = { registrar, cantidadSugerida, resumenCompra };
