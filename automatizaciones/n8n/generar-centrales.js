// automatizaciones/n8n/generar-centrales.js
// Genera las 5 "centrales" de automatización: flujos grandes que agrupan todas las
// automatizaciones de un área del negocio, con decisiones, bucles, esperas, IA y manejo de errores.
//
//   C01 · Centro de Pedidos y Clientes      (reemplaza 01, 02, 06, 08, 11, 13)
//   C02 · Centro de Inventario              (reemplaza 07 + reabastecimiento con aprobación)
//   C03 · Centro de Atención al Cliente     (reemplaza 04, 09, 10)
//   C04 · Centro de Reportes e Inteligencia (reemplaza 03, 05, 12 + analista semanal con IA)
//   C05 · Centro de Monitoreo de Errores    (vigila a las otras 4)
//
// Uso: npm run n8n:centrales   (genera e instala; n8n debe estar cerrado)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try {
    process.loadEnvFile(path.join(__dirname, '..', '..', '.env'));
} catch {
    console.warn('⚠️ No se encontró .env, se usarán valores de ejemplo');
}

const config = {
    remitente: process.env.TIENDA_EMAIL_REMITENTE || 'tu-correo@gmail.com',
    adminEmail: process.env.ADMIN_EMAIL || process.env.TIENDA_EMAIL_REMITENTE || 'tu-correo@gmail.com',
    proveedorEmail: process.env.PROVEEDOR_EMAIL || process.env.ADMIN_EMAIL || 'tu-correo@gmail.com',
    telegramChatId: process.env.ADMIN_TELEGRAM_CHAT_ID || 'TU_CHAT_ID_DE_TELEGRAM',
    tiendaUrl: process.env.TIENDA_URL || 'http://localhost:3000',
    apiUrl: `http://localhost:${process.env.PORT || 3000}`,
    apiKey: process.env.AUTOMATION_API_KEY || '',
    modeloGemini: process.env.GEMINI_MODELO || 'models/gemini-3.8-flash'
};

const CREDENCIAL_GMAIL = 'Gmail Raices Andinas';
const CREDENCIAL_TELEGRAM = 'Telegram Raices Andinas';
const CREDENCIAL_GEMINI = 'Gemini Raices Andinas';
const ID_MONITOREO = 'RaicesAndinasC05';
const CARPETA_SALIDA = path.join(__dirname, 'centrales');

// ============================================================
// FUNCIONES DE APOYO (se copian al inicio de cada nodo "Code")
// ============================================================
function ayudantes() {
    const TIENDA_URL = '__TIENDA_URL__';

    const pesos = (valor) => '$' + Math.round(Number(valor) || 0).toLocaleString('es-CO');

    const esc = (texto) => String(texto ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const plantillaCorreo = (titulo, contenido) => `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f7f5f0;padding:24px;">
  <div style="background:#1a3c2a;color:#fff;padding:20px 24px;border-radius:10px 10px 0 0;">
    <h1 style="margin:0;font-size:22px;">🌿 Raíces Andinas</h1>
  </div>
  <div style="background:#fff;padding:24px;border-radius:0 0 10px 10px;color:#333;line-height:1.5;">
    <h2 style="color:#1a3c2a;margin-top:0;">${titulo}</h2>
    ${contenido}
    <p style="margin-top:24px;"><a href="${TIENDA_URL}" style="background:#d4a853;color:#1a3c2a;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold;">Visitar la tienda</a></p>
  </div>
  <p style="text-align:center;color:#888;font-size:12px;">Raíces Andinas · Productos andinos auténticos</p>
</div>`;

    const tablaItems = (items) => `
<table style="width:100%;border-collapse:collapse;font-size:14px;">
  <tr style="background:#f0ede4;"><th style="text-align:left;padding:8px;">Producto</th><th style="padding:8px;">Cant.</th><th style="text-align:right;padding:8px;">Subtotal</th></tr>
  ${(items || []).map(i => `<tr style="border-bottom:1px solid #eee;"><td style="padding:8px;">${esc(i.nombre)}</td><td style="text-align:center;padding:8px;">${i.cantidad}</td><td style="text-align:right;padding:8px;">${pesos(i.subtotal)}</td></tr>`).join('')}
</table>`;

    // Convierte el texto de la IA (*negrita* y saltos de línea) en HTML seguro
    const textoIAaHtml = (texto) => esc(texto).replace(/\*\*?(.+?)\*\*?/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
}

// ============================================================
// C01 · CENTRO DE PEDIDOS Y CLIENTES
// ============================================================
function codRegistro() {
    const u = $input.first().json.body.usuario;
    const html = plantillaCorreo(
        `¡Bienvenido/a, ${esc(u.nombres)}! 🌿`,
        `<p>Gracias por registrarte en <strong>Raíces Andinas</strong>, tu tienda de productos andinos auténticos:
            café de origen, miel de páramo, quinua, panela artesanal y mucho más.</p>
         <ul>
           <li>🎁 <strong>Envío gratis</strong> en compras mayores a $80.000</li>
           <li>💬 Nuestro asistente virtual te ayuda las 24 horas</li>
           <li>📦 Te avisamos por correo cada paso de tus pedidos</li>
         </ul>`
    );
    const telegram = `🎉 NUEVO CLIENTE REGISTRADO\n\n👤 ${u.nombres} ${u.apellidos || ''}\n📧 ${u.correo}`;
    return [{ json: { para: u.correo, asunto: '🌿 Bienvenido/a a Raíces Andinas', html, telegram } }];
}

function codClasificarCliente() {
    const { pedido, cliente } = $('Webhook: pedido creado').first().json.body;
    const h = $input.first().json;

    // Regla de negocio: VIP = 5 compras o más, o más de $300.000 gastados
    let tipo = 'nuevo';
    if (h.pedidos_previos >= 5 || h.total_gastado >= 300000) tipo = 'vip';
    else if (h.pedidos_previos >= 1) tipo = 'recurrente';

    const etiquetas = { nuevo: '🆕 Cliente nuevo (primera compra)', recurrente: '🔁 Cliente recurrente', vip: '👑 Cliente VIP' };
    const historial = h.pedidos_previos > 0 ? ` · ${h.pedidos_previos} compras antes por ${pesos(h.total_gastado)}` : '';

    const telegram = [
        `🛒 NUEVO PEDIDO #${pedido.id}`,
        `${etiquetas[tipo]}${historial}`,
        '',
        `👤 ${cliente.nombres} ${cliente.apellidos || ''}`,
        `📧 ${cliente.correo}${cliente.telefono ? `\n📱 ${cliente.telefono}` : ''}`,
        '',
        ...pedido.items.map(i => `• ${i.cantidad} x ${i.nombre} = ${pesos(i.subtotal)}`),
        '',
        `🚚 Envío: ${pedido.costo_envio > 0 ? pesos(pedido.costo_envio) : 'gratis'}`,
        `💰 Total: ${pesos(pedido.total)}`,
        `💳 ${pedido.metodo_pago}`,
        `📍 ${pedido.direccion_envio}`
    ].join('\n');

    return [{
        json: {
            tipo, etiqueta: etiquetas[tipo], pedido, cliente, historial: h, total: pedido.total,
            telegram,
            telegram_prioritario: `🚨 PEDIDO PRIORITARIO (más de $200.000)\n👉 Despachar primero\n\n${telegram}`
        }
    }];
}

function codCorreoPedido() {
    // TIPO se define al inicio del nodo: 'nuevo', 'recurrente' o 'vip'
    const d = $input.first().json;
    const { pedido, cliente } = d;

    const intro = {
        nuevo: `<p>Esta es tu <strong>primera compra</strong> con nosotros. ¡Bienvenido/a a la familia Raíces Andinas! 🌱</p>`,
        recurrente: `<p>¡Qué alegría tenerte de vuelta! Ya llevas <strong>${d.historial.pedidos_previos + 1} compras</strong> con nosotros. Gracias por elegirnos otra vez.</p>`,
        vip: `<p>👑 Como <strong>cliente VIP</strong>, tu pedido tiene <strong>prioridad</strong> en la preparación y el despacho. Gracias por ser parte especial de Raíces Andinas.</p>`
    }[TIPO];

    const asunto = {
        nuevo: `✅ Tu primer pedido #${pedido.id} fue recibido - Raíces Andinas`,
        recurrente: `✅ Confirmación de tu pedido #${pedido.id} - Raíces Andinas`,
        vip: `👑 Pedido VIP #${pedido.id} confirmado - Raíces Andinas`
    }[TIPO];

    const html = plantillaCorreo(
        `¡Gracias por tu compra, ${esc(cliente.nombres)}!`,
        `<p>Recibimos tu pedido <strong>#${pedido.id}</strong> y ya lo estamos preparando.</p>
         ${intro}
         ${tablaItems(pedido.items)}
         <p style="text-align:right;margin:4px 0;">Subtotal: ${pesos(pedido.subtotal ?? pedido.total)}</p>
         <p style="text-align:right;margin:4px 0;">Envío: ${pedido.costo_envio > 0 ? pesos(pedido.costo_envio) : '<strong style="color:#2f855a">GRATIS</strong>'}</p>
         <p style="font-size:18px;text-align:right;"><strong>Total: ${pesos(pedido.total)}</strong></p>
         <p><strong>Dirección de envío:</strong> ${esc(pedido.direccion_envio)}<br>
            <strong>Método de pago:</strong> ${esc(pedido.metodo_pago)}</p>
         <p>Te avisaremos por correo cada vez que tu pedido cambie de estado.</p>`
    );

    return [{ json: { para: cliente.correo, asunto, html } }];
}

function codMensajeEstado() {
    // ESTADO se define al inicio del nodo
    const { pedido, cliente } = $input.first().json.body;
    const mensajes = {
        confirmado: { asunto: `👍 Tu pedido #${pedido.id} fue confirmado`, texto: 'Confirmamos tu pedido y ya estamos alistando tus productos.' },
        enviado: { asunto: `🚚 Tu pedido #${pedido.id} va en camino`, texto: 'Tu pedido salió de nuestra bodega. El tiempo estimado de entrega es de 3 a 5 días hábiles.' },
        entregado: { asunto: `🎉 Tu pedido #${pedido.id} fue entregado`, texto: '¡Tu pedido fue entregado! Esperamos que disfrutes tus productos andinos. Gracias por confiar en nosotros.' },
        cancelado: { asunto: `❌ Tu pedido #${pedido.id} fue cancelado`, texto: 'Tu pedido fue cancelado. Si no solicitaste la cancelación o tienes dudas, responde a este correo o escríbenos a soporte.' }
    };
    const m = mensajes[ESTADO];
    const html = plantillaCorreo(
        `Hola ${esc(cliente.nombres)}, tu pedido cambió de estado`,
        `<p>${m.texto}</p>
         <p style="font-size:16px;">Estado actual: <strong style="text-transform:uppercase;color:#1a3c2a;">${esc(ESTADO)}</strong></p>
         ${tablaItems(pedido.items)}
         <p style="text-align:right;"><strong>Total: ${pesos(pedido.total)}</strong></p>`
    );
    return [{ json: { para: cliente.correo, asunto: m.asunto, html } }];
}

function codAvisoCancelacion() {
    // TARDIA se define al inicio del nodo (true si el pedido ya había salido de bodega)
    const { pedido, cliente } = $input.first().json.body;
    const telegram = [
        TARDIA ? `⚠️ CANCELACIÓN TARDÍA #${pedido.id}` : `❌ PEDIDO CANCELADO #${pedido.id}`,
        `(estaba: ${pedido.estado_anterior})`,
        TARDIA ? '👉 El pedido ya había sido despachado: coordina la devolución con la transportadora.' : '',
        '',
        `👤 ${cliente.nombres} ${cliente.apellidos || ''} · ${cliente.correo}`,
        `💰 ${pesos(pedido.total)}`,
        '',
        '📦 Stock devuelto al inventario:',
        ...pedido.items.map(i => `• +${i.cantidad} ${i.nombre}`)
    ].filter(l => l !== null).join('\n');
    return [{ json: { telegram } }];
}

function codPrepararEncuesta() {
    const { pedido, cliente, enlace_encuesta } = $('Webhook: pedido entregado').first().json.body;
    const estrella = () => `<a href="${enlace_encuesta}" style="text-decoration:none;font-size:30px;color:#d4a853;">★</a>`;
    const html = plantillaCorreo(
        `${esc(cliente.nombres)}, ¿cómo te fue con tu pedido?`,
        `<p>Hace unos días recibiste tu pedido <strong>#${pedido.id}</strong>. Nos encantaría saber qué te pareció.</p>
         ${tablaItems(pedido.items)}
         <p style="text-align:center;margin:24px 0 8px;">${[1, 2, 3, 4, 5].map(estrella).join('')}</p>
         <p style="text-align:center;">
           <a href="${enlace_encuesta}" style="background:#1a3c2a;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:bold;">Calificar mi compra</a>
         </p>
         <p style="text-align:center;color:#888;font-size:13px;">Solo toma 10 segundos 💚</p>`
    );
    return [{ json: { para: cliente.correo, asunto: `⭐ ¿Qué te pareció tu pedido #${pedido.id}?`, html } }];
}

function codSeguimientoEncuesta() {
    // NIVEL se define al inicio del nodo: 'mala', 'regular' o 'buena'
    const { pedido, cliente, puntuacion, comentario } = $input.first().json.body;
    const estrellas = '★'.repeat(puntuacion) + '☆'.repeat(5 - puntuacion);
    const nota = `<span style="color:#d4a853;font-size:18px;">${estrellas}</span>`;

    const textos = {
        mala: {
            asunto: `Lamentamos tu experiencia con el pedido #${pedido.id}`,
            titulo: `${esc(cliente.nombres)}, queremos arreglarlo`,
            contenido: `<p>Vimos tu calificación (${nota}) y lo sentimos mucho. Esa no es la experiencia que queremos darte.</p>
                ${comentario ? `<p style="background:#fdecea;padding:12px;border-radius:8px;">"${esc(comentario)}"</p>` : ''}
                <p>Una persona de nuestro equipo ya recibió tu caso y te contactará en las próximas 24 horas para darte una solución.</p>`
        },
        regular: {
            asunto: `Gracias por tu opinión sobre el pedido #${pedido.id}`,
            titulo: `Gracias, ${esc(cliente.nombres)}`,
            contenido: `<p>Recibimos tu calificación (${nota}). Queremos que tu próxima compra sea de 5 estrellas.</p>
                <p>Si quieres contarnos qué podemos mejorar, responde este correo: lo leemos todo.</p>`
        },
        buena: {
            asunto: `¡Gracias por tus ${puntuacion} estrellas! 💚`,
            titulo: `¡Nos alegra mucho, ${esc(cliente.nombres)}!`,
            contenido: `<p>Gracias por calificar tu pedido <strong>#${pedido.id}</strong> con ${nota}.</p>
                <p>Detrás de cada producto hay familias campesinas de los Andes, y tu compra las apoya directamente. 🌱</p>
                <p>Si te gustó, cuéntaselo a un amigo: nos ayuda muchísimo.</p>`
        }
    }[NIVEL];

    return [{ json: { para: cliente.correo, asunto: textos.asunto, html: plantillaCorreo(textos.titulo, textos.contenido) } }];
}

function codAlertaEncuesta() {
    const { pedido, cliente, puntuacion, comentario } = $input.first().json.body;
    const telegram = [
        `😟 COMPRA MAL CALIFICADA: ${'⭐'.repeat(puntuacion)} (${puntuacion}/5)`,
        `Pedido #${pedido.id} · ${pesos(pedido.total)}`,
        '',
        `👤 ${cliente.nombres} ${cliente.apellidos || ''}`,
        `📧 ${cliente.correo}${cliente.telefono ? `\n📱 ${cliente.telefono}` : ''}`,
        '',
        `📝 ${comentario || '(sin comentario)'}`,
        '',
        '👉 Al cliente ya le llegó un correo de disculpa. Contáctalo en menos de 24 h.'
    ].join('\n');
    return [{ json: { telegram } }];
}

// ============================================================
// C02 · CENTRO DE INVENTARIO
// ============================================================
function codSepararProductos() {
    // Un elemento por producto, para recorrerlos uno a uno en el bucle
    const { pedido_id, productos } = $input.first().json.body;
    return productos.map(p => ({ json: { ...p, pedido_id } }));
}

function codCantidadSugerida() {
    // Calcula cuánto comprar: cubrir 3 semanas de demanda + el stock mínimo
    return $input.all().map(item => {
        const p = item.json;
        const demandaDiaria = p.unidades / p.dias;
        const objetivo = Math.ceil(demandaDiaria * 21) + p.stock_minimo;
        const sugerido = Math.max(objetivo - p.stock, p.stock_minimo * 2, 5);
        return {
            json: {
                id: p.id, nombre: p.nombre, stock: p.stock, stock_minimo: p.stock_minimo, precio: p.precio,
                vendidas_30_dias: p.unidades,
                demanda_semanal: Math.round(demandaDiaria * 7 * 10) / 10,
                cantidad_sugerida: sugerido,
                costo_estimado: Math.round(sugerido * p.precio * 0.6) // costo de compra ≈ 60 % del precio de venta
            }
        };
    });
}

function codPrepararSolicitud() {
    const productos = $input.first().json.productos;
    const total = productos.reduce((s, p) => s + p.costo_estimado, 0);
    // Enlace para reanudar la espera. Ya incluye "?signature=..." (seguridad de n8n), así que la decisión se une con "&"
    const enlace = String($execution.resumeUrl).replace('/webhook/webhook-waiting/', '/webhook-waiting/');
    const unir = enlace.includes('?') ? '&' : '?';

    const lineas = productos.map(p =>
        `- ${p.nombre}: quedan ${p.stock} (mínimo ${p.stock_minimo}), se vendieron ${p.vendidas_30_dias} en 30 días → pedir ${p.cantidad_sugerida} unidades (costo aprox. ${pesos(p.costo_estimado)})`
    ).join('\n');

    const telegram = [
        '📉 ALERTA DE STOCK',
        '',
        ...productos.map(p => `${p.stock === 0 ? '🔴 AGOTADO' : '🟡'} ${p.nombre}: quedan ${p.stock} (mínimo ${p.stock_minimo})`),
        '',
        `🧮 Sugerencia de compra calculada (≈ ${pesos(total)}).`,
        '📧 Te envié un correo para que apruebes o rechaces la compra.'
    ].join('\n');

    const sistema = [
        'Eres el encargado de compras de "Raíces Andinas", una tienda colombiana de productos andinos.',
        'Redacta en español un mensaje breve y formal (máximo 90 palabras) dirigido al proveedor solicitando la compra de estos productos.',
        'No inventes precios ni productos. No uses encabezados ni markdown, solo texto plano.',
        '',
        'PRODUCTOS A PEDIR:',
        lineas
    ].join('\n');

    return [{
        json: {
            productos, total_estimado: total, telegram, sistema,
            pregunta: 'Redacta el mensaje de la orden de compra para el proveedor.',
            enlace_aprobar: `${enlace}${unir}decision=aprobar`,
            enlace_rechazar: `${enlace}${unir}decision=rechazar`,
            resumen: productos.map(p => `${p.cantidad_sugerida} x ${p.nombre}`).join(', ')
        }
    }];
}

function codCorreoAprobacion() {
    const s = $('Preparar solicitud de aprobación').first().json;
    const textoIA = String($input.first().json.text || '').trim();
    const orden = textoIA || `Cordial saludo. Solicitamos el despacho de: ${s.resumen}. Quedamos atentos a la confirmación. Gracias.`;

    const filas = s.productos.map(p => `
        <tr style="border-bottom:1px solid #eee;">
          <td style="padding:8px;">${esc(p.nombre)}</td>
          <td style="padding:8px;text-align:center;">${p.stock} / ${p.stock_minimo}</td>
          <td style="padding:8px;text-align:center;">${p.vendidas_30_dias}</td>
          <td style="padding:8px;text-align:center;"><strong>${p.cantidad_sugerida}</strong></td>
          <td style="padding:8px;text-align:right;">${pesos(p.costo_estimado)}</td>
        </tr>`).join('');

    const boton = (url, texto, color) =>
        `<a href="${url}" style="display:inline-block;margin:6px;background:${color};color:#fff;padding:14px 26px;border-radius:999px;text-decoration:none;font-weight:bold;">${texto}</a>`;

    const html = plantillaCorreo(
        '📦 Aprobación de compra requerida',
        `<p>Algunos productos llegaron a su stock mínimo. Según las ventas de los últimos 30 días, esta es la compra sugerida:</p>
         <table style="width:100%;border-collapse:collapse;font-size:14px;">
           <tr style="background:#f0ede4;"><th style="text-align:left;padding:8px;">Producto</th><th style="padding:8px;">Stock / mín.</th><th style="padding:8px;">Vendidas 30 d</th><th style="padding:8px;">Pedir</th><th style="text-align:right;padding:8px;">Costo aprox.</th></tr>
           ${filas}
         </table>
         <p style="text-align:right;font-size:16px;"><strong>Total estimado: ${pesos(s.total_estimado)}</strong></p>
         <h3 style="color:#1a3c2a;">✉️ Orden de compra (redactada con IA)</h3>
         <p style="background:#f7f5f0;padding:14px;border-radius:8px;">${textoIAaHtml(orden)}</p>
         <p style="text-align:center;margin-top:24px;">
           ${boton(s.enlace_aprobar, '✅ Aprobar compra', '#2f855a')}
           ${boton(s.enlace_rechazar, '❌ Rechazar', '#c0392b')}
         </p>
         <p style="color:#888;font-size:13px;text-align:center;">Si apruebas, el inventario de la tienda se actualiza solo y se envía la orden al proveedor.<br>Si no respondes en 24 horas, la solicitud se cancela.</p>`
    );

    return [{ json: { asunto: `📦 Aprobar compra: ${s.resumen}`, html, orden } }];
}

function codPrepararReabastecimiento() {
    const s = $('Preparar solicitud de aprobación').first().json;
    return s.productos.map(p => ({ json: { id: p.id, nombre: p.nombre, cantidad: p.cantidad_sugerida } }));
}

function codOrdenProveedor() {
    const s = $('Preparar solicitud de aprobación').first().json;
    const orden = $('Armar correo de aprobación').first().json.orden;
    const resultados = $input.first().json.resultados;

    const html = plantillaCorreo(
        '🧾 Orden de compra - Raíces Andinas',
        `<p>${textoIAaHtml(orden)}</p>
         <table style="width:100%;border-collapse:collapse;font-size:14px;">
           <tr style="background:#f0ede4;"><th style="text-align:left;padding:8px;">Producto</th><th style="padding:8px;">Cantidad</th></tr>
           ${s.productos.map(p => `<tr style="border-bottom:1px solid #eee;"><td style="padding:8px;">${esc(p.nombre)}</td><td style="padding:8px;text-align:center;">${p.cantidad_sugerida}</td></tr>`).join('')}
         </table>
         <p>Valor estimado: <strong>${pesos(s.total_estimado)}</strong></p>`
    );

    const telegram = [
        '✅ COMPRA APROBADA Y REABASTECIDA',
        '',
        ...resultados.map(r => `📦 ${r.nombre}: +${r.agregado} → ahora hay ${r.stock}`),
        '',
        '📧 Orden de compra enviada al proveedor.'
    ].join('\n');

    return [{ json: { asunto: `🧾 Orden de compra Raíces Andinas: ${s.resumen}`, html, telegram } }];
}

// ============================================================
// C03 · CENTRO DE ATENCIÓN AL CLIENTE
// ============================================================
function codContextoIA() {
    const d = $input.first().json.body;
    const ingles = d.idioma === 'en';
    const limpiar = (texto) => String(texto ?? '').replace(/[{}]/g, '');

    const catalogo = d.catalogo.map(p => {
        const precio = p.descuento > 0
            ? `${pesos(p.precio_final)} (oferta -${p.descuento}%, antes ${pesos(p.precio)})`
            : pesos(p.precio);
        const stock = p.stock > 0 ? `${p.stock} disponibles` : 'AGOTADO';
        return `- ${limpiar(p.nombre)} | categoría: ${limpiar(p.categoria || 'otros')} | precio: ${precio} | ${stock}${p.destacado ? ' | destacado' : ''} | ${limpiar(p.descripcion || '')}`;
    }).join('\n');

    const historial = (d.historial || [])
        .map(m => `${m.de === 'cliente' ? 'Cliente' : 'Asistente'}: ${limpiar(m.texto).slice(0, 300)}`)
        .join('\n');

    const sistema = [
        'Eres el asistente virtual de "Raíces Andinas", una tienda online colombiana de productos andinos naturales.',
        `Responde SIEMPRE en ${ingles ? 'inglés' : 'español'}, con tono cálido y cercano, en máximo 90 palabras.`,
        'Usa SOLO la información de este contexto. Si no sabes algo, dilo y sugiere escribir 6 para hablar con un asesor humano.',
        'Nunca inventes productos, precios, descuentos ni políticas. Los precios están en pesos colombianos (COP).',
        'Para resaltar usa *asteriscos* (no uses otros formatos ni encabezados). Puedes usar emojis con moderación.',
        'Si el cliente quiere comprar, explícale que agregue los productos al carrito y finalice la compra con su cuenta.',
        '',
        'CATÁLOGO ACTUAL:',
        catalogo,
        '',
        'POLÍTICAS:',
        `- Envío a toda Colombia en 3 a 5 días hábiles: ${pesos(d.tienda.envio_costo)}. GRATIS en compras mayores a ${pesos(d.tienda.envio_gratis_desde)}.`,
        '- Devoluciones: hasta 30 días después de recibir el pedido, con el producto en su empaque original. Reembolso en 5 a 7 días hábiles.',
        '- Pagos: efectivo contra entrega o transferencia bancaria.',
        `- Contacto: ${d.tienda.contacto.correo}, WhatsApp ${d.tienda.contacto.whatsapp}. Horario: lunes a viernes 8 a. m. a 6 p. m., sábados 9 a. m. a 1 p. m.`,
        '- Menú rápido del chat: 1 productos, 2 envíos, 3 devoluciones, 4 ofertas, 5 cómo comprar, 6 asesor humano.',
        '',
        historial ? `CONVERSACIÓN PREVIA:\n${historial}` : ''
    ].join('\n');

    return [{ json: { sistema, pregunta: limpiar(d.mensaje) } }];
}

function codFormatearRespuesta() {
    return [{ json: { respuesta: String($input.first().json.text || '').trim() } }];
}

function codRespuestaVacia() {
    // La IA no respondió (saturada o con error): la tienda usará su menú de respaldo
    return [{ json: { respuesta: '' } }];
}

function codAlertaAsesorCliente() {
    const d = $input.first().json.body;
    const c = d.cliente;
    const telegram = [
        `🙋 UN CLIENTE PIDE HABLAR CON UN ASESOR (chat #${d.chat_id})`,
        '',
        `👤 ${c.nombres} ${c.apellidos || ''}`,
        `📧 ${c.correo}${c.telefono ? `\n📱 ${c.telefono}` : ''}`,
        '',
        '💬 Últimos mensajes:',
        ...(d.ultimos_mensajes || []).map(m => `› ${m}`),
        '',
        '📧 Ya le confirmamos por correo que lo contactarás.'
    ].join('\n');
    return [{ json: { telegram } }];
}

function codCorreoAsesor() {
    const c = $input.first().json.body.cliente;
    const html = plantillaCorreo(
        `${esc(c.nombres)}, un asesor te contactará pronto`,
        `<p>Recibimos tu solicitud en el chat de la tienda. Una persona de nuestro equipo te escribirá o llamará en horario de atención:</p>
         <p>🕗 Lunes a viernes 8 a. m. – 6 p. m. · Sábados 9 a. m. – 1 p. m.</p>
         <p>Si es urgente, escríbenos por WhatsApp al <strong>+57 300 123 4567</strong>.</p>`
    );
    return [{ json: { para: c.correo, asunto: '🙋 Recibimos tu solicitud de atención - Raíces Andinas', html } }];
}

function codAlertaAsesorVisitante() {
    const d = $input.first().json.body;
    const telegram = [
        `🙋 UN VISITANTE PIDE HABLAR CON UN ASESOR (chat #${d.chat_id})`,
        '👤 No ha iniciado sesión: no tenemos sus datos de contacto.',
        '',
        '💬 Últimos mensajes:',
        ...(d.ultimos_mensajes || []).map(m => `› ${m}`)
    ].join('\n');
    return [{ json: { telegram } }];
}

function codAlertaCalificacionChat() {
    const d = $input.first().json.body;
    const c = d.cliente;
    const telegram = [
        `⚠️ CALIFICACIÓN BAJA EN EL CHATBOT: ${'⭐'.repeat(d.puntuacion)} (${d.puntuacion}/5)`,
        `Chat #${d.chat_id}`,
        '',
        c ? `👤 ${c.nombres} ${c.apellidos || ''}\n📧 ${c.correo}` : '👤 Visitante sin sesión iniciada',
        '',
        `📝 Comentario: ${d.comentario || '(sin comentario)'}`
    ].join('\n');
    return [{ json: { telegram } }];
}

function codCorreoRecuperacion() {
    const { usuario, enlace, minutos } = $input.first().json.body;
    const html = plantillaCorreo(
        'Restablece tu contraseña',
        `<p>Hola ${esc(usuario.nombres)}, recibimos una solicitud para cambiar la contraseña de tu cuenta.</p>
         <p style="text-align:center;margin:26px 0;">
           <a href="${enlace}" style="background:#1a3c2a;color:#fff;padding:13px 26px;border-radius:999px;text-decoration:none;font-weight:bold;">Crear nueva contraseña</a>
         </p>
         <p style="color:#666;font-size:14px;">⏰ Este enlace vence en <strong>${minutos} minutos</strong> y solo se puede usar una vez.</p>
         <p style="color:#666;font-size:14px;">Si tú no lo solicitaste, ignora este correo: tu contraseña actual sigue funcionando.</p>`
    );
    return [{ json: { para: usuario.correo, asunto: '🔑 Restablece tu contraseña - Raíces Andinas', html } }];
}

// ============================================================
// C04 · CENTRO DE REPORTES E INTELIGENCIA
// ============================================================
function codResumenDiario() {
    const { stock_bajo, pedidos_atrasados, horas_limite } = $input.first().json;
    const lineas = ['☀️ RESUMEN DIARIO - Raíces Andinas', ''];
    if (stock_bajo.length > 0) {
        lineas.push(`📦 Productos para reponer (${stock_bajo.length}):`);
        stock_bajo.forEach(p => lineas.push(`${p.stock === 0 ? '🔴 AGOTADO' : '🟡'} ${p.nombre}: ${p.stock} uds (mínimo ${p.stock_minimo})`));
        lineas.push('');
    }
    if (pedidos_atrasados.length > 0) {
        lineas.push(`⏰ Pedidos pendientes hace más de ${horas_limite} h (${pedidos_atrasados.length}):`);
        pedidos_atrasados.forEach(p => lineas.push(`• #${p.id} - ${p.nombres} ${p.apellidos} - ${pesos(p.total)} (${Math.floor(p.horas_pendiente / 24)} días)`));
    }
    return [{ json: { telegram: lineas.join('\n') } }];
}

function codCierreDia() {
    const d = $input.first().json;
    let comparacion = '';
    if (d.ingresos_ayer > 0) {
        const cambio = Math.round((d.ingresos_hoy - d.ingresos_ayer) / d.ingresos_ayer * 100);
        comparacion = cambio >= 0 ? `📈 ${cambio}% más que ayer` : `📉 ${Math.abs(cambio)}% menos que ayer`;
    } else if (d.ingresos_hoy > 0) {
        comparacion = '📈 Ayer no hubo ventas';
    }
    const lineas = ['🌙 CIERRE DEL DÍA - Raíces Andinas', ''];
    if (d.pedidos_hoy === 0) {
        lineas.push('Hoy no hubo ventas. 💤');
    } else {
        lineas.push(`🧾 Pedidos: ${d.pedidos_hoy}`, `💰 Ventas: ${pesos(d.ingresos_hoy)}`);
        if (comparacion) lineas.push(comparacion);
        if (d.top_productos.length > 0) {
            lineas.push('', '🏆 Lo más vendido hoy:');
            d.top_productos.forEach((p, i) => lineas.push(`${['🥇', '🥈', '🥉'][i]} ${p.nombre} (${p.unidades} uds)`));
        }
    }
    lineas.push('');
    if (d.cancelados_hoy > 0) lineas.push(`❌ Cancelados hoy: ${d.cancelados_hoy}`);
    lineas.push(`👥 Clientes nuevos hoy: ${d.clientes_nuevos}`, `⏳ Pedidos por atender: ${d.pedidos_pendientes}`);
    return [{ json: { telegram: lineas.join('\n') } }];
}

function codCalcularKpis() {
    const ind = $('Indicadores de la semana').first().json;
    const top = ($('Unir top 5').first().json.productos || []).filter(p => p && p.nombre && p.unidades > 0);
    const inv = $('Estado del inventario').first().json;
    const a = ind.actual;
    const b = ind.anterior;
    const variacion = (x, y) => (y ? Math.round((x - y) / y * 100) : (x ? 100 : 0));

    const kpis = [
        { nombre: 'Ventas', actual: pesos(a.ingresos), anterior: pesos(b.ingresos), cambio: variacion(a.ingresos, b.ingresos) },
        { nombre: 'Pedidos', actual: a.pedidos, anterior: b.pedidos, cambio: variacion(a.pedidos, b.pedidos) },
        { nombre: 'Ticket promedio', actual: pesos(a.ticket_promedio), anterior: pesos(b.ticket_promedio), cambio: variacion(a.ticket_promedio, b.ticket_promedio) },
        { nombre: 'Clientes nuevos', actual: a.clientes_nuevos, anterior: b.clientes_nuevos, cambio: variacion(a.clientes_nuevos, b.clientes_nuevos) },
        { nombre: 'Cancelaciones', actual: a.cancelados, anterior: b.cancelados, cambio: variacion(a.cancelados, b.cancelados) },
        { nombre: 'Chats atendidos', actual: a.chats, anterior: b.chats, cambio: variacion(a.chats, b.chats) },
        { nombre: 'Satisfacción', actual: a.satisfaccion ?? '—', anterior: b.satisfaccion ?? '—', cambio: null }
    ];

    // Reglas de negocio para las alertas críticas
    const alertas = [];
    const agotados = inv.stock_bajo.filter(p => p.stock === 0);
    if (agotados.length) alertas.push(`${agotados.length} producto(s) agotado(s): ${agotados.map(p => p.nombre).join(', ')}`);
    if (b.ingresos > 0 && variacion(a.ingresos, b.ingresos) <= -30) alertas.push(`Las ventas cayeron ${Math.abs(variacion(a.ingresos, b.ingresos))}% frente a la semana anterior`);
    if (a.satisfaccion !== null && a.satisfaccion < 3) alertas.push(`La satisfacción de compras está en ${a.satisfaccion}/5`);
    if (inv.pedidos_atrasados.length) alertas.push(`${inv.pedidos_atrasados.length} pedido(s) llevan más de 48 h sin atender`);

    const datosTexto = [
        ...kpis.map(k => `- ${k.nombre}: ${k.actual} (semana anterior: ${k.anterior}${k.cambio !== null ? `, cambio ${k.cambio}%` : ''})`),
        `- Productos más vendidos: ${top.length ? top.map(p => `${p.nombre} (${p.unidades} uds)`).join(', ') : 'sin ventas'}`,
        `- Productos con stock bajo: ${inv.stock_bajo.length ? inv.stock_bajo.map(p => `${p.nombre} (${p.stock})`).join(', ') : 'ninguno'}`,
        `- Alertas: ${alertas.length ? alertas.join('; ') : 'ninguna'}`
    ].join('\n');

    const sistema = [
        'Eres un analista de negocio de "Raíces Andinas", una tienda online colombiana de productos andinos.',
        'Analiza los indicadores de la semana y responde en español, en máximo 170 palabras, con este formato en texto plano:',
        'RESUMEN: (2 frases)',
        'LO POSITIVO: (1-2 puntos)',
        'LO QUE PREOCUPA: (1-2 puntos)',
        'RECOMENDACIONES: (3 acciones concretas numeradas)',
        'Usa solo estos datos, no inventes cifras.',
        '',
        'DATOS DE LA SEMANA:',
        datosTexto
    ].join('\n');

    return [{ json: { kpis, top, alertas, inventario: inv, sistema, pregunta: 'Analiza la semana y dame tus recomendaciones.' } }];
}

function codInformeSemanal() {
    const d = $('Calcular indicadores clave').first().json;
    const analisis = String($input.first().json.text || '').trim()
        || 'La IA no estuvo disponible en este momento. Revisa los indicadores de la tabla.';

    const flecha = (c) => (c === null ? '' : c > 0 ? `<span style="color:#2f855a">▲ ${c}%</span>` : c < 0 ? `<span style="color:#c0392b">▼ ${Math.abs(c)}%</span>` : '=');
    const maxUnidades = Math.max(1, ...d.top.map(p => p.unidades));

    const html = plantillaCorreo(
        '📊 Informe semanal de negocio',
        `<h3 style="color:#1a3c2a;">Indicadores (últimos 7 días vs. semana anterior)</h3>
         <table style="width:100%;border-collapse:collapse;font-size:14px;">
           <tr style="background:#f0ede4;"><th style="text-align:left;padding:8px;">Indicador</th><th style="padding:8px;">Esta semana</th><th style="padding:8px;">Anterior</th><th style="padding:8px;">Cambio</th></tr>
           ${d.kpis.map(k => `<tr style="border-bottom:1px solid #eee;"><td style="padding:8px;">${k.nombre}</td><td style="padding:8px;text-align:center;"><strong>${k.actual}</strong></td><td style="padding:8px;text-align:center;color:#888;">${k.anterior}</td><td style="padding:8px;text-align:center;">${flecha(k.cambio)}</td></tr>`).join('')}
         </table>
         <h3 style="color:#1a3c2a;">🏆 Productos más vendidos</h3>
         ${d.top.length ? d.top.map(p => `
           <div style="margin:6px 0;font-size:14px;">${esc(p.nombre)} · ${p.unidades} uds
             <div style="background:#f0ede4;border-radius:6px;height:12px;"><div style="background:#d4a853;height:12px;border-radius:6px;width:${Math.round(p.unidades / maxUnidades * 100)}%;"></div></div>
           </div>`).join('') : '<p>Sin ventas esta semana.</p>'}
         ${d.alertas.length ? `<h3 style="color:#c0392b;">🚨 Alertas</h3><ul>${d.alertas.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
         <h3 style="color:#1a3c2a;">🤖 Análisis del asistente de IA</h3>
         <p style="background:#f7f5f0;padding:14px;border-radius:8px;">${textoIAaHtml(analisis)}</p>`
    );

    const telegram = [
        '📊 INFORME SEMANAL',
        '',
        ...d.kpis.slice(0, 4).map(k => `• ${k.nombre}: ${k.actual}${k.cambio !== null ? ` (${k.cambio >= 0 ? '+' : ''}${k.cambio}%)` : ''}`),
        '',
        `🏆 Top: ${d.top.slice(0, 3).map(p => p.nombre).join(', ') || 'sin ventas'}`,
        '📧 El informe completo con el análisis de IA está en tu correo.'
    ].join('\n');

    return [{
        json: {
            asunto: '📊 Informe semanal Raíces Andinas', html, telegram,
            hay_alertas: d.alertas.length > 0,
            telegram_alerta: `🚨 ALERTAS CRÍTICAS DE LA SEMANA\n\n${d.alertas.map(a => `• ${a}`).join('\n')}`
        }
    }];
}

function codReporteMensual() {
    const r = $input.first().json;
    const v = r.ventas;
    const c = r.calificaciones;
    const filaKpi = (etiqueta, valor) =>
        `<tr><td style="padding:8px;border-bottom:1px solid #eee;">${etiqueta}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right;font-weight:bold;">${valor}</td></tr>`;
    const top = v.top_productos.length > 0
        ? `<ol>${v.top_productos.map(p => `<li>${esc(p.nombre)}: ${p.unidades} uds · ${pesos(p.ingresos)}</li>`).join('')}</ol>`
        : '<p>No hubo ventas este mes.</p>';
    const html = plantillaCorreo(
        `📊 Reporte mensual ${r.mes}`,
        `<h3 style="color:#1a3c2a;">Ventas</h3>
         <table style="width:100%;border-collapse:collapse;">
           ${filaKpi('Pedidos realizados', v.pedidos)}
           ${filaKpi('Pedidos cancelados', v.cancelados)}
           ${filaKpi('Ingresos (sin cancelados)', pesos(v.ingresos))}
         </table>
         <h3 style="color:#1a3c2a;">Productos más vendidos</h3>
         ${top}
         <h3 style="color:#1a3c2a;">Atención del chatbot</h3>
         <table style="width:100%;border-collapse:collapse;">
           ${filaKpi('Personas atendidas', r.personas_atendidas)}
           ${filaKpi('Calificación promedio', `${c.promedio} / 5 (${c.total} calificaciones)`)}
         </table>
         <h3 style="color:#1a3c2a;">Satisfacción de compras (encuestas)</h3>
         <table style="width:100%;border-collapse:collapse;">
           ${filaKpi('Promedio', r.satisfaccion_compras && r.satisfaccion_compras.promedio ? `${r.satisfaccion_compras.promedio} / 5` : 'Sin encuestas')}
           ${filaKpi('Encuestas respondidas', r.satisfaccion_compras ? r.satisfaccion_compras.total : 0)}
         </table>
         <h3 style="color:#1a3c2a;">Sugerencias</h3>
         <ul>${r.sugerencias.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`
    );
    return [{ json: { asunto: `📊 Reporte mensual Raíces Andinas - ${r.mes}`, html } }];
}

// ============================================================
// C05 · CENTRO DE MONITOREO DE ERRORES
// ============================================================
function codDiagnostico() {
    const d = $input.first().json;
    const texto = `${d.mensaje} ${d.descripcion}`.toLowerCase();

    // Reglas para identificar la causa más probable y cómo solucionarla
    const reglas = [
        { si: ['535', 'username and password not accepted', 'invalid login'], categoria: 'Gmail', gravedad: 'critica',
          causa: 'Gmail rechazó la contraseña de aplicación.', solucion: 'Crea una nueva contraseña de aplicación en myaccount.google.com/apppasswords y actualízala en la credencial "Gmail Raices Andinas".' },
        { si: ['econnrefused', 'localhost:3000', 'connect etimedout'], categoria: 'Tienda', gravedad: 'critica',
          causa: 'n8n no pudo conectarse con la tienda.', solucion: 'Revisa que la ventana "npm start" esté abierta y que MySQL esté encendido en XAMPP.' },
        { si: ['chat not found', 'bot was blocked', 'telegram'], categoria: 'Telegram', gravedad: 'critica',
          causa: 'Telegram rechazó el mensaje.', solucion: 'Verifica el token del bot y el chat ID en la credencial "Telegram Raices Andinas".' },
        { si: ['503', 'high demand', 'overloaded', 'unavailable'], categoria: 'IA (Gemini)', gravedad: 'media',
          causa: 'Gemini está saturado temporalmente.', solucion: 'Es temporal; n8n reintentará en la próxima ejecución.' },
        { si: ['429', 'quota', 'rate limit'], categoria: 'Límite de uso', gravedad: 'media',
          causa: 'Se superó el límite de uso de un servicio externo.', solucion: 'Espera unos minutos o revisa la cuota del servicio.' },
        { si: ['timeout', 'timed out', 'etimedout'], categoria: 'Tiempo de espera', gravedad: 'baja',
          causa: 'Un servicio tardó demasiado en responder.', solucion: 'Suele ser temporal. Si se repite, revisa la conexión a internet.' }
    ];
    const r = reglas.find(x => x.si.some(p => texto.includes(p)))
        || { categoria: 'Otro', gravedad: 'media', causa: 'Error no clasificado.', solucion: 'Abre la ejecución en n8n para ver el detalle.' };

    const iconos = { critica: '🚨', media: '⚠️', baja: 'ℹ️' };
    const telegram = [
        `${iconos[r.gravedad]} ERROR EN UNA AUTOMATIZACIÓN (${r.gravedad.toUpperCase()})`,
        '',
        `⚙️ Flujo: ${d.flujo}`,
        `📍 Paso que falló: ${d.nodo}`,
        `🏷️ Tipo: ${r.categoria}`,
        `❓ Causa probable: ${r.causa}`,
        `🛠️ Solución: ${r.solucion}`,
        '',
        `📝 ${String(d.mensaje).slice(0, 200)}`,
        d.url ? `🔗 ${d.url}` : ''
    ].join('\n');

    const html = plantillaCorreo(
        `${iconos[r.gravedad]} Error en "${esc(d.flujo)}"`,
        `<p><strong>Paso que falló:</strong> ${esc(d.nodo)}<br><strong>Tipo:</strong> ${esc(r.categoria)}<br><strong>Gravedad:</strong> ${r.gravedad}</p>
         <p><strong>Causa probable:</strong> ${esc(r.causa)}</p>
         <p><strong>Cómo solucionarlo:</strong> ${esc(r.solucion)}</p>
         <p style="background:#fdecea;padding:12px;border-radius:8px;font-family:monospace;font-size:12px;">${esc(d.mensaje)}</p>
         ${d.url ? `<p><a href="${d.url}">Ver la ejecución en n8n</a></p>` : ''}`
    );

    return [{ json: { ...d, ...r, telegram, html, asunto: `${iconos[r.gravedad]} Error en automatización: ${d.flujo}`, es_gmail: r.categoria === 'Gmail' } }];
}

// ============================================================
// CONSTRUCTORES DE NODOS
// ============================================================
function cuerpo(fn) {
    const texto = fn.toString();
    return texto.slice(texto.indexOf('{') + 1, texto.lastIndexOf('}'))
        .split('\n').map(l => l.replace(/^ {4}/, '')).join('\n').trim();
}

const AYUDANTES = cuerpo(ayudantes).replace('__TIENDA_URL__', config.tiendaUrl);
const REINTENTOS = { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 };

const nodo = (nombre, tipo, version, posicion, parametros, extra = {}) => ({
    parameters: parametros, id: crypto.randomUUID(), name: nombre, type: tipo, typeVersion: version, position: posicion, ...extra
});

const condicion = (izquierda, operador, tipo, derecha) => {
    const c = { id: crypto.randomUUID(), leftValue: izquierda, operator: { type: tipo, operation: operador } };
    if (derecha === undefined) c.operator.singleValue = true;
    else c.rightValue = derecha;
    return c;
};

const grupoCondiciones = (condiciones) => ({
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: condiciones,
    combinator: 'and'
});

const N = {
    webhook: (nombre, ruta, pos, conRespuesta = false) => nodo(nombre, 'n8n-nodes-base.webhook', 2, pos, {
        httpMethod: 'POST', path: ruta,
        responseMode: conRespuesta ? 'lastNode' : 'onReceived',
        ...(conRespuesta ? { responseData: 'firstEntryJson' } : {}),
        options: {}
    }, { webhookId: crypto.randomUUID() }),

    programado: (nombre, cron, pos) => nodo(nombre, 'n8n-nodes-base.scheduleTrigger', 1.2, pos, {
        rule: { interval: [{ field: 'cronExpression', expression: cron }] }
    }),

    errorTrigger: (nombre, pos) => nodo(nombre, 'n8n-nodes-base.errorTrigger', 1, pos, {}),

    codigo: (nombre, fn, pos, constantes = '') => nodo(nombre, 'n8n-nodes-base.code', 2, pos, {
        jsCode: `// ----- Funciones de apoyo -----\n${AYUDANTES}\n\n// ----- Lógica de este paso -----\n${constantes}${cuerpo(fn)}`
    }),

    // "Edit Fields": extrae y nombra los datos importantes del evento
    campos: (nombre, campos, pos) => nodo(nombre, 'n8n-nodes-base.set', 3.4, pos, {
        mode: 'manual',
        assignments: {
            assignments: campos.map(([name, value, type = 'string']) => ({ id: crypto.randomUUID(), name, value, type }))
        },
        includeOtherFields: true,
        options: {}
    }),

    si: (nombre, condiciones, pos) => nodo(nombre, 'n8n-nodes-base.if', 2.2, pos, {
        conditions: grupoCondiciones(condiciones), looseTypeValidation: true, options: {}
    }),

    // Switch: cada regla es [nombre de la salida, [condiciones]]
    segun: (nombre, reglas, pos, conRespaldo = false) => nodo(nombre, 'n8n-nodes-base.switch', 3.2, pos, {
        mode: 'rules',
        rules: { values: reglas.map(([salida, condiciones]) => ({ conditions: grupoCondiciones(condiciones), renameOutput: true, outputKey: salida })) },
        looseTypeValidation: true,
        options: conRespaldo ? { fallbackOutput: 'extra', renameFallbackOutput: 'Sin respuesta' } : {}
    }),

    http: (nombre, ruta, pos, { metodo = 'GET', query = [], cuerpoJson = null, siempreDatos = false } = {}) => nodo(nombre, 'n8n-nodes-base.httpRequest', 4.2, pos, {
        method: metodo,
        url: ruta.startsWith('=') ? ruta : `${config.apiUrl}${ruta}`,
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'x-api-key', value: config.apiKey }] },
        sendQuery: query.length > 0,
        queryParameters: { parameters: query.map(([name, value]) => ({ name, value })) },
        ...(cuerpoJson ? { sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: cuerpoJson } : {}),
        options: {}
    }, { retryOnFail: true, maxTries: 2, waitBetweenTries: 2000, ...(siempreDatos ? { alwaysOutputData: true } : {}) }),

    correo: (nombre, para, pos) => nodo(nombre, 'n8n-nodes-base.emailSend', 2.1, pos, {
        fromEmail: `Raíces Andinas <${config.remitente}>`,
        toEmail: para,
        subject: '={{ $json.asunto }}',
        emailFormat: 'html',
        html: '={{ $json.html }}',
        options: { appendAttribution: false }
    }, { ...REINTENTOS, credentials: { smtp: { id: null, name: CREDENCIAL_GMAIL } } }),

    telegram: (nombre, pos, texto = '={{ $json.telegram }}') => nodo(nombre, 'n8n-nodes-base.telegram', 1.2, pos, {
        chatId: config.telegramChatId,
        text: texto,
        additionalFields: { appendAttribution: false }
    }, { ...REINTENTOS, credentials: { telegramApi: { id: null, name: CREDENCIAL_TELEGRAM } } }),

    esperarMinutos: (nombre, expresion, pos) => nodo(nombre, 'n8n-nodes-base.wait', 1.1, pos, {
        resume: 'timeInterval', amount: expresion, unit: 'minutes'
    }, { webhookId: crypto.randomUUID() }),

    // Espera hasta que alguien abra un enlace (aprobación humana), máximo 24 h
    esperarDecision: (nombre, pos) => nodo(nombre, 'n8n-nodes-base.wait', 1.1, pos, {
        resume: 'webhook', httpMethod: 'GET', responseMode: 'responseNode',
        limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 24, resumeUnit: 'hours',
        options: {}
    }, { webhookId: crypto.randomUUID() }),

    responder: (nombre, html, pos) => nodo(nombre, 'n8n-nodes-base.respondToWebhook', 1.1, pos, {
        respondWith: 'text',
        responseBody: html,
        options: { responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] } }
    }),

    agrupar: (nombre, campo, pos) => nodo(nombre, 'n8n-nodes-base.aggregate', 1, pos, {
        aggregate: 'aggregateAllItemData', destinationFieldName: campo, options: {}
    }),

    ordenar: (nombre, campo, pos) => nodo(nombre, 'n8n-nodes-base.sort', 1, pos, {
        sortFieldsUi: { sortField: [{ fieldName: campo, order: 'descending' }] }, options: {}
    }),

    limitar: (nombre, cantidad, pos) => nodo(nombre, 'n8n-nodes-base.limit', 1, pos, { maxItems: cantidad }),

    bucle: (nombre, pos) => nodo(nombre, 'n8n-nodes-base.splitInBatches', 3, pos, { options: {} }),

    unir: (nombre, entradas, pos) => nodo(nombre, 'n8n-nodes-base.merge', 3.1, pos, { mode: 'append', numberInputs: entradas }),

    nada: (nombre, pos) => nodo(nombre, 'n8n-nodes-base.noOp', 1, pos, {}),

    cadenaIA: (nombre, pos) => nodo(nombre, '@n8n/n8n-nodes-langchain.chainLlm', 1.7, pos, {
        promptType: 'define',
        text: '={{ $json.pregunta }}',
        messages: { messageValues: [{ type: 'SystemMessagePromptTemplate', message: '={{ $json.sistema }}' }] }
    }, { retryOnFail: true, maxTries: 2, waitBetweenTries: 2000, onError: 'continueRegularOutput' }),

    gemini: (nombre, pos) => nodo(nombre, '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', 1, pos, {
        modelName: config.modeloGemini,
        options: { temperature: 0.4, maxOutputTokens: 2048 }
    }, { credentials: { googlePalmApi: { id: null, name: CREDENCIAL_GEMINI } } }),

    // Nota de colores (sticky note) que explica cada sección del flujo
    nota: (titulo, texto, pos, ancho, alto, color) => nodo(`Nota: ${titulo}`, 'n8n-nodes-base.stickyNote', 1, pos, {
        content: `## ${titulo}\n${texto}`, width: ancho, height: alto, color
    })
};

// Conexiones: [desde, hacia, { salida, entrada, tipo }]
function conexiones(lista) {
    const resultado = {};
    for (const [desde, hacia, { salida = 0, entrada = 0, tipo = 'main' } = {}] of lista) {
        resultado[desde] = resultado[desde] || {};
        resultado[desde][tipo] = resultado[desde][tipo] || [];
        while (resultado[desde][tipo].length <= salida) resultado[desde][tipo].push([]);
        resultado[desde][tipo][salida].push({ node: hacia, type: tipo, index: entrada });
    }
    return resultado;
}

const central = (id, nombre, nodos, lista, conMonitoreo = true) => ({
    id, name: nombre, nodes: nodos, connections: conexiones(lista),
    settings: { executionOrder: 'v1', timezone: 'America/Bogota', ...(conMonitoreo ? { errorWorkflow: ID_MONITOREO } : {}) },
    pinData: {}
});

const SI = { salida: 0 };
const NO = { salida: 1 };
const salida = (n) => ({ salida: n });

// ============================================================
// C01 · CENTRO DE PEDIDOS Y CLIENTES
// ============================================================
const c01 = central('RaicesAndinasC01', '🛒 C01 · Centro de Pedidos y Clientes', [
    N.nota('🛒 Centro de Pedidos y Clientes', 'Todo el ciclo de vida del cliente y sus pedidos: registro, compra, cambios de estado, cancelaciones, encuesta y seguimiento.\n\nCada sección empieza con un **Webhook**: la tienda avisa a n8n cuando ocurre algo.', [-420, -300], 340, 260, 7),

    // ---- 1. Registro
    N.nota('1. Nuevo cliente', 'Bienvenida por correo + aviso al equipo.', [-60, -170], 1000, 340, 4),
    N.webhook('Webhook: nuevo registro', 'usuario-registrado', [0, 0]),
    N.campos('Datos del nuevo cliente', [['nombre', '={{ $json.body.usuario.nombres }}'], ['correo', '={{ $json.body.usuario.correo }}']], [220, 0]),
    N.codigo('Preparar bienvenida', codRegistro, [440, 0]),
    N.correo('Correo de bienvenida', '={{ $json.para }}', [700, -80]),
    N.telegram('Telegram: nuevo cliente', [700, 80]),

    // ---- 2. Pedido creado
    N.nota('2. Nuevo pedido', 'Consulta el historial del cliente, lo **clasifica** (nuevo / recurrente / VIP) y le envía un correo personalizado. Los pedidos grandes se marcan como **prioritarios**.', [-60, 230], 1640, 620, 5),
    N.webhook('Webhook: pedido creado', 'pedido-creado', [0, 500]),
    N.campos('Datos del pedido', [['cliente_id', '={{ $json.body.cliente.id }}', 'number'], ['pedido_id', '={{ $json.body.pedido.id }}', 'number'], ['total', '={{ $json.body.pedido.total }}', 'number']], [220, 500]),
    N.http('Consultar historial del cliente', '={{ "' + config.apiUrl + '/api/admin/clientes/" + $json.cliente_id + "/historial" }}', [440, 500], { query: [['excluir_pedido', '={{ $json.pedido_id }}']] }),
    N.codigo('Clasificar cliente', codClasificarCliente, [660, 500]),
    N.segun('Tipo de cliente', [
        ['Nuevo', [condicion('={{ $json.tipo }}', 'equals', 'string', 'nuevo')]],
        ['Recurrente', [condicion('={{ $json.tipo }}', 'equals', 'string', 'recurrente')]],
        ['VIP', [condicion('={{ $json.tipo }}', 'equals', 'string', 'vip')]]
    ], [900, 400]),
    N.codigo('Correo: primera compra', codCorreoPedido, [1140, 280], "const TIPO = 'nuevo';\n"),
    N.codigo('Correo: cliente recurrente', codCorreoPedido, [1140, 400], "const TIPO = 'recurrente';\n"),
    N.codigo('Correo: cliente VIP', codCorreoPedido, [1140, 520], "const TIPO = 'vip';\n"),
    N.correo('Enviar confirmación del pedido', '={{ $json.para }}', [1380, 400]),
    N.si('¿Pedido grande? (más de $200.000)', [condicion('={{ $json.total }}', 'gt', 'number', 200000)], [900, 700]),
    N.telegram('Telegram: pedido prioritario', [1140, 660], '={{ $json.telegram_prioritario }}'),
    N.telegram('Telegram: nuevo pedido', [1140, 780]),

    // ---- 3. Cambio de estado
    N.nota('3. Cambio de estado', 'Según el nuevo estado, elige el mensaje correcto para el cliente.', [-60, 890], 1200, 520, 6),
    N.webhook('Webhook: cambio de estado', 'pedido-estado', [0, 1150]),
    N.campos('Datos del cambio', [['estado', '={{ $json.body.pedido.estado_nuevo }}'], ['pedido_id', '={{ $json.body.pedido.id }}', 'number']], [220, 1150]),
    N.segun('¿Qué estado tiene?', [
        ['Confirmado', [condicion('={{ $json.estado }}', 'equals', 'string', 'confirmado')]],
        ['Enviado', [condicion('={{ $json.estado }}', 'equals', 'string', 'enviado')]],
        ['Entregado', [condicion('={{ $json.estado }}', 'equals', 'string', 'entregado')]],
        ['Cancelado', [condicion('={{ $json.estado }}', 'equals', 'string', 'cancelado')]]
    ], [460, 1150]),
    N.codigo('Mensaje: confirmado', codMensajeEstado, [720, 990], "const ESTADO = 'confirmado';\n"),
    N.codigo('Mensaje: enviado', codMensajeEstado, [720, 1100], "const ESTADO = 'enviado';\n"),
    N.codigo('Mensaje: entregado', codMensajeEstado, [720, 1210], "const ESTADO = 'entregado';\n"),
    N.codigo('Mensaje: cancelado', codMensajeEstado, [720, 1320], "const ESTADO = 'cancelado';\n"),
    N.correo('Correo de estado al cliente', '={{ $json.para }}', [960, 1150]),

    // ---- 4. Cancelación
    N.nota('4. Pedido cancelado', 'Avisa al equipo. Si el pedido ya había salido de bodega, lo marca como **cancelación tardía**.', [-60, 1450], 1200, 340, 3),
    N.webhook('Webhook: pedido cancelado', 'pedido-cancelado', [0, 1620]),
    N.campos('Datos de la cancelación', [['estado_anterior', '={{ $json.body.pedido.estado_anterior }}']], [220, 1620]),
    N.si('¿Ya había sido despachado?', [condicion('={{ ["enviado", "entregado"].includes($json.estado_anterior) }}', 'true', 'boolean')], [460, 1620]),
    N.codigo('Alerta: cancelación tardía', codAvisoCancelacion, [720, 1540], 'const TARDIA = true;\n'),
    N.codigo('Aviso de cancelación', codAvisoCancelacion, [720, 1700], 'const TARDIA = false;\n'),
    N.telegram('Telegram: pedido cancelado', [960, 1620]),

    // ---- 5. Entrega y encuesta
    N.nota('5. Entrega → encuesta', 'Espera unos días, **verifica** si el cliente ya calificó y solo entonces le envía la encuesta.', [-60, 1830], 1660, 360, 4),
    N.webhook('Webhook: pedido entregado', 'pedido-entregado', [0, 2010]),
    N.esperarMinutos('Esperar antes de la encuesta', '={{ $json.body.esperar_minutos }}', [220, 2010]),
    N.campos('Preparar consulta', [['pedido_id', '={{ $json.body.pedido.id }}', 'number'], ['token', '={{ $json.body.enlace_encuesta.split("token=")[1] }}']], [440, 2010]),
    N.http('¿Ya calificó la compra?', '={{ "' + config.apiUrl + '/api/encuestas/" + $json.pedido_id }}', [660, 2010], { query: [['token', '={{ $json.token }}']] }),
    N.si('¿Encuesta pendiente?', [condicion('={{ $json.respondida }}', 'false', 'boolean')], [900, 2010]),
    N.codigo('Preparar encuesta', codPrepararEncuesta, [1140, 1940]),
    N.correo('Correo con la encuesta', '={{ $json.para }}', [1380, 1940]),
    N.nada('Ya calificó: no enviar', [1140, 2100]),

    // ---- 6. Seguimiento de la encuesta
    N.nota('6. Seguimiento de la encuesta', 'Responde según la nota: **disculpa** (1-2 ⭐), **queremos mejorar** (3 ⭐) o **agradecimiento** (4-5 ⭐). Las notas malas alertan al equipo.', [-60, 2230], 1200, 560, 2),
    N.webhook('Webhook: encuesta respondida', 'encuesta-respondida', [0, 2480]),
    N.campos('Datos de la calificación', [['puntuacion', '={{ $json.body.puntuacion }}', 'number']], [220, 2480]),
    N.segun('Nivel de satisfacción', [
        ['Mala (1-2)', [condicion('={{ $json.puntuacion }}', 'lte', 'number', 2)]],
        ['Regular (3)', [condicion('={{ $json.puntuacion }}', 'equals', 'number', 3)]],
        ['Buena (4-5)', [condicion('={{ $json.puntuacion }}', 'gte', 'number', 4)]]
    ], [460, 2480]),
    N.codigo('Correo: disculpa', codSeguimientoEncuesta, [720, 2360], "const NIVEL = 'mala';\n"),
    N.codigo('Correo: queremos mejorar', codSeguimientoEncuesta, [720, 2480], "const NIVEL = 'regular';\n"),
    N.codigo('Correo: agradecimiento', codSeguimientoEncuesta, [720, 2600], "const NIVEL = 'buena';\n"),
    N.correo('Correo de seguimiento', '={{ $json.para }}', [960, 2480]),
    N.codigo('Alerta: compra mal calificada', codAlertaEncuesta, [720, 2720]),
    N.telegram('Telegram al equipo', [960, 2720])
], [
    ['Webhook: nuevo registro', 'Datos del nuevo cliente'],
    ['Datos del nuevo cliente', 'Preparar bienvenida'],
    ['Preparar bienvenida', 'Correo de bienvenida'],
    ['Preparar bienvenida', 'Telegram: nuevo cliente'],

    ['Webhook: pedido creado', 'Datos del pedido'],
    ['Datos del pedido', 'Consultar historial del cliente'],
    ['Consultar historial del cliente', 'Clasificar cliente'],
    ['Clasificar cliente', 'Tipo de cliente'],
    ['Clasificar cliente', '¿Pedido grande? (más de $200.000)'],
    ['Tipo de cliente', 'Correo: primera compra', salida(0)],
    ['Tipo de cliente', 'Correo: cliente recurrente', salida(1)],
    ['Tipo de cliente', 'Correo: cliente VIP', salida(2)],
    ['Correo: primera compra', 'Enviar confirmación del pedido'],
    ['Correo: cliente recurrente', 'Enviar confirmación del pedido'],
    ['Correo: cliente VIP', 'Enviar confirmación del pedido'],
    ['¿Pedido grande? (más de $200.000)', 'Telegram: pedido prioritario', SI],
    ['¿Pedido grande? (más de $200.000)', 'Telegram: nuevo pedido', NO],

    ['Webhook: cambio de estado', 'Datos del cambio'],
    ['Datos del cambio', '¿Qué estado tiene?'],
    ['¿Qué estado tiene?', 'Mensaje: confirmado', salida(0)],
    ['¿Qué estado tiene?', 'Mensaje: enviado', salida(1)],
    ['¿Qué estado tiene?', 'Mensaje: entregado', salida(2)],
    ['¿Qué estado tiene?', 'Mensaje: cancelado', salida(3)],
    ['Mensaje: confirmado', 'Correo de estado al cliente'],
    ['Mensaje: enviado', 'Correo de estado al cliente'],
    ['Mensaje: entregado', 'Correo de estado al cliente'],
    ['Mensaje: cancelado', 'Correo de estado al cliente'],

    ['Webhook: pedido cancelado', 'Datos de la cancelación'],
    ['Datos de la cancelación', '¿Ya había sido despachado?'],
    ['¿Ya había sido despachado?', 'Alerta: cancelación tardía', SI],
    ['¿Ya había sido despachado?', 'Aviso de cancelación', NO],
    ['Alerta: cancelación tardía', 'Telegram: pedido cancelado'],
    ['Aviso de cancelación', 'Telegram: pedido cancelado'],

    ['Webhook: pedido entregado', 'Esperar antes de la encuesta'],
    ['Esperar antes de la encuesta', 'Preparar consulta'],
    ['Preparar consulta', '¿Ya calificó la compra?'],
    ['¿Ya calificó la compra?', '¿Encuesta pendiente?'],
    ['¿Encuesta pendiente?', 'Preparar encuesta', SI],
    ['¿Encuesta pendiente?', 'Ya calificó: no enviar', NO],
    ['Preparar encuesta', 'Correo con la encuesta'],

    ['Webhook: encuesta respondida', 'Datos de la calificación'],
    ['Datos de la calificación', 'Nivel de satisfacción'],
    ['Nivel de satisfacción', 'Correo: disculpa', salida(0)],
    ['Nivel de satisfacción', 'Alerta: compra mal calificada', salida(0)],
    ['Nivel de satisfacción', 'Correo: queremos mejorar', salida(1)],
    ['Nivel de satisfacción', 'Correo: agradecimiento', salida(2)],
    ['Correo: disculpa', 'Correo de seguimiento'],
    ['Correo: queremos mejorar', 'Correo de seguimiento'],
    ['Correo: agradecimiento', 'Correo de seguimiento'],
    ['Alerta: compra mal calificada', 'Telegram al equipo']
]);

// ============================================================
// C02 · CENTRO DE INVENTARIO
// ============================================================
const PAGINA = (titulo, texto, color) => `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title></head>` +
    `<body style="margin:0;font-family:Arial,sans-serif;background:#f7f5f0;display:flex;align-items:center;justify-content:center;min-height:100vh;">` +
    `<div style="background:#fff;max-width:460px;padding:40px;border-radius:16px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.08);">` +
    `<div style="font-size:56px;">${color}</div><h1 style="color:#1a3c2a;">${titulo}</h1><p style="color:#555;line-height:1.6;">${texto}</p>` +
    `<a href="${config.tiendaUrl}/admin.html" style="display:inline-block;margin-top:16px;background:#1a3c2a;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;">Ir al panel admin</a></div></body></html>`;

const c02 = central('RaicesAndinasC02', '📦 C02 · Centro de Inventario', [
    N.nota('📦 Centro de Inventario', 'Cuando una venta deja productos en su stock mínimo, n8n **analiza las ventas**, calcula cuánto comprar, redacta la orden con **IA** y **espera la aprobación del dueño**. Si aprueba, **actualiza el inventario de la tienda** y envía la orden al proveedor.', [-420, -420], 340, 330, 7),
    N.nota('1. Analizar cada producto (bucle)', 'Recorre los productos uno por uno y consulta sus ventas de los últimos 30 días.', [-60, -300], 1160, 560, 4),
    N.webhook('Webhook: stock bajo', 'stock-bajo', [0, 0]),
    N.codigo('Separar productos', codSepararProductos, [220, 0]),
    N.bucle('Recorrer productos', [440, 0]),
    N.http('Ventas de los últimos 30 días', '={{ "' + config.apiUrl + '/api/admin/ventas-productos" }}', [680, 140], { query: [['dias', '30'], ['producto', '={{ $json.id }}']] }),
    N.codigo('Calcular cantidad sugerida', codCantidadSugerida, [900, 140]),
    N.agrupar('Unir productos analizados', 'productos', [680, -140]),

    N.nota('2. Solicitar aprobación (IA + correo)', 'Avisa por Telegram, redacta la orden de compra con **Gemini** y envía al dueño un correo con botones **Aprobar / Rechazar**.', [1120, -300], 1200, 560, 5),
    N.codigo('Preparar solicitud de aprobación', codPrepararSolicitud, [1180, -140]),
    N.telegram('Telegram: alerta de stock', [1420, -260]),
    N.cadenaIA('IA: redactar orden de compra', [1420, -100]),
    N.gemini('Modelo Gemini', [1420, 100]),
    N.codigo('Armar correo de aprobación', codCorreoAprobacion, [1700, -100]),
    N.correo('Correo: pedir aprobación al dueño', config.adminEmail, [1960, -100]),

    N.nota('3. Esperar la decisión del dueño', 'El flujo **se pausa** hasta que el dueño pulse un botón del correo (máximo 24 h).', [2340, -300], 520, 560, 3),
    N.esperarDecision('Esperar decisión (máx. 24 h)', [2400, -100]),
    N.segun('Decisión del dueño', [
        ['Aprobado', [condicion('={{ $json.query && $json.query.decision }}', 'equals', 'string', 'aprobar')]],
        ['Rechazado', [condicion('={{ $json.query && $json.query.decision }}', 'equals', 'string', 'rechazar')]]
    ], [2640, -100], true),

    N.nota('4. Ejecutar la decisión', '**Aprobado:** suma el stock en la tienda, envía la orden al proveedor y confirma.\n**Rechazado o sin respuesta:** avisa al equipo.', [2880, -420], 1420, 760, 6),
    N.responder('Página: compra aprobada', PAGINA('Compra aprobada ✅', 'El inventario se está actualizando y la orden de compra se enviará al proveedor. Te llegará la confirmación por Telegram.', '✅'), [2940, -280]),
    N.codigo('Preparar reabastecimiento', codPrepararReabastecimiento, [3160, -280]),
    N.http('Actualizar stock en la tienda', '={{ "' + config.apiUrl + '/api/admin/productos/" + $json.id + "/reabastecer" }}', [3380, -280], { metodo: 'POST', cuerpoJson: '={{ JSON.stringify({ cantidad: $json.cantidad }) }}' }),
    N.agrupar('Resumen del reabastecimiento', 'resultados', [3600, -280]),
    N.codigo('Orden de compra al proveedor', codOrdenProveedor, [3820, -280]),
    N.correo('Correo: orden al proveedor', config.proveedorEmail, [4060, -360]),
    N.telegram('Telegram: compra aprobada', [4060, -200]),
    N.responder('Página: compra rechazada', PAGINA('Compra rechazada', 'No se hará ningún pedido al proveedor. Puedes reabastecer manualmente desde el panel admin.', '❌'), [2940, -40]),
    N.telegram('Telegram: compra rechazada', [3160, -40], '={{ "❌ Compra RECHAZADA por el dueño:\\n" + $("Preparar solicitud de aprobación").first().json.resumen }}'),
    N.telegram('Telegram: sin respuesta en 24 h', [2940, 160], '={{ "⏰ Nadie aprobó la compra en 24 h y se canceló:\\n" + $("Preparar solicitud de aprobación").first().json.resumen }}')
], [
    ['Webhook: stock bajo', 'Separar productos'],
    ['Separar productos', 'Recorrer productos'],
    ['Recorrer productos', 'Unir productos analizados', salida(0)],
    ['Recorrer productos', 'Ventas de los últimos 30 días', salida(1)],
    ['Ventas de los últimos 30 días', 'Calcular cantidad sugerida'],
    ['Calcular cantidad sugerida', 'Recorrer productos'],
    ['Unir productos analizados', 'Preparar solicitud de aprobación'],
    ['Preparar solicitud de aprobación', 'Telegram: alerta de stock'],
    ['Preparar solicitud de aprobación', 'IA: redactar orden de compra'],
    ['Modelo Gemini', 'IA: redactar orden de compra', { tipo: 'ai_languageModel' }],
    ['IA: redactar orden de compra', 'Armar correo de aprobación'],
    ['Armar correo de aprobación', 'Correo: pedir aprobación al dueño'],
    ['Correo: pedir aprobación al dueño', 'Esperar decisión (máx. 24 h)'],
    ['Esperar decisión (máx. 24 h)', 'Decisión del dueño'],
    ['Decisión del dueño', 'Página: compra aprobada', salida(0)],
    ['Decisión del dueño', 'Página: compra rechazada', salida(1)],
    ['Decisión del dueño', 'Telegram: sin respuesta en 24 h', salida(2)],
    ['Página: compra aprobada', 'Preparar reabastecimiento'],
    ['Preparar reabastecimiento', 'Actualizar stock en la tienda'],
    ['Actualizar stock en la tienda', 'Resumen del reabastecimiento'],
    ['Resumen del reabastecimiento', 'Orden de compra al proveedor'],
    ['Orden de compra al proveedor', 'Correo: orden al proveedor'],
    ['Orden de compra al proveedor', 'Telegram: compra aprobada'],
    ['Página: compra rechazada', 'Telegram: compra rechazada']
]);

// ============================================================
// C03 · CENTRO DE ATENCIÓN AL CLIENTE
// ============================================================
const c03 = central('RaicesAndinasC03', '💬 C03 · Centro de Atención al Cliente', [
    N.nota('💬 Centro de Atención al Cliente', 'Chatbot con **inteligencia artificial**, solicitudes de asesor humano, calificaciones del chat y recuperación de contraseña.', [-420, -260], 340, 220, 7),

    N.nota('1. Chatbot con IA (responde en vivo)', 'La tienda **espera** la respuesta. Si Gemini falla, se devuelve vacío y la tienda usa su menú de respaldo.', [-60, -230], 1440, 520, 5),
    N.webhook('Webhook: pregunta al chatbot', 'chatbot-ia', [0, 0], true),
    N.campos('Datos de la pregunta', [['idioma', '={{ $json.body.idioma }}'], ['mensaje', '={{ $json.body.mensaje }}']], [220, 0]),
    N.codigo('Preparar contexto para la IA', codContextoIA, [440, 0]),
    N.cadenaIA('IA: responder al cliente', [680, 0]),
    N.gemini('Modelo Gemini', [680, 200]),
    N.si('¿La IA respondió?', [condicion('={{ $json.text }}', 'notEmpty', 'string')], [960, 0]),
    N.codigo('Formatear respuesta', codFormatearRespuesta, [1200, -90]),
    N.codigo('Respuesta vacía (usar menú)', codRespuestaVacia, [1200, 90]),

    N.nota('2. El cliente pide un asesor', 'Si tiene cuenta: alerta con sus datos + correo de confirmación. Si es visitante: alerta sin datos.', [-60, 330], 1200, 460, 4),
    N.webhook('Webhook: piden asesor', 'chat-asesor', [0, 560]),
    N.campos('Datos del chat', [['tiene_cuenta', '={{ !!($json.body.cliente && $json.body.cliente.correo) }}', 'boolean']], [220, 560]),
    N.si('¿Tiene cuenta?', [condicion('={{ $json.tiene_cuenta }}', 'true', 'boolean')], [440, 560]),
    N.codigo('Alerta: cliente registrado', codAlertaAsesorCliente, [700, 440]),
    N.codigo('Correo: un asesor te contactará', codCorreoAsesor, [700, 580]),
    N.codigo('Alerta: visitante', codAlertaAsesorVisitante, [700, 720]),
    N.telegram('Telegram: solicitud de asesor', [960, 520]),
    N.correo('Correo de confirmación al cliente', '={{ $json.para }}', [960, 680]),

    N.nota('3. Calificación baja del chat', 'Las calificaciones de 1-2 ⭐ se avisan al equipo.', [-60, 830], 1000, 300, 3),
    N.webhook('Webhook: calificación baja', 'calificacion-baja', [0, 980]),
    N.campos('Datos de la calificación', [['puntuacion', '={{ $json.body.puntuacion }}', 'number']], [220, 980]),
    N.codigo('Armar alerta de calificación', codAlertaCalificacionChat, [440, 980]),
    N.telegram('Telegram: calificación baja', [700, 980]),

    N.nota('4. Recuperar contraseña', 'Envía el enlace seguro (vence en 30 min, un solo uso).', [-60, 1170], 1000, 300, 2),
    N.webhook('Webhook: recuperar contraseña', 'password-reset', [0, 1320]),
    N.campos('Datos de la solicitud', [['correo', '={{ $json.body.usuario.correo }}']], [220, 1320]),
    N.codigo('Preparar correo de recuperación', codCorreoRecuperacion, [440, 1320]),
    N.correo('Correo con enlace seguro', '={{ $json.para }}', [700, 1320])
], [
    ['Webhook: pregunta al chatbot', 'Datos de la pregunta'],
    ['Datos de la pregunta', 'Preparar contexto para la IA'],
    ['Preparar contexto para la IA', 'IA: responder al cliente'],
    ['Modelo Gemini', 'IA: responder al cliente', { tipo: 'ai_languageModel' }],
    ['IA: responder al cliente', '¿La IA respondió?'],
    ['¿La IA respondió?', 'Formatear respuesta', SI],
    ['¿La IA respondió?', 'Respuesta vacía (usar menú)', NO],

    ['Webhook: piden asesor', 'Datos del chat'],
    ['Datos del chat', '¿Tiene cuenta?'],
    ['¿Tiene cuenta?', 'Alerta: cliente registrado', SI],
    ['¿Tiene cuenta?', 'Correo: un asesor te contactará', SI],
    ['¿Tiene cuenta?', 'Alerta: visitante', NO],
    ['Alerta: cliente registrado', 'Telegram: solicitud de asesor'],
    ['Alerta: visitante', 'Telegram: solicitud de asesor'],
    ['Correo: un asesor te contactará', 'Correo de confirmación al cliente'],

    ['Webhook: calificación baja', 'Datos de la calificación'],
    ['Datos de la calificación', 'Armar alerta de calificación'],
    ['Armar alerta de calificación', 'Telegram: calificación baja'],

    ['Webhook: recuperar contraseña', 'Datos de la solicitud'],
    ['Datos de la solicitud', 'Preparar correo de recuperación'],
    ['Preparar correo de recuperación', 'Correo con enlace seguro']
]);

// ============================================================
// C04 · CENTRO DE REPORTES E INTELIGENCIA
// ============================================================
const c04 = central('RaicesAndinasC04', '📊 C04 · Centro de Reportes e Inteligencia', [
    N.nota('📊 Centro de Reportes e Inteligencia', 'Reportes **programados** (se ejecutan solos a una hora fija): resumen diario, cierre del día, informe semanal con **analista de IA** y reporte mensual.', [-420, -260], 340, 240, 7),

    N.nota('1. Resumen diario (8:00 am)', 'Solo envía mensaje si hay algo que atender.', [-60, -230], 1060, 420, 4),
    N.programado('Cada día 8:00 am', '0 8 * * *', [0, 0]),
    N.http('Consultar inventario y pedidos', '/api/admin/resumen-diario', [220, 0], { query: [['horas', '48']] }),
    N.si('¿Hay algo que reportar?', [condicion('={{ $json.stock_bajo.length + $json.pedidos_atrasados.length }}', 'gt', 'number', 0)], [440, 0]),
    N.codigo('Armar resumen diario', codResumenDiario, [680, -80]),
    N.telegram('Telegram: resumen diario', [900, -80]),
    N.nada('Todo en orden', [680, 100]),

    N.nota('2. Cierre del día (8:00 pm)', 'Ventas del día comparadas con ayer.', [-60, 230], 1060, 280, 6),
    N.programado('Cada día 8:00 pm', '0 20 * * *', [0, 380]),
    N.http('Consultar ventas del día', '/api/admin/cierre-dia', [220, 380]),
    N.codigo('Armar cierre del día', codCierreDia, [440, 380]),
    N.telegram('Telegram: cierre del día', [680, 380]),

    N.nota('3. Analista semanal con IA (lunes 9:00 am)', 'Consulta **3 fuentes en paralelo**, las une, calcula indicadores y le pide a **Gemini** un análisis con recomendaciones. Envía el informe y, si hay problemas graves, una alerta urgente.', [-60, 550], 2420, 640, 5),
    N.programado('Cada lunes 9:00 am', '0 9 * * 1', [0, 880]),
    N.http('Indicadores de la semana', '/api/admin/indicadores', [240, 700], { query: [['dias', '7']] }),
    N.http('Ventas por producto (7 días)', '/api/admin/ventas-productos', [240, 880], { query: [['dias', '7']], siempreDatos: true }),
    N.ordenar('Ordenar por unidades vendidas', 'unidades', [460, 880]),
    N.limitar('Top 5 productos', 5, [680, 880]),
    N.agrupar('Unir top 5', 'productos', [900, 880]),
    N.http('Estado del inventario', '/api/admin/resumen-diario', [240, 1060], { query: [['horas', '48']] }),
    N.unir('Unir las 3 fuentes', 3, [1120, 880]),
    N.codigo('Calcular indicadores clave', codCalcularKpis, [1340, 880]),
    N.cadenaIA('IA: analista de negocio', [1580, 880]),
    N.gemini('Modelo Gemini', [1580, 1070]),
    N.codigo('Armar informe ejecutivo', codInformeSemanal, [1840, 880]),
    N.correo('Correo: informe semanal', config.adminEmail, [2080, 720]),
    N.telegram('Telegram: resumen semanal', [2080, 880]),
    N.si('¿Hay alertas críticas?', [condicion('={{ $json.hay_alertas }}', 'true', 'boolean')], [2080, 1040]),
    N.telegram('Telegram: alerta urgente', [2300, 1040], '={{ $json.telegram_alerta }}'),

    N.nota('4. Reporte mensual (día 1, 7:00 am)', 'Resume el mes anterior y lo envía por correo.', [-60, 1230], 1060, 280, 3),
    N.programado('Día 1 de cada mes 7:00 am', '0 7 1 * *', [0, 1380]),
    N.http('Consultar reporte del mes anterior', '/api/reportes/mensual', [220, 1380], {
        query: [['mes', '={{ $now.minus({ months: 1 }).month }}'], ['anio', '={{ $now.minus({ months: 1 }).year }}']]
    }),
    N.codigo('Armar reporte mensual', codReporteMensual, [440, 1380]),
    N.correo('Correo: reporte mensual', config.adminEmail, [680, 1380])
], [
    ['Cada día 8:00 am', 'Consultar inventario y pedidos'],
    ['Consultar inventario y pedidos', '¿Hay algo que reportar?'],
    ['¿Hay algo que reportar?', 'Armar resumen diario', SI],
    ['¿Hay algo que reportar?', 'Todo en orden', NO],
    ['Armar resumen diario', 'Telegram: resumen diario'],

    ['Cada día 8:00 pm', 'Consultar ventas del día'],
    ['Consultar ventas del día', 'Armar cierre del día'],
    ['Armar cierre del día', 'Telegram: cierre del día'],

    ['Cada lunes 9:00 am', 'Indicadores de la semana'],
    ['Cada lunes 9:00 am', 'Ventas por producto (7 días)'],
    ['Cada lunes 9:00 am', 'Estado del inventario'],
    ['Ventas por producto (7 días)', 'Ordenar por unidades vendidas'],
    ['Ordenar por unidades vendidas', 'Top 5 productos'],
    ['Top 5 productos', 'Unir top 5'],
    ['Indicadores de la semana', 'Unir las 3 fuentes', { entrada: 0 }],
    ['Unir top 5', 'Unir las 3 fuentes', { entrada: 1 }],
    ['Estado del inventario', 'Unir las 3 fuentes', { entrada: 2 }],
    ['Unir las 3 fuentes', 'Calcular indicadores clave'],
    ['Calcular indicadores clave', 'IA: analista de negocio'],
    ['Modelo Gemini', 'IA: analista de negocio', { tipo: 'ai_languageModel' }],
    ['IA: analista de negocio', 'Armar informe ejecutivo'],
    ['Armar informe ejecutivo', 'Correo: informe semanal'],
    ['Armar informe ejecutivo', 'Telegram: resumen semanal'],
    ['Armar informe ejecutivo', '¿Hay alertas críticas?'],
    ['¿Hay alertas críticas?', 'Telegram: alerta urgente', SI],

    ['Día 1 de cada mes 7:00 am', 'Consultar reporte del mes anterior'],
    ['Consultar reporte del mes anterior', 'Armar reporte mensual'],
    ['Armar reporte mensual', 'Correo: reporte mensual']
]);

// ============================================================
// C05 · CENTRO DE MONITOREO DE ERRORES
// ============================================================
const c05 = central(ID_MONITOREO, '🛡️ C05 · Centro de Monitoreo de Errores', [
    N.nota('🛡️ Centro de Monitoreo de Errores', 'Se activa **solo** cuando cualquiera de las otras centrales falla. Identifica la causa probable, decide la gravedad y avisa con la solución.\n\nAdemás, todos los correos y mensajes de Telegram se **reintentan 3 veces** antes de fallar.', [-420, -300], 340, 300, 7),
    N.nota('Diagnóstico y aviso', 'Si el error es de Gmail, no se avisa por correo (porque Gmail es lo que falla).', [-60, -300], 1500, 680, 3),
    N.errorTrigger('Cuando falla una automatización', [0, 0]),
    N.campos('Datos del error', [
        ['flujo', '={{ $json.workflow.name }}'],
        ['nodo', '={{ $json.execution.lastNodeExecuted || "desconocido" }}'],
        ['mensaje', '={{ ($json.execution.error && $json.execution.error.message) || "sin mensaje" }}'],
        ['descripcion', '={{ ($json.execution.error && $json.execution.error.description) || "" }}'],
        ['url', '={{ $json.execution.url || "" }}']
    ], [220, 0]),
    N.codigo('Diagnosticar la causa', codDiagnostico, [440, 0]),
    N.segun('Según la gravedad', [
        ['Crítica', [condicion('={{ $json.gravedad }}', 'equals', 'string', 'critica')]],
        ['Media', [condicion('={{ $json.gravedad }}', 'equals', 'string', 'media')]],
        ['Baja', [condicion('={{ $json.gravedad }}', 'equals', 'string', 'baja')]]
    ], [680, 0]),
    N.telegram('Telegram: error crítico', [940, -180]),
    N.si('¿El error es de Gmail?', [condicion('={{ $json.es_gmail }}', 'true', 'boolean')], [940, -20]),
    N.nada('No usar correo (Gmail falla)', [1180, -100]),
    N.correo('Correo: reporte del error', config.adminEmail, [1180, 60]),
    N.telegram('Telegram: error', [940, 160]),
    N.nada('Solo registrar (error leve)', [940, 300])
], [
    ['Cuando falla una automatización', 'Datos del error'],
    ['Datos del error', 'Diagnosticar la causa'],
    ['Diagnosticar la causa', 'Según la gravedad'],
    ['Según la gravedad', 'Telegram: error crítico', salida(0)],
    ['Según la gravedad', '¿El error es de Gmail?', salida(0)],
    ['Según la gravedad', 'Telegram: error', salida(1)],
    ['Según la gravedad', 'Solo registrar (error leve)', salida(2)],
    ['¿El error es de Gmail?', 'No usar correo (Gmail falla)', SI],
    ['¿El error es de Gmail?', 'Correo: reporte del error', NO]
], false);

// ============================================================
// GENERAR ARCHIVOS
// ============================================================
const centrales = { 'C05-monitoreo-errores': c05, 'C01-pedidos-clientes': c01, 'C02-inventario': c02, 'C03-atencion-cliente': c03, 'C04-reportes-inteligencia': c04 };

if (require.main === module) {
    fs.mkdirSync(CARPETA_SALIDA, { recursive: true });
    for (const [archivo, flujo] of Object.entries(centrales)) {
        // Validación: toda conexión debe apuntar a un nodo que exista
        const nombres = new Set(flujo.nodes.map(n => n.name));
        if (nombres.size !== flujo.nodes.length) throw new Error(`${archivo}: hay nodos con nombre repetido`);
        for (const [desde, tipos] of Object.entries(flujo.connections)) {
            if (!nombres.has(desde)) throw new Error(`${archivo}: conexión desde nodo inexistente "${desde}"`);
            for (const salidas of Object.values(tipos)) for (const s of salidas) for (const c of s) {
                if (!nombres.has(c.node)) throw new Error(`${archivo}: conexión hacia nodo inexistente "${c.node}"`);
            }
        }
        fs.writeFileSync(path.join(CARPETA_SALIDA, `${archivo}.json`), JSON.stringify(flujo, null, 2));
        const cajas = flujo.nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote').length;
        const tipos = new Set(flujo.nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote').map(n => n.type)).size;
        console.log(`✅ ${archivo}.json · ${cajas} cajas · ${tipos} tipos de herramienta`);
    }
}

module.exports = { centrales };
