// servicios/automatizacion/canales.js
// Envío directo por Gmail (SMTP) y Telegram, sin pasar por n8n.
// Si falta una credencial, el paso queda como "omitido" en la bitácora y la tienda sigue funcionando.

const nodemailer = require('nodemailer');

const LIMITE_TELEGRAM = 4000;

function errorPermanente(mensaje, causa) {
    const error = new Error(mensaje);
    error.permanente = true;
    error.cause = causa;
    return error;
}

function crearCanales(entorno = process.env) {
    let transporte = null;

    const remitente = () => entorno.TIENDA_EMAIL_REMITENTE;
    const hayBrevo = () => Boolean(remitente() && entorno.BREVO_API_KEY);
    const hayGmail = () => Boolean(remitente() && entorno.GMAIL_APP_PASSWORD);
    const hayTelegram = () => Boolean(entorno.TELEGRAM_BOT_TOKEN && entorno.ADMIN_TELEGRAM_CHAT_ID);

    function obtenerTransporte() {
        if (!transporte) {
            transporte = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: remitente(), pass: entorno.GMAIL_APP_PASSWORD },
                connectionTimeout: 10000,
                socketTimeout: 20000
            });
        }
        return transporte;
    }

    async function correoPorBrevo({ para, asunto, html }) {
        let res;
        try {
            res = await fetch('https://api.brevo.com/v3/smtp/email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'api-key': entorno.BREVO_API_KEY },
                body: JSON.stringify({ sender: { name: 'Raíces Andinas', email: remitente() }, to: [{ email: para }], subject: asunto, htmlContent: html }),
                signal: AbortSignal.timeout(15000)
            });
        } catch (error) {
            throw new Error(`Brevo no respondió: ${error.name}`);
        }
        if (res.ok) return { enviado: true };
        const detalle = await res.json().catch(() => ({}));
        const mensaje = `Gmail/Brevo rechazó el envío (${res.status}): ${detalle.message || 'sin detalle'}`;
        if ([400, 401, 403].includes(res.status)) throw errorPermanente(mensaje);
        throw new Error(mensaje);
    }

    return {
        estado: () => ({ gmail: hayBrevo() || hayGmail(), correo_por: hayBrevo() ? 'Brevo' : 'Gmail', telegram: hayTelegram() }),

        async correo({ para, asunto, html }) {
            if (hayBrevo()) return correoPorBrevo({ para, asunto, html });
            if (!hayGmail()) return { omitido: true, motivo: 'Falta GMAIL_APP_PASSWORD o TIENDA_EMAIL_REMITENTE' };
            try {
                const info = await obtenerTransporte().sendMail({
                    from: `"Raíces Andinas" <${remitente()}>`, to: para, subject: asunto, html
                });
                return { enviado: true, id: info.messageId };
            } catch (error) {
                // Credenciales o destinatario rechazados: reintentar no lo arregla
                if (error.code === 'EAUTH' || error.responseCode === 535 || error.responseCode === 550 || error.code === 'EENVELOPE') {
                    throw errorPermanente(`Gmail rechazó el envío (${error.responseCode || error.code}): ${error.message}`, error);
                }
                throw error;
            }
        },

        async telegram(texto) {
            if (!hayTelegram()) return { omitido: true, motivo: 'Falta TELEGRAM_BOT_TOKEN o ADMIN_TELEGRAM_CHAT_ID' };
            let res;
            try {
                res = await fetch(`https://api.telegram.org/bot${entorno.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: entorno.ADMIN_TELEGRAM_CHAT_ID, text: String(texto).slice(0, LIMITE_TELEGRAM) }),
                    signal: AbortSignal.timeout(10000)
                });
            } catch (error) {
                // El mensaje nunca debe incluir la URL: lleva el token del bot
                throw new Error(`Telegram no respondió: ${error.name}`);
            }
            if (res.ok) return { enviado: true };

            const detalle = await res.json().catch(() => ({}));
            const mensaje = `Telegram respondió ${res.status}: ${detalle.description || 'sin detalle'}`;
            if ([400, 401, 403, 404].includes(res.status)) throw errorPermanente(mensaje);
            throw new Error(mensaje);
        }
    };
}

module.exports = { crearCanales, errorPermanente };
