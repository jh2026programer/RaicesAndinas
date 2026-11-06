// servicios/automatizacion/atencion.js
// C03 · Centro de Atención al Cliente: chatbot con IA, asesor humano, calificaciones y contraseña

const { esc, plantillaCorreo } = require('./plantillas');

const CENTRAL = 'C03 Atención al Cliente';

function telegramAsesor(d) {
    const c = d.cliente;
    const quien = c
        ? [`🙋 UN CLIENTE PIDE HABLAR CON UN ASESOR (chat #${d.chat_id})`, '', `👤 ${c.nombres} ${c.apellidos || ''}`, `📧 ${c.correo}${c.telefono ? `\n📱 ${c.telefono}` : ''}`]
        : [`🙋 UN VISITANTE PIDE HABLAR CON UN ASESOR (chat #${d.chat_id})`, '👤 No ha iniciado sesión: no tenemos sus datos de contacto.'];
    return [
        ...quien,
        '',
        '💬 Últimos mensajes:',
        ...(d.ultimos_mensajes || []).map(m => `› ${m}`),
        ...(c ? ['', '📧 Ya le confirmamos por correo que lo contactarás.'] : [])
    ].join('\n');
}

function correoAsesor(c) {
    return {
        para: c.correo,
        asunto: '🙋 Recibimos tu solicitud de atención - Raíces Andinas',
        html: plantillaCorreo(
            `${esc(c.nombres)}, un asesor te contactará pronto`,
            `<p>Recibimos tu solicitud en el chat de la tienda. Una persona de nuestro equipo te escribirá o llamará en horario de atención:</p>
             <p>🕗 Lunes a viernes 8 a. m. – 6 p. m. · Sábados 9 a. m. – 1 p. m.</p>
             <p>Si es urgente, escríbenos por WhatsApp al <strong>+57 300 123 4567</strong>.</p>`
        )
    };
}

function telegramCalificacion(d) {
    const c = d.cliente;
    return [
        `⚠️ CALIFICACIÓN BAJA EN EL CHATBOT: ${'⭐'.repeat(d.puntuacion)} (${d.puntuacion}/5)`,
        `Chat #${d.chat_id}`,
        '',
        c ? `👤 ${c.nombres} ${c.apellidos || ''}\n📧 ${c.correo}` : '👤 Visitante sin sesión iniciada',
        '',
        `📝 Comentario: ${d.comentario || '(sin comentario)'}`
    ].join('\n');
}

function correoRecuperacion({ usuario, enlace, minutos }) {
    return {
        para: usuario.correo,
        asunto: '🔑 Restablece tu contraseña - Raíces Andinas',
        html: plantillaCorreo(
            'Restablece tu contraseña',
            `<p>Hola ${esc(usuario.nombres)}, recibimos una solicitud para cambiar la contraseña de tu cuenta.</p>
             <p style="text-align:center;margin:26px 0;">
               <a href="${enlace}" style="background:#1a3c2a;color:#fff;padding:13px 26px;border-radius:999px;text-decoration:none;font-weight:bold;">Crear nueva contraseña</a>
             </p>
             <p style="color:#666;font-size:14px;">⏰ Este enlace vence en <strong>${minutos} minutos</strong> y solo se puede usar una vez.</p>
             <p style="color:#666;font-size:14px;">Si tú no lo solicitaste, ignora este correo: tu contraseña actual sigue funcionando.</p>`
        )
    };
}

function registrar(motor, { canales, chatbotIA }) {
    // El cliente espera en vivo: no se reencola. Si la IA no responde, la tienda usa su menú de reglas.
    motor.registrar({
        id: 'C03.chatbot', central: CENTRAL, flujo: 'Chatbot con IA', reencolar: false,
        async ejecutar(datos, ctx) {
            const r = await ctx.paso('IA: responder al cliente', () => chatbotIA.responder(datos), { intentos: 1 }).catch(() => null);
            return r ? { respuesta: r.texto, proveedor: r.proveedor, modelo: r.modelo } : { respuesta: null, proveedor: 'reglas' };
        }
    });

    motor.registrar({
        id: 'C03.asesor', central: CENTRAL, flujo: 'El cliente pide un asesor', evento: 'chat.asesor',
        async ejecutar(d, ctx) {
            const ramas = [() => ctx.paso('Telegram: solicitud de asesor', () => canales.telegram(telegramAsesor(d)))];
            if (d.cliente && d.cliente.correo) {
                ramas.push(() => ctx.paso('Correo de confirmación al cliente', () => canales.correo(correoAsesor(d.cliente))));
            }
            await ctx.ramas(...ramas);
            return { chat: d.chat_id, tiene_cuenta: Boolean(d.cliente && d.cliente.correo) };
        }
    });

    motor.registrar({
        id: 'C03.calificacion-baja', central: CENTRAL, flujo: 'Calificación baja del chat', evento: 'calificacion.baja',
        async ejecutar(d, ctx) {
            await ctx.paso('Telegram: calificación baja', () => canales.telegram(telegramCalificacion(d)));
            return { chat: d.chat_id, puntuacion: d.puntuacion };
        }
    });

    // El enlace lleva un secreto: no se guarda en la cola de reintentos
    motor.registrar({
        id: 'C03.recuperar-contrasena', central: CENTRAL, flujo: 'Recuperar contraseña', evento: 'password.reset', reencolar: false,
        async ejecutar(d, ctx) {
            await ctx.paso('Correo con enlace seguro', () => canales.correo(correoRecuperacion(d)));
            return { enviado: true };
        }
    });
}

module.exports = { registrar, telegramAsesor, telegramCalificacion };
