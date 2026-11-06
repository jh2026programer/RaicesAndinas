// servicios/automatizacion/pedidos.js
// C01 · Centro de Pedidos y Clientes (antes: central C01 de n8n)

const consultas = require('../consultas');
const { pesos, esc, plantillaCorreo, tablaItems } = require('./plantillas');

const CENTRAL = 'C01 Pedidos y Clientes';
const PEDIDO_PRIORITARIO = 200000;

// Regla de negocio: VIP = 5 compras o más, o más de $300.000 gastados
function clasificarCliente({ pedidos_previos, total_gastado }) {
    if (pedidos_previos >= 5 || total_gastado >= 300000) return 'vip';
    return pedidos_previos >= 1 ? 'recurrente' : 'nuevo';
}

const nivelEncuesta = (puntuacion) => (puntuacion <= 2 ? 'mala' : puntuacion === 3 ? 'regular' : 'buena');

const esCancelacionTardia = (estadoAnterior) => ['enviado', 'entregado'].includes(estadoAnterior);

function correoBienvenida(u) {
    return {
        para: u.correo,
        asunto: '🌿 Bienvenido/a a Raíces Andinas',
        html: plantillaCorreo(
            `¡Bienvenido/a, ${esc(u.nombres)}! 🌿`,
            `<p>Gracias por registrarte en <strong>Raíces Andinas</strong>, tu tienda de productos andinos auténticos:
                café de origen, miel de páramo, quinua, panela artesanal y mucho más.</p>
             <ul>
               <li>🎁 <strong>Envío gratis</strong> en compras mayores a $80.000</li>
               <li>💬 Nuestro asistente virtual te ayuda las 24 horas</li>
               <li>📦 Te avisamos por correo cada paso de tus pedidos</li>
             </ul>`
        )
    };
}

function correoPedido(tipo, pedido, cliente, historial) {
    const intro = {
        nuevo: `<p>Esta es tu <strong>primera compra</strong> con nosotros. ¡Bienvenido/a a la familia Raíces Andinas! 🌱</p>`,
        recurrente: `<p>¡Qué alegría tenerte de vuelta! Ya llevas <strong>${historial.pedidos_previos + 1} compras</strong> con nosotros. Gracias por elegirnos otra vez.</p>`,
        vip: `<p>👑 Como <strong>cliente VIP</strong>, tu pedido tiene <strong>prioridad</strong> en la preparación y el despacho. Gracias por ser parte especial de Raíces Andinas.</p>`
    }[tipo];

    const asunto = {
        nuevo: `✅ Tu primer pedido #${pedido.id} fue recibido - Raíces Andinas`,
        recurrente: `✅ Confirmación de tu pedido #${pedido.id} - Raíces Andinas`,
        vip: `👑 Pedido VIP #${pedido.id} confirmado - Raíces Andinas`
    }[tipo];

    return {
        para: cliente.correo,
        asunto,
        html: plantillaCorreo(
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
        )
    };
}

function telegramPedido(tipo, pedido, cliente, h) {
    const etiquetas = { nuevo: '🆕 Cliente nuevo (primera compra)', recurrente: '🔁 Cliente recurrente', vip: '👑 Cliente VIP' };
    const historial = h.pedidos_previos > 0 ? ` · ${h.pedidos_previos} compras antes por ${pesos(h.total_gastado)}` : '';
    const texto = [
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
    return pedido.total > PEDIDO_PRIORITARIO ? `🚨 PEDIDO PRIORITARIO (más de $200.000)\n👉 Despachar primero\n\n${texto}` : texto;
}

function correoEstado(estado, pedido, cliente) {
    const mensajes = {
        confirmado: { asunto: `👍 Tu pedido #${pedido.id} fue confirmado`, texto: 'Confirmamos tu pedido y ya estamos alistando tus productos.' },
        enviado: { asunto: `🚚 Tu pedido #${pedido.id} va en camino`, texto: 'Tu pedido salió de nuestra bodega. El tiempo estimado de entrega es de 3 a 5 días hábiles.' },
        entregado: { asunto: `🎉 Tu pedido #${pedido.id} fue entregado`, texto: '¡Tu pedido fue entregado! Esperamos que disfrutes tus productos andinos. Gracias por confiar en nosotros.' },
        cancelado: { asunto: `❌ Tu pedido #${pedido.id} fue cancelado`, texto: 'Tu pedido fue cancelado. Si no solicitaste la cancelación o tienes dudas, responde a este correo o escríbenos a soporte.' }
    };
    const m = mensajes[estado];
    if (!m) return null;
    return {
        para: cliente.correo,
        asunto: m.asunto,
        html: plantillaCorreo(
            `Hola ${esc(cliente.nombres)}, tu pedido cambió de estado`,
            `<p>${m.texto}</p>
             <p style="font-size:16px;">Estado actual: <strong style="text-transform:uppercase;color:#1a3c2a;">${esc(estado)}</strong></p>
             ${tablaItems(pedido.items)}
             <p style="text-align:right;"><strong>Total: ${pesos(pedido.total)}</strong></p>`
        )
    };
}

function telegramCancelacion(pedido, cliente) {
    const tardia = esCancelacionTardia(pedido.estado_anterior);
    return [
        tardia ? `⚠️ CANCELACIÓN TARDÍA #${pedido.id}` : `❌ PEDIDO CANCELADO #${pedido.id}`,
        `(estaba: ${pedido.estado_anterior})`,
        tardia ? '👉 El pedido ya había sido despachado: coordina la devolución con la transportadora.' : '',
        '',
        `👤 ${cliente.nombres} ${cliente.apellidos || ''} · ${cliente.correo}`,
        `💰 ${pesos(pedido.total)}`,
        '',
        '📦 Stock devuelto al inventario:',
        ...pedido.items.map(i => `• +${i.cantidad} ${i.nombre}`)
    ].join('\n');
}

function correoEncuesta({ pedido, cliente, enlace_encuesta }) {
    const estrella = `<a href="${enlace_encuesta}" style="text-decoration:none;font-size:30px;color:#d4a853;">★</a>`;
    return {
        para: cliente.correo,
        asunto: `⭐ ¿Qué te pareció tu pedido #${pedido.id}?`,
        html: plantillaCorreo(
            `${esc(cliente.nombres)}, ¿cómo te fue con tu pedido?`,
            `<p>Hace unos días recibiste tu pedido <strong>#${pedido.id}</strong>. Nos encantaría saber qué te pareció.</p>
             ${tablaItems(pedido.items)}
             <p style="text-align:center;margin:24px 0 8px;">${estrella.repeat(5)}</p>
             <p style="text-align:center;">
               <a href="${enlace_encuesta}" style="background:#1a3c2a;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:bold;">Calificar mi compra</a>
             </p>
             <p style="text-align:center;color:#888;font-size:13px;">Solo toma 10 segundos 💚</p>`
        )
    };
}

function correoSeguimiento({ pedido, cliente, puntuacion, comentario }) {
    const nota = `<span style="color:#d4a853;font-size:18px;">${'★'.repeat(puntuacion)}${'☆'.repeat(5 - puntuacion)}</span>`;
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
    }[nivelEncuesta(puntuacion)];
    return { para: cliente.correo, asunto: textos.asunto, html: plantillaCorreo(textos.titulo, textos.contenido) };
}

function telegramEncuestaMala({ pedido, cliente, puntuacion, comentario }) {
    return [
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
}

function registrar(motor, { db, canales }) {
    motor.registrar({
        id: 'C01.nuevo-registro', central: CENTRAL, flujo: 'Nuevo cliente', evento: 'usuario.registrado',
        async ejecutar({ usuario: u }, ctx) {
            await ctx.ramas(
                () => ctx.paso('Correo de bienvenida', () => canales.correo(correoBienvenida(u))),
                () => ctx.paso('Telegram: nuevo cliente', () => canales.telegram(`🎉 NUEVO CLIENTE REGISTRADO\n\n👤 ${u.nombres} ${u.apellidos || ''}\n📧 ${u.correo}`))
            );
            return { cliente: u.id };
        }
    });

    motor.registrar({
        id: 'C01.nuevo-pedido', central: CENTRAL, flujo: 'Nuevo pedido', evento: 'pedido.creado',
        async ejecutar({ pedido, cliente }, ctx) {
            const historial = await ctx.paso('Consultar historial del cliente', () => consultas.historialCliente(db, cliente.id, pedido.id));
            const tipo = clasificarCliente(historial);
            await ctx.ramas(
                () => ctx.paso('Correo de confirmación', () => canales.correo(correoPedido(tipo, pedido, cliente, historial))),
                () => ctx.paso('Telegram: nuevo pedido', () => canales.telegram(telegramPedido(tipo, pedido, cliente, historial)))
            );
            return { pedido: pedido.id, tipo_cliente: tipo, prioritario: pedido.total > PEDIDO_PRIORITARIO };
        }
    });

    motor.registrar({
        id: 'C01.cambio-estado', central: CENTRAL, flujo: 'Cambio de estado', evento: 'pedido.estado',
        async ejecutar({ pedido, cliente }, ctx) {
            const correo = correoEstado(pedido.estado_nuevo, pedido, cliente);
            if (!correo) return { pedido: pedido.id, estado: pedido.estado_nuevo, correo: false };
            await ctx.paso('Correo de estado al cliente', () => canales.correo(correo));
            return { pedido: pedido.id, estado: pedido.estado_nuevo, correo: true };
        }
    });

    motor.registrar({
        id: 'C01.cancelacion', central: CENTRAL, flujo: 'Pedido cancelado', evento: 'pedido.cancelado',
        async ejecutar({ pedido, cliente }, ctx) {
            await ctx.paso('Telegram: pedido cancelado', () => canales.telegram(telegramCancelacion(pedido, cliente)));
            return { pedido: pedido.id, tardia: esCancelacionTardia(pedido.estado_anterior) };
        }
    });

    // La espera vive en la base de datos: si el servidor se reinicia, la encuesta sale igual
    motor.registrar({
        id: 'C01.programar-encuesta', central: CENTRAL, flujo: 'Entrega: programar encuesta', evento: 'pedido.entregado',
        async ejecutar(datos, ctx) {
            await ctx.paso('Programar encuesta', () => ctx.programar('C01.enviar-encuesta', datos, datos.esperar_minutos));
            return { pedido: datos.pedido.id, esperar_minutos: datos.esperar_minutos };
        }
    });

    motor.registrar({
        id: 'C01.enviar-encuesta', central: CENTRAL, flujo: 'Enviar encuesta',
        async ejecutar(datos, ctx) {
            const respondida = await ctx.paso('¿Ya calificó la compra?', async () => {
                const [filas] = await db.query('SELECT id FROM encuestas WHERE pedido_id = ?', [datos.pedido.id]);
                return filas.length > 0;
            });
            if (respondida) return { pedido: datos.pedido.id, enviada: false, motivo: 'Ya calificó' };
            await ctx.paso('Correo con la encuesta', () => canales.correo(correoEncuesta(datos)));
            return { pedido: datos.pedido.id, enviada: true };
        }
    });

    motor.registrar({
        id: 'C01.seguimiento-encuesta', central: CENTRAL, flujo: 'Seguimiento de la encuesta', evento: 'encuesta.respondida',
        async ejecutar(datos, ctx) {
            const nivel = nivelEncuesta(datos.puntuacion);
            const ramas = [() => ctx.paso('Correo de seguimiento', () => canales.correo(correoSeguimiento(datos)))];
            if (nivel === 'mala') ramas.push(() => ctx.paso('Telegram al equipo', () => canales.telegram(telegramEncuestaMala(datos))));
            await ctx.ramas(...ramas);
            return { pedido: datos.pedido.id, puntuacion: datos.puntuacion, nivel };
        }
    });
}

module.exports = { registrar, clasificarCliente, nivelEncuesta, esCancelacionTardia, correoEstado, telegramPedido };
