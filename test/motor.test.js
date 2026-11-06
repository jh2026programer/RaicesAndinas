// Pruebas del motor: reintentos, bitácora, cola, reencolado y aviso de errores
const { test } = require('node:test');
const assert = require('node:assert');
const { crearMotor, conReintentos } = require('../servicios/automatizacion/motor');
const { errorPermanente } = require('../servicios/automatizacion/canales');

const silencio = { error() {}, warn() {}, log() {} };

// Base de datos falsa: guarda lo que el motor escribe en la bitácora y en la cola
function bdFalsa() {
    const bd = { bitacora: [], tareas: [], async query(sql, valores = []) {
        if (sql.includes('INSERT INTO automatizacion_ejecuciones')) {
            bd.bitacora.push({ central: valores[0], flujo_id: valores[1], disparador: valores[3], entrada: valores[4] });
            return [{ insertId: bd.bitacora.length }];
        }
        if (sql.includes('UPDATE automatizacion_ejecuciones')) {
            const fila = bd.bitacora[valores[valores.length - 1] - 1];
            Object.assign(fila, { estado: valores[0], resultado: valores[1], pasos: valores[2], intentos: valores[3], error: valores[4], causa: valores[5], gravedad: valores[6] });
            return [{}];
        }
        if (sql.includes('INSERT INTO automatizacion_tareas')) {
            bd.tareas.push({ id: bd.tareas.length + 1, flujo_id: valores[0], datos: valores[1], minutos: valores[2], estado: 'pendiente' });
            return [{}];
        }
        if (sql.includes('SELECT id, flujo_id, datos')) return [bd.tareas.filter(t => t.estado === 'pendiente')];
        if (sql.includes(`SET estado = 'en_curso'`)) {
            const t = bd.tareas.find(x => x.id === valores[0] && x.estado === 'pendiente');
            if (t) t.estado = 'en_curso';
            return [{ affectedRows: t ? 1 : 0 }];
        }
        if (sql.includes('UPDATE automatizacion_tareas SET estado = ?')) {
            bd.tareas.find(x => x.id === valores[1]).estado = valores[0];
            return [{}];
        }
        return [[]];
    } };
    return bd;
}

const nuevoMotor = (bd, extra = {}) => crearMotor({ db: bd, esperaBase: 1, registro: silencio, ...extra });

test('conReintentos: reintenta hasta que funciona', async () => {
    let llamadas = 0;
    const r = await conReintentos(async () => {
        if (++llamadas < 3) throw new Error('temporal');
        return 'listo';
    }, { esperaBase: 1 });
    assert.deepStrictEqual(r, { valor: 'listo', intentos: 3 });
});

test('conReintentos: se rinde tras 3 intentos', async () => {
    let llamadas = 0;
    await assert.rejects(conReintentos(async () => { llamadas++; throw new Error('sigue fallando'); }, { esperaBase: 1 }), /sigue fallando/);
    assert.strictEqual(llamadas, 3);
});

test('conReintentos: un error permanente no se reintenta', async () => {
    let llamadas = 0;
    await assert.rejects(conReintentos(async () => { llamadas++; throw errorPermanente('clave incorrecta'); }, { esperaBase: 1 }));
    assert.strictEqual(llamadas, 1);
});

test('la ejecución exitosa queda en la bitácora con entrada, pasos y resultado', async () => {
    const bd = bdFalsa();
    const motor = nuevoMotor(bd);
    motor.registrar({ id: 'T.ok', central: 'Prueba', flujo: 'Ok', async ejecutar(_, ctx) {
        await ctx.paso('Paso 1', async () => 1);
        return { listo: true };
    } });

    const r = await motor.ejecutarPorId('T.ok', { pedido: 7 });
    assert.strictEqual(r.ok, true);
    const fila = bd.bitacora[0];
    assert.strictEqual(fila.estado, 'exito');
    assert.match(fila.entrada, /"pedido":7/);
    assert.match(fila.resultado, /"listo":true/);
    assert.match(fila.pasos, /Paso 1/);
});

test('la bitácora no guarda correos completos, enlaces ni contraseñas', async () => {
    const bd = bdFalsa();
    const motor = nuevoMotor(bd);
    motor.registrar({ id: 'T.privado', central: 'Prueba', flujo: 'Privado', ejecutar: async () => ({}) });
    await motor.ejecutarPorId('T.privado', {
        usuario: { nombres: 'Ana', correo: 'ana.perez@gmail.com', telefono: '3001234567' },
        enlace: 'http://x/restablecer?token=SECRETO',
        password: 'clave123'
    });
    const entrada = bd.bitacora[0].entrada;
    assert.doesNotMatch(entrada, /ana\.perez|SECRETO|clave123|3001234567|Ana/);
    assert.match(entrada, /a\*\*\*@gmail\.com/);
});

test('un canal sin credencial deja el flujo en estado parcial, no en error', async () => {
    const bd = bdFalsa();
    const motor = nuevoMotor(bd);
    motor.registrar({ id: 'T.sinClave', central: 'Prueba', flujo: 'Sin clave', async ejecutar(_, ctx) {
        await ctx.paso('Correo', async () => ({ omitido: true, motivo: 'Falta la clave' }));
        return {};
    } });
    const r = await motor.ejecutarPorId('T.sinClave');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(bd.bitacora[0].estado, 'parcial');
    assert.match(bd.bitacora[0].pasos, /Falta la clave/);
});

test('ramas: si una falla, la otra termina igual', async () => {
    const bd = bdFalsa();
    let telegramEnviado = false;
    const motor = nuevoMotor(bd);
    motor.registrar({ id: 'T.ramas', central: 'Prueba', flujo: 'Ramas', async ejecutar(_, ctx) {
        await ctx.ramas(
            () => ctx.paso('Correo', async () => { throw errorPermanente('Gmail caído'); }),
            () => ctx.paso('Telegram', async () => { telegramEnviado = true; })
        );
    } });
    const r = await motor.ejecutarPorId('T.ramas');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(telegramEnviado, true);
});

test('error temporal: se reencola y el reintento no repite los pasos ya hechos', async () => {
    const bd = bdFalsa();
    const motor = nuevoMotor(bd);
    let correos = 0;
    let telegramFalla = true;
    motor.registrar({ id: 'T.cola', central: 'Prueba', flujo: 'Cola', async ejecutar(_, ctx) {
        await ctx.paso('Correo', async () => { correos++; return { enviado: true }; });
        await ctx.paso('Telegram', async () => { if (telegramFalla) throw new Error('timeout'); });
        return { terminado: true };
    } });

    const primero = await motor.ejecutarPorId('T.cola', { a: 1 });
    assert.strictEqual(primero.reencolado, true);
    assert.strictEqual(bd.tareas.length, 1);
    assert.strictEqual(bd.tareas[0].minutos, 5);

    telegramFalla = false;
    await motor.procesarCola();
    assert.strictEqual(correos, 1, 'el correo no se debe enviar dos veces');
    assert.strictEqual(bd.tareas[0].estado, 'hecha');
    assert.strictEqual(bd.bitacora[1].estado, 'exito');
    assert.match(bd.bitacora[1].disparador, /reintento:1/);
});

test('error permanente: no se reencola y avisa al monitor', async () => {
    const bd = bdFalsa();
    const avisos = [];
    const motor = nuevoMotor(bd, { alFallar: async (info) => avisos.push(info.def.id), diagnosticar: () => ({ causa: 'Clave mala', gravedad: 'critica' }) });
    motor.registrar({ id: 'T.mal', central: 'Prueba', flujo: 'Mal', async ejecutar(_, ctx) {
        await ctx.paso('Correo', async () => { throw errorPermanente('535 clave incorrecta'); });
    } });
    await motor.ejecutarPorId('T.mal');
    assert.strictEqual(bd.tareas.length, 0);
    assert.deepStrictEqual(avisos, ['T.mal']);
    assert.strictEqual(bd.bitacora[0].estado, 'error');
    assert.strictEqual(bd.bitacora[0].causa, 'Clave mala');
    assert.strictEqual(bd.bitacora[0].intentos, 1);
});

test('reencolar:false y esMonitor: ni cola ni aviso en bucle', async () => {
    const bd = bdFalsa();
    const avisos = [];
    const motor = nuevoMotor(bd, { alFallar: async () => avisos.push(1) });
    motor.registrar({ id: 'T.monitor', central: 'Prueba', flujo: 'Monitor', esMonitor: true, reencolar: false, async ejecutar() { throw new Error('timeout'); } });
    await motor.ejecutarPorId('T.monitor');
    assert.strictEqual(bd.tareas.length, 0);
    assert.strictEqual(avisos.length, 0);
});

test('el bus de eventos ejecuta los flujos suscritos sin lanzar errores al que emite', async () => {
    const bd = bdFalsa();
    const motor = nuevoMotor(bd);
    const recibido = new Promise(resolve => {
        motor.registrar({ id: 'T.evento', central: 'Prueba', flujo: 'Evento', evento: 'algo.paso', ejecutar: async (d) => resolve(d) });
    });
    motor.emitir('algo.paso', { dato: 1 });
    assert.deepStrictEqual(await recibido, { dato: 1 });
});

test('una bitácora caída no detiene el flujo', async () => {
    const bd = { query: async () => { throw new Error('BD caída'); } };
    const motor = nuevoMotor(bd);
    motor.registrar({ id: 'T.sinBD', central: 'Prueba', flujo: 'Sin BD', ejecutar: async () => ({ sigue: true }) });
    const r = await motor.ejecutarPorId('T.sinBD');
    assert.strictEqual(r.ok, true);
});
