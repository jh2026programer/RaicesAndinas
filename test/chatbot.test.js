// Pruebas del chatbot por reglas y del flujo con IA en el motor
const { test } = require('node:test');
const assert = require('node:assert');
const { responderConReglas, respuestaNoEntendida } = require('../servicios/chatbot');
const atencion = require('../servicios/automatizacion/atencion');
const { crearMotor } = require('../servicios/automatizacion/motor');

const productos = [
    { nombre: 'Café de origen', descripcion: 'Tostado', precio: 30000, precio_final: 30000, descuento: 0, stock: 5, destacado: true },
    { nombre: 'Quinua', descripcion: '', precio: 15000, precio_final: 15000, descuento: 0, stock: 0, destacado: true }
];
const base = { idioma: 'es', productos, envio: { costo: 8000, gratisDesde: 80000 } };
const preguntar = (mensaje, permisivo) => responderConReglas({ ...base, mensaje, permisivo });

test('una pregunta libre se le deja a la IA cuando está disponible', () => {
    assert.strictEqual(preguntar('¿Qué me recomiendas para un desayuno?').entendido, false);
});

test('sin IA, una recomendación responde con destacados que tengan stock', () => {
    const r = preguntar('¿Qué me recomiendas para un desayuno?', true);
    assert.strictEqual(r.entendido, true);
    assert.match(r.respuesta, /Café de origen/);
    assert.doesNotMatch(r.respuesta, /Quinua/);
});

test('sin IA, entiende las preguntas comunes por palabras clave', () => {
    assert.match(preguntar('¿cuánto cuesta el envío a Bogotá?', true).respuesta, /Envíos y entregas/);
    assert.match(preguntar('quiero hacer una devolución', true).respuesta, /Devoluciones/);
    assert.match(preguntar('¿tienen algún descuento hoy?', true).respuesta, /GRATIS|Ofertas|ofertas/);
    assert.match(preguntar('¿cómo compro aquí?', true).respuesta, /Cómo comprar/);
});

test('sin IA, lo que no entiende lo dice con claridad y muestra el menú', () => {
    assert.strictEqual(preguntar('cuéntame un chiste', true).entendido, false);
    assert.match(respuestaNoEntendida('es'), /Menú principal/);
});

function bdFalsa() {
    const filas = [];
    return { filas, async query(sql, v = []) {
        if (sql.includes('INSERT INTO automatizacion_ejecuciones')) return [{ insertId: 1 }];
        if (sql.includes('UPDATE automatizacion_ejecuciones')) filas.push({ estado: v[0], resultado: v[1] });
        return [[]];
    } };
}

function montar(chatbotIA) {
    const bd = bdFalsa();
    const motor = crearMotor({ db: bd, esperaBase: 1, registro: { error() {}, warn() {} } });
    atencion.registrar(motor, { canales: {}, chatbotIA });
    return { bd, motor };
}

test('flujo del chatbot: si la IA responde queda en éxito con el modelo usado', async () => {
    const { bd, motor } = montar({ responder: async () => ({ texto: 'Hola', proveedor: 'groq', modelo: 'm' }) });
    const r = await motor.ejecutarPorId('C03.chatbot', { texto: 'hola' });
    assert.deepStrictEqual(r.resultado, { respuesta: 'Hola', proveedor: 'groq', modelo: 'm' });
    assert.strictEqual(bd.filas[0].estado, 'exito');
});

test('flujo del chatbot: si ningún modelo responde queda en parcial, no en éxito', async () => {
    const { bd, motor } = montar({ responder: async () => { throw new Error('Ningún modelo de IA respondió'); } });
    const r = await motor.ejecutarPorId('C03.chatbot', { texto: 'hola' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.resultado, { respuesta: null, proveedor: 'reglas' });
    assert.strictEqual(bd.filas[0].estado, 'parcial');
});
