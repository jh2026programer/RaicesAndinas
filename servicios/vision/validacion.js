// servicios/vision/validacion.js
// Revisa lo que leyó la IA con reglas que no dependen de ella: las cuentas, el dígito de verificación
// del NIT, la fecha y el catálogo. Con eso decide si la factura necesita revisión humana.

const UMBRAL_CONFIANZA = 0.85;
const TOLERANCIA_PESOS = 2;

const normalizar = (texto) => String(texto ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Dígito de verificación del NIT colombiano (algoritmo de la DIAN)
function digitoVerificacion(base) {
    const PESOS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
    const digitos = String(base).replace(/\D/g, '').split('').reverse();
    const suma = digitos.reduce((s, d, i) => s + Number(d) * PESOS[i], 0);
    const resto = suma % 11;
    return resto > 1 ? 11 - resto : resto;
}

function nitValido(nit) {
    const m = String(nit ?? '').replace(/[\s.]/g, '').match(/^(\d{6,12})-(\d)$/);
    return Boolean(m) && digitoVerificacion(m[1]) === Number(m[2]);
}

const pares = (t) => {
    const s = new Set();
    for (let i = 0; i < t.length - 1; i++) s.add(t.slice(i, i + 2));
    return s;
};

// Parecido entre dos textos, de 0 a 1 (coeficiente de Dice sobre pares de letras)
function parecido(a, b) {
    const x = pares(normalizar(a));
    const y = pares(normalizar(b));
    if (x.size === 0 || y.size === 0) return 0;
    let comunes = 0;
    x.forEach(p => { if (y.has(p)) comunes++; });
    return 2 * comunes / (x.size + y.size);
}

// Busca el producto del catálogo que corresponde a una línea de la factura
function buscarProducto(descripcion, catalogo, minimo = 0.6) {
    let mejor = null;
    let puntaje = 0;
    for (const p of catalogo) {
        const contiene = normalizar(descripcion).includes(normalizar(p.nombre)) ? 1 : 0;
        const valor = Math.max(contiene, parecido(descripcion, p.nombre));
        if (valor > puntaje) {
            mejor = p;
            puntaje = valor;
        }
    }
    return puntaje >= minimo ? { producto_id: mejor.id, producto_nombre: mejor.nombre, parecido: Math.round(puntaje * 100) / 100 } : { producto_id: null, producto_nombre: null, parecido: 0 };
}

const iguales = (a, b) => Math.abs(Number(a) - Number(b)) <= TOLERANCIA_PESOS;
const esNumero = (v) => typeof v === 'number' && Number.isFinite(v);

function fechaValida(fecha, hoy = new Date()) {
    const m = String(fecha ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return false;
    const f = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (f.getMonth() !== Number(m[2]) - 1) return false;
    const dosAnios = new Date(hoy);
    dosAnios.setFullYear(hoy.getFullYear() - 2);
    return f <= hoy && f >= dosAnios;
}

// extraccion: { proveedor, nit, numero, fecha, subtotal, iva, total } como { valor, confianza } + items
function validarFactura(extraccion, catalogo = [], { hoy = new Date(), confianzaMaxima = 1 } = {}) {
    const alertas = [];
    const confianza = {};
    const leer = (campo) => extraccion[campo]?.valor ?? null;
    for (const campo of ['proveedor', 'nit', 'numero', 'fecha', 'subtotal', 'iva', 'total']) {
        confianza[campo] = Math.min(Number(extraccion[campo]?.confianza) || 0, confianzaMaxima);
        if (leer(campo) === null) confianza[campo] = 0;
    }

    for (const [campo, nombre] of [['proveedor', 'el proveedor'], ['numero', 'el número de factura'], ['fecha', 'la fecha'], ['total', 'el total']]) {
        if (leer(campo) === null || leer(campo) === '') alertas.push(`No se pudo leer ${nombre}.`);
    }

    // El NIT puede faltar: en una persona natural la cédula se tapa antes de enviarla a la IA
    if (leer('nit') === null) {
        alertas.push('No hay NIT legible: escríbelo si la factura lo tiene.');
    } else if (!nitValido(leer('nit'))) {
        alertas.push('El dígito de verificación del NIT no coincide: revísalo.');
        confianza.nit = Math.min(confianza.nit, 0.4);
    }

    if (leer('fecha') !== null && !fechaValida(leer('fecha'), hoy)) {
        alertas.push('La fecha no es válida, es futura o tiene más de 2 años.');
        confianza.fecha = Math.min(confianza.fecha, 0.4);
    }

    const items = (extraccion.items || []).map((it) => {
        const coincide = esNumero(it.cantidad) && esNumero(it.valor_unitario) && esNumero(it.subtotal) && iguales(it.cantidad * it.valor_unitario, it.subtotal);
        return {
            ...it,
            confianza: Math.min(Number(it.confianza) || 0, confianzaMaxima, coincide ? 1 : 0.4),
            cuentas_ok: coincide,
            ...buscarProducto(it.descripcion, catalogo)
        };
    });

    if (items.length === 0) alertas.push('No se leyeron productos.');
    items.filter(i => !i.cuentas_ok).forEach(i => alertas.push(`"${i.descripcion}": cantidad por valor unitario no da el subtotal.`));
    const sinCatalogo = items.filter(i => i.producto_id === null);
    if (sinCatalogo.length) alertas.push(`Sin producto en el catálogo: ${sinCatalogo.map(i => i.descripcion).join(', ')}.`);

    const totalesOk = items.length > 0 && esNumero(leer('subtotal')) && esNumero(leer('total'))
        && iguales(items.reduce((s, i) => s + (Number(i.subtotal) || 0), 0), leer('subtotal'))
        && iguales(leer('subtotal') + (Number(leer('iva')) || 0), leer('total'));
    if (!totalesOk) {
        alertas.push('Los totales no cuadran con los productos.');
        for (const c of ['subtotal', 'iva', 'total']) confianza[c] = Math.min(confianza[c], 0.4);
    }

    // La confianza global es la del dato más débil: un solo campo dudoso obliga a revisar.
    // El NIT ausente no la baja por sí solo, pero sí obliga a revisar por la alerta.
    const claves = ['proveedor', 'numero', 'fecha', 'subtotal', 'total'];
    if (leer('nit') !== null) claves.push('nit');
    const confianzas = [...claves.map(c => confianza[c]), ...items.map(i => i.confianza)];
    const global = confianzas.length ? Math.round(Math.min(...confianzas) * 1000) / 1000 : 0;

    return {
        datos: {
            proveedor: leer('proveedor'), nit: leer('nit'), numero: leer('numero'), fecha: leer('fecha'),
            subtotal: leer('subtotal'), iva: leer('iva'), total: leer('total'), items
        },
        confianza,
        confianza_global: global,
        totales_ok: totalesOk,
        alertas,
        requiere_revision: global < UMBRAL_CONFIANZA || alertas.length > 0
    };
}

module.exports = { validarFactura, digitoVerificacion, nitValido, buscarProducto, parecido, fechaValida, normalizar, UMBRAL_CONFIANZA };
