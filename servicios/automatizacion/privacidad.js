// servicios/automatizacion/privacidad.js
// Protección de datos personales (Ley 1581 de 2012): lo que se guarda en la bitácora
// o se envía a un servicio externo de IA pasa primero por aquí.

const CAMPOS_OCULTOS = /^(html|password|contrase|token|enlace|enlace_encuesta|enlace_aprobar|enlace_rechazar|sistema|catalogo|direccion|direccion_envio|documento|eps|condiciones_salud)/i;
const MAX_TEXTO = 400;
const MAX_JSON = 6000;

function enmascararCorreo(correo) {
    const [usuario, dominio] = String(correo).split('@');
    return dominio ? `${usuario.charAt(0)}***@${dominio}` : '***';
}

// Quita correos y números largos (teléfonos, cédulas, tarjetas) de un texto libre
function anonimizar(texto) {
    return String(texto ?? '')
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[correo]')
        .replace(/\+?\d[\d\s.-]{5,}\d/g, '[número]');
}

// Copia del objeto apta para guardar en la bitácora
function enmascarar(valor, clave = '') {
    if (valor === null || valor === undefined) return valor;
    if (CAMPOS_OCULTOS.test(clave)) return '[oculto]';
    if (Array.isArray(valor)) return valor.slice(0, 20).map(v => enmascarar(v, clave));
    if (valor instanceof Date) return valor.toISOString();
    if (typeof valor === 'object') {
        return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, enmascarar(v, k)]));
    }
    if (typeof valor !== 'string') return valor;

    if (/correo|email|^para$/i.test(clave)) return enmascararCorreo(valor);
    if (/telefono/i.test(clave)) return `***${valor.slice(-3)}`;
    if (/^(nombres|apellidos)$/i.test(clave)) return `${valor.charAt(0)}.`;
    const limpio = anonimizar(valor);
    return limpio.length > MAX_TEXTO ? `${limpio.slice(0, MAX_TEXTO)}…` : limpio;
}

// JSON enmascarado y con tamaño acotado, listo para la columna de la bitácora
function paraBitacora(valor) {
    const json = JSON.stringify(enmascarar(valor) ?? null);
    return json.length > MAX_JSON ? `${json.slice(0, MAX_JSON)}…` : json;
}

module.exports = { anonimizar, enmascarar, enmascararCorreo, paraBitacora };
