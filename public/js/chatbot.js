// public/js/chatbot.js
// Asistente virtual de Raíces Andinas.
// El navegador solo muestra la conversación: todas las respuestas vienen del servidor
// (menú por reglas con precios reales de la BD, o inteligencia artificial vía n8n + Gemini).

(function () {
    const { esc, t } = RA;

    let chatId = null;
    let iniciando = null;
    let mensajesEnviados = 0;
    let calificado = false;

    const ICONO_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12Z"/></svg>';
    const ICONO_ENVIAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z"/></svg>';

    function crearWidget() {
        const boton = document.createElement('button');
        boton.className = 'chat-boton';
        boton.id = 'chatBoton';
        boton.setAttribute('aria-label', 'Abrir chat');
        boton.innerHTML = `${ICONO_CHAT}<span class="punto"></span>`;
        document.body.appendChild(boton);

        const ventana = document.createElement('section');
        ventana.className = 'chat-ventana';
        ventana.id = 'chatVentana';
        ventana.setAttribute('aria-label', 'Chat');
        ventana.innerHTML = `
            <div class="chat-cabecera">
                <span class="avatar-bot">🌿</span>
                <div>
                    <strong data-i18n="chat.titulo">Asistente Raíces Andinas</strong>
                    <small data-i18n="chat.en_linea">En línea · responde al instante</small>
                </div>
                <button id="chatCerrar" aria-label="Cerrar">✕</button>
            </div>
            <div class="chat-mensajes" id="chatMensajes" aria-live="polite"></div>
            <div class="chat-sugerencias" id="chatSugerencias"></div>
            <div class="chat-calificacion oculto" id="chatCalificacion">
                <div data-i18n="chat.calificar">¿Cómo calificas la atención?</div>
                <div class="selector-estrellas" id="chatEstrellas">
                    ${[1, 2, 3, 4, 5].map(n => `<button type="button" data-valor="${n}" aria-label="${n}">★</button>`).join('')}
                </div>
                <input type="text" id="chatComentario" maxlength="300" data-i18n-placeholder="chat.comentario" placeholder="Comentario (opcional)">
            </div>
            <form class="chat-entrada" id="chatFormulario">
                <input type="text" id="chatInput" maxlength="500" autocomplete="off" data-i18n-placeholder="chat.input" placeholder="Escribe tu mensaje...">
                <button type="submit" id="chatEnviar" aria-label="Enviar">${ICONO_ENVIAR}</button>
            </form>`;
        document.body.appendChild(ventana);

        boton.addEventListener('click', alternarChat);
        document.getElementById('chatCerrar').addEventListener('click', alternarChat);
        document.getElementById('chatFormulario').addEventListener('submit', (e) => {
            e.preventDefault();
            enviar(document.getElementById('chatInput').value);
        });
        document.getElementById('chatSugerencias').addEventListener('click', (e) => {
            const b = e.target.closest('button[data-opcion]');
            if (b) enviar(b.dataset.opcion);
        });

        const estrellas = document.querySelectorAll('#chatEstrellas button');
        estrellas.forEach(b => {
            b.addEventListener('mouseenter', () => estrellas.forEach(x => x.classList.toggle('activa', x.dataset.valor <= b.dataset.valor)));
            b.addEventListener('click', () => calificar(parseInt(b.dataset.valor)));
        });
        document.getElementById('chatEstrellas').addEventListener('mouseleave', () => estrellas.forEach(x => x.classList.remove('activa')));

        document.addEventListener('abrirChat', () => {
            if (!ventana.classList.contains('abierto')) alternarChat();
        });
        document.addEventListener('idiomaCambiado', dibujarSugerencias);
        dibujarSugerencias();
    }

    function dibujarSugerencias() {
        const opciones = [
            ['1', t('chat.op_productos', { defaultValue: '📦 Productos' })],
            ['4', t('chat.op_ofertas', { defaultValue: '🎉 Ofertas' })],
            ['2', t('chat.op_envios', { defaultValue: '🚚 Envíos' })],
            ['6', t('chat.op_asesor', { defaultValue: '🙋 Asesor' })]
        ];
        document.getElementById('chatSugerencias').innerHTML =
            opciones.map(([valor, texto]) => `<button type="button" data-opcion="${valor}">${esc(texto)}</button>`).join('');
    }

    function alternarChat() {
        const ventana = document.getElementById('chatVentana');
        const abierto = ventana.classList.toggle('abierto');
        const boton = document.getElementById('chatBoton');
        boton.innerHTML = abierto ? '<span style="font-size:1.3rem">✕</span>' : ICONO_CHAT;
        if (abierto) {
            iniciarChat();
            setTimeout(() => document.getElementById('chatInput').focus(), 200);
        }
    }

    // La conversación se crea solo la primera vez que el cliente abre el chat
    function iniciarChat() {
        if (chatId || iniciando) return iniciando;
        iniciando = (async () => {
            const { ok, data } = await RA.api('/api/chat/iniciar', {
                method: 'POST',
                body: { session_id: `web_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`, idioma: RA.idioma() }
            });
            if (ok) {
                chatId = data.chat_id;
                agregarMensaje('bot', data.mensaje_bienvenida);
            } else {
                agregarMensaje('bot', '⚠️ ' + (data.error || t('chat.sin_conexion', { defaultValue: 'No pude conectarme. Intenta de nuevo.' })));
                iniciando = null;
            }
        })();
        return iniciando;
    }

    function agregarMensaje(emisor, texto, fuente) {
        const contenedor = document.getElementById('chatMensajes');
        const burbuja = document.createElement('div');
        burbuja.className = `burbuja ${emisor}`;
        // Convierte *negrita* en <strong> (después de escapar el texto para evitar HTML inyectado)
        burbuja.innerHTML = esc(texto).replace(/\*(.+?)\*/g, '<strong>$1</strong>') +
            (fuente === 'ia' ? `<span class="fuente-ia">✨ ${esc(t('chat.respuesta_ia', { defaultValue: 'Respuesta generada con IA' }))}</span>` : '');
        contenedor.appendChild(burbuja);
        contenedor.scrollTop = contenedor.scrollHeight;
        return burbuja;
    }

    async function enviar(texto) {
        const mensaje = String(texto || '').trim();
        if (!mensaje) return;

        const input = document.getElementById('chatInput');
        const btn = document.getElementById('chatEnviar');
        input.value = '';
        await iniciarChat();
        if (!chatId) return;

        agregarMensaje('cliente', mensaje);
        input.disabled = btn.disabled = true;

        // Indicador de "escribiendo..."
        const escribiendo = agregarMensaje('bot', '');
        escribiendo.classList.add('escribiendo');
        escribiendo.innerHTML = '<span></span><span></span><span></span>';

        const { ok, data } = await RA.api('/api/chat/mensaje', {
            method: 'POST',
            body: { chat_id: chatId, mensaje, idioma: RA.idioma() }
        });

        escribiendo.remove();
        agregarMensaje('bot', ok ? data.respuesta : '⚠️ ' + (data.error || 'Error'), ok ? data.fuente : null);
        input.disabled = btn.disabled = false;
        input.focus();

        // Después de 2 mensajes se ofrece calificar la atención
        mensajesEnviados++;
        if (mensajesEnviados >= 2 && !calificado) {
            document.getElementById('chatCalificacion').classList.remove('oculto');
        }
    }

    async function calificar(puntuacion) {
        if (!chatId || calificado) return;
        const comentario = document.getElementById('chatComentario').value.trim();
        const { ok, data } = await RA.api('/api/calificacion', {
            method: 'POST',
            body: { chat_id: chatId, puntuacion, comentario }
        });
        if (ok) {
            calificado = true;
            document.getElementById('chatCalificacion').classList.add('oculto');
            agregarMensaje('bot', t('chat.gracias', { estrellas: '⭐'.repeat(puntuacion), defaultValue: `¡Gracias por tu calificación! ${'⭐'.repeat(puntuacion)}` }));
        } else {
            RA.toast(data.error || 'Error', 'error');
        }
    }

    document.addEventListener('DOMContentLoaded', crearWidget);
})();
