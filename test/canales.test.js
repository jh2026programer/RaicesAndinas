// Pruebas de los canales de envío (sin enviar nada de verdad)
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const nodemailer = require('nodemailer');
const { crearCanales } = require('../servicios/automatizacion/canales');

const fetchOriginal = global.fetch;
const crearTransporteOriginal = nodemailer.createTransport;
afterEach(() => {
    global.fetch = fetchOriginal;
    nodemailer.createTransport = crearTransporteOriginal;
});

const conClaves = { TIENDA_EMAIL_REMITENTE: 'tienda@x.co', GMAIL_APP_PASSWORD: 'abc', TELEGRAM_BOT_TOKEN: 'TOKEN-SECRETO', ADMIN_TELEGRAM_CHAT_ID: '123' };

test('sin credenciales los canales quedan omitidos, no fallan', async () => {
    const canales = crearCanales({});
    assert.strictEqual(canales.estado().gmail, false);
    assert.strictEqual(canales.estado().telegram, false);
    assert.strictEqual((await canales.correo({ para: 'a@x.co', asunto: 'A', html: 'H' })).omitido, true);
    assert.strictEqual((await canales.telegram('hola')).omitido, true);
});

test('Telegram: envía al chat configurado', async () => {
    let enviado;
    global.fetch = async (url, opciones) => { enviado = { url, cuerpo: JSON.parse(opciones.body) }; return { ok: true }; };
    const r = await crearCanales(conClaves).telegram('hola');
    assert.deepStrictEqual(r, { enviado: true });
    assert.strictEqual(enviado.cuerpo.chat_id, '123');
    assert.strictEqual(enviado.cuerpo.text, 'hola');
});

test('Telegram: un chat inválido es permanente; una saturación se puede reintentar', async () => {
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ description: 'chat not found' }) });
    await assert.rejects(crearCanales(conClaves).telegram('x'), (e) => e.permanente === true && /chat not found/.test(e.message));

    global.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
    await assert.rejects(crearCanales(conClaves).telegram('x'), (e) => !e.permanente);
});

test('Telegram: un error de red no deja ver el token del bot', async () => {
    global.fetch = async (url) => { throw new TypeError(`fetch failed ${url}`); };
    await assert.rejects(crearCanales(conClaves).telegram('x'), (e) => !e.message.includes('TOKEN-SECRETO'));
});

test('Gmail: envía con la tienda como remitente', async () => {
    let correo;
    nodemailer.createTransport = () => ({ sendMail: async (m) => { correo = m; return { messageId: 'id1' }; } });
    const r = await crearCanales(conClaves).correo({ para: 'a@x.co', asunto: 'Asunto', html: '<b>H</b>' });
    assert.deepStrictEqual(r, { enviado: true, id: 'id1' });
    assert.match(correo.from, /tienda@x\.co/);
    assert.strictEqual(correo.to, 'a@x.co');
});

test('Gmail: una contraseña rechazada es permanente; un corte de red se puede reintentar', async () => {
    nodemailer.createTransport = () => ({ sendMail: async () => { throw Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 }); } });
    await assert.rejects(crearCanales(conClaves).correo({ para: 'a@x.co' }), (e) => e.permanente === true && /535/.test(e.message));

    nodemailer.createTransport = () => ({ sendMail: async () => { throw Object.assign(new Error('socket'), { code: 'ECONNRESET' }); } });
    await assert.rejects(crearCanales(conClaves).correo({ para: 'a@x.co' }), (e) => !e.permanente);
});

test('Brevo: si hay clave, el correo sale por API y tiene prioridad sobre Gmail', async () => {
    let enviado;
    global.fetch = async (url, opciones) => { enviado = { url, cuerpo: JSON.parse(opciones.body), clave: opciones.headers['api-key'] }; return { ok: true }; };
    const canales = crearCanales({ ...conClaves, BREVO_API_KEY: 'clave' });
    assert.strictEqual(canales.estado().correo_por, 'Brevo');
    assert.deepStrictEqual(await canales.correo({ para: 'a@x.co', asunto: 'A', html: 'H' }), { enviado: true });
    assert.match(enviado.url, /api\.brevo\.com/);
    assert.strictEqual(enviado.cuerpo.to[0].email, 'a@x.co');
    assert.strictEqual(enviado.cuerpo.sender.email, 'tienda@x.co');
});

test('Brevo: una clave rechazada es permanente; una saturación se puede reintentar', async () => {
    const canales = crearCanales({ ...conClaves, BREVO_API_KEY: 'clave' });
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ message: 'Key not found' }) });
    await assert.rejects(canales.correo({ para: 'a@x.co' }), (e) => e.permanente === true);
    global.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
    await assert.rejects(canales.correo({ para: 'a@x.co' }), (e) => !e.permanente);
});
