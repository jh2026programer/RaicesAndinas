// automatizaciones/n8n/generar-flujos.js
// Genera los flujos de n8n (archivos .json) listos para importar.
// Toma los datos del archivo .env (correo del admin, chat de Telegram, etc.).
//
// Uso:  npm run n8n:flujos
// Luego en n8n: Crear flujo → menú "..." → "Import from File" → elegir el .json

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
    telegramChatId: process.env.ADMIN_TELEGRAM_CHAT_ID || 'TU_CHAT_ID_DE_TELEGRAM',
    tiendaUrl: process.env.TIENDA_URL || 'http://localhost:3000',
    apiUrl: `http://localhost:${process.env.PORT || 3000}`,
    apiKey: process.env.AUTOMATION_API_KEY || '',
    modeloGemini: process.env.GEMINI_MODELO || 'models/gemini-3.8-flash'
};

// Nombres EXACTOS que deben tener las credenciales creadas en n8n.
// Al importar por terminal (npm run n8n:instalar), n8n las enlaza por nombre.
const CREDENCIAL_GMAIL = 'Gmail Raices Andinas';
const CREDENCIAL_TELEGRAM = 'Telegram Raices Andinas';
const CREDENCIAL_GEMINI = 'Gemini Raices Andinas';

const CARPETA_SALIDA = path.join(__dirname, 'flujos');

// ============================================
// CÓDIGO DE LOS NODOS "Code" (JavaScript que se ejecuta dentro de n8n)
// Se escriben como funciones normales y se copia solo su cuerpo.
// ============================================

// Funciones de apoyo que se incluyen al inicio de cada nodo Code
function ayudantes() {
    const TIENDA_URL = '__TIENDA_URL__';

    const pesos = (valor) => new Intl.NumberFormat('es-CO', {
        style: 'currency', currency: 'COP', maximumFractionDigits: 0
    }).format(Number(valor) || 0);

    // Evita que datos escritos por usuarios rompan el HTML del correo
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
}

function codigoPedidoCreado() {
    const { pedido, cliente } = $input.first().json.body;

    const html = plantillaCorreo(
        `¡Gracias por tu compra, ${esc(cliente.nombres)}!`,
        `<p>Recibimos tu pedido <strong>#${pedido.id}</strong> y ya lo estamos preparando.</p>
         ${tablaItems(pedido.items)}
         <p style="text-align:right;margin:4px 0;">Subtotal: ${pesos(pedido.subtotal ?? pedido.total)}</p>
         <p style="text-align:right;margin:4px 0;">Envío: ${pedido.costo_envio > 0 ? pesos(pedido.costo_envio) : '<strong style="color:#2f855a">GRATIS</strong>'}</p>
         <p style="font-size:18px;text-align:right;"><strong>Total: ${pesos(pedido.total)}</strong></p>
         <p><strong>Dirección de envío:</strong> ${esc(pedido.direccion_envio)}<br>
            <strong>Método de pago:</strong> ${esc(pedido.metodo_pago)}</p>
         <p>Te avisaremos por correo cada vez que tu pedido cambie de estado.</p>`
    );

    const telegram = [
        `🛒 NUEVO PEDIDO #${pedido.id}`,
        ``,
        `👤 ${cliente.nombres} ${cliente.apellidos || ''}`,
        `📧 ${cliente.correo}${cliente.telefono ? `\n📱 ${cliente.telefono}` : ''}`,
        ``,
        ...pedido.items.map(i => `• ${i.cantidad} x ${i.nombre} = ${pesos(i.subtotal)}`),
        ``,
        `🚚 Envío: ${pedido.costo_envio > 0 ? pesos(pedido.costo_envio) : 'gratis'}`,
        `💰 Total: ${pesos(pedido.total)}`,
        `💳 ${pedido.metodo_pago}`,
        `📍 ${pedido.direccion_envio}`
    ].join('\n');

    return [{
        json: {
            para: cliente.correo,
            asunto: `✅ Confirmación de tu pedido #${pedido.id} - Raíces Andinas`,
            html,
            telegram
        }
    }];
}

function codigoPedidoEstado() {
    const { pedido, cliente } = $input.first().json.body;

    const mensajes = {
        confirmado: {
            asunto: `👍 Tu pedido #${pedido.id} fue confirmado`,
            texto: 'Confirmamos tu pedido y ya estamos alistando tus productos.'
        },
        enviado: {
            asunto: `🚚 Tu pedido #${pedido.id} va en camino`,
            texto: 'Tu pedido salió de nuestra bodega. El tiempo estimado de entrega es de 3 a 5 días hábiles.'
        },
        entregado: {
            asunto: `🎉 Tu pedido #${pedido.id} fue entregado`,
            texto: '¡Tu pedido fue entregado! Esperamos que disfrutes tus productos andinos. Gracias por confiar en nosotros.'
        },
        cancelado: {
            asunto: `❌ Tu pedido #${pedido.id} fue cancelado`,
            texto: 'Tu pedido fue cancelado. Si no solicitaste la cancelación o tienes dudas, responde a este correo o escríbenos a soporte.'
        }
    };

    const mensaje = mensajes[pedido.estado_nuevo];
    // Para "pendiente" no se envía correo: terminar el flujo sin hacer nada
    if (!mensaje) return [];

    const html = plantillaCorreo(
        `Hola ${esc(cliente.nombres)}, tu pedido cambió de estado`,
        `<p>${mensaje.texto}</p>
         <p style="font-size:16px;">Estado actual: <strong style="text-transform:uppercase;color:#1a3c2a;">${esc(pedido.estado_nuevo)}</strong></p>
         ${tablaItems(pedido.items)}
         <p style="text-align:right;"><strong>Total: ${pesos(pedido.total)}</strong></p>`
    );

    return [{ json: { para: cliente.correo, asunto: mensaje.asunto, html } }];
}

function codigoResumenDiario() {
    const { stock_bajo, pedidos_atrasados, horas_limite } = $input.first().json;

    // Si no hay nada que reportar, no se envía mensaje
    if (stock_bajo.length === 0 && pedidos_atrasados.length === 0) return [];

    const lineas = ['☀️ RESUMEN DIARIO - Raíces Andinas', ''];

    if (stock_bajo.length > 0) {
        lineas.push(`📦 Productos para reponer (${stock_bajo.length}):`);
        stock_bajo.forEach(p => {
            const icono = p.stock === 0 ? '🔴 AGOTADO' : '🟡';
            lineas.push(`${icono} ${p.nombre}: ${p.stock} uds (mínimo ${p.stock_minimo})`);
        });
        lineas.push('');
    }

    if (pedidos_atrasados.length > 0) {
        lineas.push(`⏰ Pedidos pendientes hace más de ${horas_limite} h (${pedidos_atrasados.length}):`);
        pedidos_atrasados.forEach(p => {
            const dias = Math.floor(p.horas_pendiente / 24);
            lineas.push(`• #${p.id} - ${p.nombres} ${p.apellidos} - ${pesos(p.total)} (${dias} días)`);
        });
    }

    return [{ json: { telegram: lineas.join('\n') } }];
}

function codigoAtencionCliente() {
    const datos = $input.first().json.body;
    const c = datos.cliente;
    const quien = c
        ? `👤 ${c.nombres} ${c.apellidos || ''}\n📧 ${c.correo}${c.telefono ? `\n📱 ${c.telefono}` : ''}`
        : '👤 Visitante sin sesión iniciada';

    let telegram;
    if (datos.evento === 'chat-asesor') {
        telegram = [
            `🙋 UN CLIENTE PIDE HABLAR CON UN ASESOR (chat #${datos.chat_id})`,
            '',
            quien,
            '',
            '💬 Últimos mensajes:',
            ...(datos.ultimos_mensajes || []).map(m => `› ${m}`)
        ].join('\n');
    } else {
        telegram = [
            `⚠️ CALIFICACIÓN BAJA EN EL CHATBOT: ${'⭐'.repeat(datos.puntuacion)} (${datos.puntuacion}/5)`,
            `Chat #${datos.chat_id}`,
            '',
            quien,
            '',
            `📝 Comentario: ${datos.comentario || '(sin comentario)'}`
        ].join('\n');
    }

    return [{ json: { telegram } }];
}

function codigoReporteMensual() {
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

function codigoBienvenida() {
    const { usuario } = $input.first().json.body;

    const html = plantillaCorreo(
        `¡Bienvenido/a, ${esc(usuario.nombres)}! 🌿`,
        `<p>Gracias por registrarte en <strong>Raíces Andinas</strong>, tu tienda de productos andinos auténticos:
            café de origen, miel de páramo, quinua, panela artesanal y mucho más.</p>
         <ul>
           <li>🎁 <strong>Envío gratis</strong> en compras mayores a $80.000</li>
           <li>💬 Nuestro asistente virtual te ayuda las 24 horas</li>
           <li>📦 Te avisamos por correo cada paso de tus pedidos</li>
         </ul>`
    );

    return [{ json: { para: usuario.correo, asunto: '🌿 Bienvenido/a a Raíces Andinas', html } }];
}

function codigoStockInmediato() {
    const { pedido_id, productos } = $input.first().json.body;

    const telegram = [
        '📉 ALERTA DE STOCK',
        `La venta del pedido #${pedido_id} dejó estos productos en su mínimo o por debajo:`,
        '',
        ...productos.map(p => `${p.stock === 0 ? '🔴 AGOTADO' : '🟡'} ${p.nombre}: quedan ${p.stock} (mínimo ${p.stock_minimo})`),
        '',
        '👉 Conviene reponer pronto.'
    ].join('\n');

    return [{ json: { telegram } }];
}

function codigoEncuesta() {
    // Después del nodo "Esperar", los datos del webhook siguen disponibles en $json
    const { pedido, cliente, enlace_encuesta } = $input.first().json.body;

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

function codigoChatbotIA() {
    const d = $input.first().json.body;
    const ingles = d.idioma === 'en';
    // Se quitan llaves { } para no confundir a la plantilla del modelo
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

function codigoRespuestaIA() {
    const texto = String($input.first().json.text || '').trim();
    return [{ json: { respuesta: texto } }];
}

function codigoPasswordReset() {
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

function codigoSeguimientoCorreo() {
    const { pedido, cliente, puntuacion, comentario } = $input.first().json.body;
    const estrellas = '★'.repeat(puntuacion) + '☆'.repeat(5 - puntuacion);

    let asunto, titulo, contenido;
    if (puntuacion <= 2) {
        asunto = `Lamentamos tu experiencia con el pedido #${pedido.id}`;
        titulo = `${esc(cliente.nombres)}, queremos arreglarlo`;
        contenido = `<p>Vimos tu calificación (<span style="color:#d4a853;font-size:18px;">${estrellas}</span>) y lo sentimos mucho. Esa no es la experiencia que queremos darte.</p>
            ${comentario ? `<p style="background:#fdecea;padding:12px;border-radius:8px;">"${esc(comentario)}"</p>` : ''}
            <p>Una persona de nuestro equipo ya recibió tu caso y te contactará en las próximas 24 horas para darte una solución.</p>
            <p>Si prefieres, también puedes responder este correo o escribirnos por WhatsApp al +57 300 123 4567.</p>`;
    } else if (puntuacion === 3) {
        asunto = `Gracias por tu opinión sobre el pedido #${pedido.id}`;
        titulo = `Gracias, ${esc(cliente.nombres)}`;
        contenido = `<p>Recibimos tu calificación (<span style="color:#d4a853;font-size:18px;">${estrellas}</span>). Queremos que tu próxima compra sea de 5 estrellas.</p>
            <p>Si quieres contarnos qué podemos mejorar, responde este correo: lo leemos todo.</p>`;
    } else {
        asunto = `¡Gracias por tus ${puntuacion} estrellas! 💚`;
        titulo = `¡Nos alegra mucho, ${esc(cliente.nombres)}!`;
        contenido = `<p>Gracias por calificar tu pedido <strong>#${pedido.id}</strong> con <span style="color:#d4a853;font-size:18px;">${estrellas}</span>.</p>
            <p>Detrás de cada producto hay familias campesinas de los Andes, y tu compra las apoya directamente. 🌱</p>
            <p>Si te gustó, cuéntaselo a un amigo: nos ayuda muchísimo.</p>`;
    }

    return [{ json: { para: cliente.correo, asunto, html: plantillaCorreo(titulo, contenido) } }];
}

function codigoSeguimientoAlerta() {
    const { pedido, cliente, puntuacion, comentario } = $input.first().json.body;

    // Solo las calificaciones malas (1 o 2 estrellas) generan alerta al equipo
    if (puntuacion > 2) return [];

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

function codigoCierreDia() {
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
        lineas.push(`🧾 Pedidos: ${d.pedidos_hoy}`);
        lineas.push(`💰 Ventas: ${pesos(d.ingresos_hoy)}`);
        if (comparacion) lineas.push(comparacion);
        if (d.top_productos.length > 0) {
            lineas.push('', '🏆 Lo más vendido hoy:');
            d.top_productos.forEach((p, i) => lineas.push(`${['🥇', '🥈', '🥉'][i]} ${p.nombre} (${p.unidades} uds)`));
        }
    }

    lineas.push('');
    if (d.cancelados_hoy > 0) lineas.push(`❌ Cancelados hoy: ${d.cancelados_hoy}`);
    lineas.push(`👥 Clientes nuevos hoy: ${d.clientes_nuevos}`);
    lineas.push(`⏳ Pedidos por atender: ${d.pedidos_pendientes}`);

    return [{ json: { telegram: lineas.join('\n') } }];
}

function codigoPedidoCancelado() {
    const { pedido, cliente } = $input.first().json.body;

    const telegram = [
        `❌ PEDIDO CANCELADO #${pedido.id}`,
        `(estaba: ${pedido.estado_anterior})`,
        '',
        `👤 ${cliente.nombres} ${cliente.apellidos || ''} · ${cliente.correo}`,
        `💰 ${pesos(pedido.total)}`,
        '',
        '📦 Stock devuelto al inventario:',
        ...pedido.items.map(i => `• +${i.cantidad} ${i.nombre}`)
    ].join('\n');

    return [{ json: { telegram } }];
}

// ============================================
// CONSTRUCTORES DE NODOS
// ============================================

function cuerpo(fn) {
    const texto = fn.toString();
    return texto.slice(texto.indexOf('{') + 1, texto.lastIndexOf('}'))
        .split('\n').map(l => l.replace(/^ {4}/, '')).join('\n').trim();
}

const AYUDANTES = cuerpo(ayudantes).replace('__TIENDA_URL__', config.tiendaUrl);

const nodo = (nombre, tipo, version, posicion, parametros, extra = {}) => ({
    parameters: parametros,
    id: crypto.randomUUID(),
    name: nombre,
    type: tipo,
    typeVersion: version,
    position: posicion,
    ...extra
});

const webhook = (nombre, ruta, posicion) => nodo(nombre, 'n8n-nodes-base.webhook', 2, posicion, {
    httpMethod: 'POST',
    path: ruta,
    responseMode: 'onReceived',
    options: {}
}, { webhookId: crypto.randomUUID() });

const codigo = (nombre, fn, posicion) => nodo(nombre, 'n8n-nodes-base.code', 2, posicion, {
    jsCode: `// ----- Funciones de apoyo -----\n${AYUDANTES}\n\n// ----- Lógica del flujo -----\n${cuerpo(fn)}`
});

const correo = (nombre, para, posicion) => nodo(nombre, 'n8n-nodes-base.emailSend', 2.1, posicion, {
    fromEmail: `Raíces Andinas <${config.remitente}>`,
    toEmail: para,
    subject: '={{ $json.asunto }}',
    emailFormat: 'html',
    html: '={{ $json.html }}',
    options: { appendAttribution: false }
}, { credentials: { smtp: { id: null, name: CREDENCIAL_GMAIL } } });

const telegram = (nombre, posicion) => nodo(nombre, 'n8n-nodes-base.telegram', 1.2, posicion, {
    chatId: config.telegramChatId,
    text: '={{ $json.telegram }}',
    additionalFields: { appendAttribution: false }
}, { credentials: { telegramApi: { id: null, name: CREDENCIAL_TELEGRAM } } });

// Webhook que DEVUELVE la respuesta del último nodo (el chatbot espera esa respuesta)
const webhookConRespuesta = (nombre, ruta, posicion) => nodo(nombre, 'n8n-nodes-base.webhook', 2, posicion, {
    httpMethod: 'POST',
    path: ruta,
    responseMode: 'lastNode',
    responseData: 'firstEntryJson',
    options: {}
}, { webhookId: crypto.randomUUID() });

const esperar = (nombre, minutosExpresion, posicion) => nodo(nombre, 'n8n-nodes-base.wait', 1.1, posicion, {
    resume: 'timeInterval',
    amount: minutosExpresion,
    unit: 'minutes'
}, { webhookId: crypto.randomUUID() });

const cadenaIA = (nombre, posicion) => nodo(nombre, '@n8n/n8n-nodes-langchain.chainLlm', 1.7, posicion, {
    promptType: 'define',
    text: '={{ $json.pregunta }}',
    messages: { messageValues: [{ type: 'SystemMessagePromptTemplate', message: '={{ $json.sistema }}' }] }
});

const modeloGemini = (nombre, posicion) => nodo(nombre, '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', 1, posicion, {
    modelName: config.modeloGemini,
    options: { temperature: 0.4, maxOutputTokens: 2048 }
}, { credentials: { googlePalmApi: { id: null, name: CREDENCIAL_GEMINI } } });

const programado = (nombre, cron, posicion) => nodo(nombre, 'n8n-nodes-base.scheduleTrigger', 1.2, posicion, {
    rule: { interval: [{ field: 'cronExpression', expression: cron }] }
});

const consultaApi = (nombre, ruta, query, posicion) => nodo(nombre, 'n8n-nodes-base.httpRequest', 4.2, posicion, {
    url: `${config.apiUrl}${ruta}`,
    // Clave local generada para este proyecto (AUTOMATION_API_KEY del .env)
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'x-api-key', value: config.apiKey }] },
    sendQuery: query.length > 0,
    queryParameters: { parameters: query },
    options: {}
});

// Conecta nodos en cadena: [['A', 'B'], ['A', 'C']] → A→B y A→C
// El tercer valor opcional es el tipo de conexión (por defecto "main"; el modelo de IA usa "ai_languageModel")
function conexiones(pares) {
    const resultado = {};
    for (const [desde, hacia, tipo = 'main'] of pares) {
        resultado[desde] = resultado[desde] || {};
        resultado[desde][tipo] = resultado[desde][tipo] || [[]];
        resultado[desde][tipo][0].push({ node: hacia, type: tipo, index: 0 });
    }
    return resultado;
}

// El ID fijo permite reimportar (actualiza el mismo flujo) y publicarlo por terminal
const flujo = (numero, nombre, nodos, pares) => ({
    id: `RaicesAndinas0${numero}`,
    name: nombre,
    nodes: nodos,
    connections: conexiones(pares),
    settings: { executionOrder: 'v1', timezone: 'America/Bogota' },
    pinData: {}
});

// ============================================
// DEFINICIÓN DE LOS FLUJOS
// ============================================

const flujos = {
    '01-pedido-creado': flujo('01', '01 · Pedido creado → correo al cliente + aviso al admin', [
        webhook('Webhook: pedido creado', 'pedido-creado', [0, 0]),
        codigo('Preparar mensajes', codigoPedidoCreado, [240, 0]),
        correo('Correo al cliente', '={{ $json.para }}', [480, -100]),
        telegram('Telegram al admin', [480, 100])
    ], [
        ['Webhook: pedido creado', 'Preparar mensajes'],
        ['Preparar mensajes', 'Correo al cliente'],
        ['Preparar mensajes', 'Telegram al admin']
    ]),

    '02-pedido-estado': flujo('02', '02 · Cambio de estado del pedido → correo al cliente', [
        webhook('Webhook: estado del pedido', 'pedido-estado', [0, 0]),
        codigo('Preparar correo según estado', codigoPedidoEstado, [240, 0]),
        correo('Correo al cliente', '={{ $json.para }}', [480, 0])
    ], [
        ['Webhook: estado del pedido', 'Preparar correo según estado'],
        ['Preparar correo según estado', 'Correo al cliente']
    ]),

    '03-resumen-diario': flujo('03', '03 · Resumen diario 8am → stock bajo y pedidos atrasados', [
        programado('Todos los días 8:00 am', '0 8 * * *', [0, 0]),
        consultaApi('Consultar resumen', '/api/admin/resumen-diario',
            [{ name: 'horas', value: '48' }], [240, 0]),
        codigo('Armar mensaje', codigoResumenDiario, [480, 0]),
        telegram('Telegram al admin', [720, 0])
    ], [
        ['Todos los días 8:00 am', 'Consultar resumen'],
        ['Consultar resumen', 'Armar mensaje'],
        ['Armar mensaje', 'Telegram al admin']
    ]),

    '04-atencion-cliente': flujo('04', '04 · Chatbot → aviso por asesor solicitado o calificación baja', [
        webhook('Webhook: piden asesor', 'chat-asesor', [0, -100]),
        webhook('Webhook: calificación baja', 'calificacion-baja', [0, 100]),
        codigo('Armar alerta', codigoAtencionCliente, [240, 0]),
        telegram('Telegram al equipo', [480, 0])
    ], [
        ['Webhook: piden asesor', 'Armar alerta'],
        ['Webhook: calificación baja', 'Armar alerta'],
        ['Armar alerta', 'Telegram al equipo']
    ]),

    '05-reporte-mensual': flujo('05', '05 · Reporte mensual (día 1, 7am) → correo al admin', [
        programado('Día 1 de cada mes 7:00 am', '0 7 1 * *', [0, 0]),
        consultaApi('Consultar reporte del mes anterior', '/api/reportes/mensual', [
            { name: 'mes', value: '={{ $now.minus({ months: 1 }).month }}' },
            { name: 'anio', value: '={{ $now.minus({ months: 1 }).year }}' }
        ], [240, 0]),
        codigo('Armar correo del reporte', codigoReporteMensual, [480, 0]),
        correo('Correo al admin', config.adminEmail, [720, 0])
    ], [
        ['Día 1 de cada mes 7:00 am', 'Consultar reporte del mes anterior'],
        ['Consultar reporte del mes anterior', 'Armar correo del reporte'],
        ['Armar correo del reporte', 'Correo al admin']
    ]),

    '06-bienvenida': flujo('06', '06 · Usuario registrado → correo de bienvenida', [
        webhook('Webhook: usuario registrado', 'usuario-registrado', [0, 0]),
        codigo('Preparar bienvenida', codigoBienvenida, [240, 0]),
        correo('Correo de bienvenida', '={{ $json.para }}', [480, 0])
    ], [
        ['Webhook: usuario registrado', 'Preparar bienvenida'],
        ['Preparar bienvenida', 'Correo de bienvenida']
    ]),

    '07-stock-inmediato': flujo('07', '07 · Venta deja un producto en su mínimo → alerta inmediata', [
        webhook('Webhook: stock bajo', 'stock-bajo', [0, 0]),
        codigo('Armar alerta de stock', codigoStockInmediato, [240, 0]),
        telegram('Telegram al admin', [480, 0])
    ], [
        ['Webhook: stock bajo', 'Armar alerta de stock'],
        ['Armar alerta de stock', 'Telegram al admin']
    ]),

    '08-encuesta-entrega': flujo('08', '08 · Pedido entregado → espera unos días → encuesta de satisfacción', [
        webhook('Webhook: pedido entregado', 'pedido-entregado', [0, 0]),
        esperar('Esperar después de la entrega', '={{ $json.body.esperar_minutos }}', [240, 0]),
        codigo('Preparar encuesta', codigoEncuesta, [480, 0]),
        correo('Correo con la encuesta', '={{ $json.para }}', [720, 0])
    ], [
        ['Webhook: pedido entregado', 'Esperar después de la entrega'],
        ['Esperar después de la entrega', 'Preparar encuesta'],
        ['Preparar encuesta', 'Correo con la encuesta']
    ]),

    '09-chatbot-ia': flujo('09', '09 · Chatbot con IA (Gemini) → responde preguntas libres', [
        webhookConRespuesta('Webhook: pregunta del cliente', 'chatbot-ia', [0, 0]),
        codigo('Preparar contexto', codigoChatbotIA, [240, 0]),
        cadenaIA('Generar respuesta con IA', [480, 0]),
        modeloGemini('Modelo Gemini', [480, 200]),
        codigo('Formatear respuesta', codigoRespuestaIA, [760, 0])
    ], [
        ['Webhook: pregunta del cliente', 'Preparar contexto'],
        ['Preparar contexto', 'Generar respuesta con IA'],
        ['Modelo Gemini', 'Generar respuesta con IA', 'ai_languageModel'],
        ['Generar respuesta con IA', 'Formatear respuesta']
    ]),

    '10-restablecer-password': flujo('10', '10 · Olvidé mi contraseña → correo con enlace seguro', [
        webhook('Webhook: restablecer contraseña', 'password-reset', [0, 0]),
        codigo('Preparar correo', codigoPasswordReset, [240, 0]),
        correo('Correo con el enlace', '={{ $json.para }}', [480, 0])
    ], [
        ['Webhook: restablecer contraseña', 'Preparar correo'],
        ['Preparar correo', 'Correo con el enlace']
    ]),

    '11-seguimiento-encuesta': flujo('11', '11 · Encuesta respondida → agradecimiento o disculpa + alerta', [
        webhook('Webhook: encuesta respondida', 'encuesta-respondida', [0, 0]),
        codigo('Preparar correo de seguimiento', codigoSeguimientoCorreo, [240, -100]),
        correo('Correo al cliente', '={{ $json.para }}', [480, -100]),
        codigo('Alerta si la nota es baja', codigoSeguimientoAlerta, [240, 100]),
        telegram('Telegram al equipo', [480, 100])
    ], [
        ['Webhook: encuesta respondida', 'Preparar correo de seguimiento'],
        ['Webhook: encuesta respondida', 'Alerta si la nota es baja'],
        ['Preparar correo de seguimiento', 'Correo al cliente'],
        ['Alerta si la nota es baja', 'Telegram al equipo']
    ]),

    '12-cierre-dia': flujo('12', '12 · Cierre del día 8pm → resumen de ventas por Telegram', [
        programado('Todos los días 8:00 pm', '0 20 * * *', [0, 0]),
        consultaApi('Consultar ventas del día', '/api/admin/cierre-dia', [], [240, 0]),
        codigo('Armar cierre del día', codigoCierreDia, [480, 0]),
        telegram('Telegram al admin', [720, 0])
    ], [
        ['Todos los días 8:00 pm', 'Consultar ventas del día'],
        ['Consultar ventas del día', 'Armar cierre del día'],
        ['Armar cierre del día', 'Telegram al admin']
    ]),

    '13-pedido-cancelado': flujo('13', '13 · Pedido cancelado → aviso al admin', [
        webhook('Webhook: pedido cancelado', 'pedido-cancelado', [0, 0]),
        codigo('Armar aviso', codigoPedidoCancelado, [240, 0]),
        telegram('Telegram al admin', [480, 0])
    ], [
        ['Webhook: pedido cancelado', 'Armar aviso'],
        ['Armar aviso', 'Telegram al admin']
    ])
};

// ============================================
// GENERAR ARCHIVOS
// ============================================
fs.mkdirSync(CARPETA_SALIDA, { recursive: true });

for (const [archivo, contenido] of Object.entries(flujos)) {
    fs.writeFileSync(path.join(CARPETA_SALIDA, `${archivo}.json`), JSON.stringify(contenido, null, 2));
    console.log(`✅ ${archivo}.json`);
}

console.log(`\n📁 Flujos generados en: ${CARPETA_SALIDA}`);
const faltantes = [];
if (!process.env.TIENDA_EMAIL_REMITENTE) faltantes.push('TIENDA_EMAIL_REMITENTE');
if (!process.env.ADMIN_TELEGRAM_CHAT_ID) faltantes.push('ADMIN_TELEGRAM_CHAT_ID');
if (faltantes.length > 0) {
    console.warn(`⚠️ Faltan en .env: ${faltantes.join(', ')} (se usaron valores de ejemplo)`);
}
