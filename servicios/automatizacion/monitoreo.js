// servicios/automatizacion/monitoreo.js
// C05 · Centro de Monitoreo: identifica la causa de un error, decide su gravedad y avisa con la solución

const { anonimizar } = require('./privacidad');
const { esc, plantillaCorreo } = require('./plantillas');

const CENTRAL = 'C05 Monitoreo';

// Reglas para identificar la causa más probable y cómo solucionarla
const REGLAS = [
    { si: ['535', 'username and password not accepted', 'invalid login', 'gmail'], categoria: 'Gmail', gravedad: 'critica',
      causa: 'Gmail rechazó el envío.', solucion: 'Crea una nueva contraseña de aplicación en myaccount.google.com/apppasswords y actualiza GMAIL_APP_PASSWORD en el .env.' },
    { si: ['econnrefused', ' er_', 'mysql', 'pool', 'protocol_connection_lost'], categoria: 'Base de datos', gravedad: 'critica',
      causa: 'La base de datos no respondió.', solucion: 'Revisa que MySQL esté encendido y que los datos DB_* del .env sean correctos.' },
    { si: ['chat not found', 'bot was blocked', 'telegram'], categoria: 'Telegram', gravedad: 'critica',
      causa: 'Telegram rechazó el mensaje.', solucion: 'Verifica TELEGRAM_BOT_TOKEN y ADMIN_TELEGRAM_CHAT_ID en el .env.' },
    { si: ['503', 'high demand', 'overloaded', 'unavailable'], categoria: 'IA', gravedad: 'media',
      causa: 'El modelo de IA está saturado temporalmente.', solucion: 'Es temporal; la IA pasa sola al siguiente proveedor o a las reglas.' },
    { si: ['429', 'quota', 'rate limit'], categoria: 'Límite de uso', gravedad: 'media',
      causa: 'Se superó el límite de uso de un servicio externo.', solucion: 'Espera unos minutos o revisa la cuota del servicio.' },
    { si: ['timeout', 'timed out', 'etimedout', 'econnreset'], categoria: 'Tiempo de espera', gravedad: 'baja',
      causa: 'Un servicio tardó demasiado en responder.', solucion: 'Suele ser temporal. Si se repite, revisa la conexión a internet.' }
];

function diagnosticar(error) {
    const texto = ` ${error.code || ''} ${error.message || ''}`.toLowerCase();
    const r = REGLAS.find(x => x.si.some(p => texto.includes(p)));
    const { categoria, gravedad, causa, solucion } = r || {
        categoria: 'Otro', gravedad: 'media', causa: 'Error no clasificado.', solucion: 'Revisa el detalle en la pestaña Automatizaciones del panel admin.'
    };
    return { categoria, gravedad, causa, solucion };
}

const ICONOS = { critica: '🚨', media: '⚠️', baja: 'ℹ️' };

function telegramError({ flujo, paso, mensaje }, d) {
    return [
        `${ICONOS[d.gravedad]} ERROR EN UNA AUTOMATIZACIÓN (${d.gravedad.toUpperCase()})`,
        '',
        `⚙️ Flujo: ${flujo}`,
        `📍 Paso que falló: ${paso}`,
        `🏷️ Tipo: ${d.categoria}`,
        `❓ Causa probable: ${d.causa}`,
        `🛠️ Solución: ${d.solucion}`,
        '',
        `📝 ${mensaje.slice(0, 200)}`
    ].join('\n');
}

function correoError({ flujo, paso, mensaje }, d) {
    return plantillaCorreo(
        `${ICONOS[d.gravedad]} Error en "${esc(flujo)}"`,
        `<p><strong>Paso que falló:</strong> ${esc(paso)}<br><strong>Tipo:</strong> ${esc(d.categoria)}<br><strong>Gravedad:</strong> ${d.gravedad}</p>
         <p><strong>Causa probable:</strong> ${esc(d.causa)}</p>
         <p><strong>Cómo solucionarlo:</strong> ${esc(d.solucion)}</p>
         <p style="background:#fdecea;padding:12px;border-radius:8px;font-family:monospace;font-size:12px;">${esc(mensaje)}</p>`
    );
}

// Qué canales usar para avisar: nunca el mismo que está fallando
function canalesDeAviso(d) {
    if (d.gravedad === 'baja') return { telegram: false, correo: false };
    return {
        telegram: d.categoria !== 'Telegram',
        correo: d.gravedad === 'critica' && d.categoria !== 'Gmail'
    };
}

function registrar(motor, { canales, entorno = process.env }) {
    motor.registrar({
        id: 'C05.aviso-error', central: CENTRAL, flujo: 'Aviso de error', esMonitor: true, reencolar: false,
        async ejecutar(datos, ctx) {
            const avisos = canalesDeAviso(datos.diagnostico);
            const ramas = [];
            if (avisos.telegram) ramas.push(() => ctx.paso('Telegram: error', () => canales.telegram(telegramError(datos, datos.diagnostico))));
            if (avisos.correo) ramas.push(() => ctx.paso('Correo: reporte del error', () => canales.correo({
                para: entorno.ADMIN_EMAIL,
                asunto: `${ICONOS[datos.diagnostico.gravedad]} Error en automatización: ${datos.flujo}`,
                html: correoError(datos, datos.diagnostico)
            })));
            await ctx.ramas(...ramas);
            return { flujo: datos.flujo, ...avisos };
        }
    });
}

// Dato listo para el flujo de aviso, sin datos personales en el mensaje
const datosDelError = ({ def, error, diagnostico }) => ({
    flujo: def.flujo,
    paso: error.paso || 'desconocido',
    mensaje: anonimizar(error.message),
    diagnostico
});

module.exports = { registrar, diagnosticar, canalesDeAviso, datosDelError };
