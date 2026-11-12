// Pruebas de la integración: factura confirmada → compra, stock y conciliación con solicitudes
const { test } = require('node:test');
const assert = require('node:assert');
const { calcularMovimientos, telegramCompra, registrar } = require('../servicios/vision/compras');
const { crearMotor } = require('../servicios/automatizacion/motor');
const inventario = require('../servicios/automatizacion/inventario');
const facturas = require('../servicios/vision/facturas');
const fs = require('fs');
const os = require('os');
const path = require('path');

const item = (producto_id, cantidad) => ({ producto_id, cantidad, descripcion: `P${producto_id}` });
const linea = (id, cantidad_sugerida, extra = {}) => ({ id, nombre: `P${id}`, cantidad_sugerida, ...extra });

test('sin solicitudes, toda la factura suma al stock', () => {
    const { movimientos, cierres } = calcularMovimientos([item(1, 10), item(2, 5)], []);
    assert.deepStrictEqual(movimientos.map(m => m.ajuste), [10, 5]);
    assert.deepStrictEqual(cierres, []);
});

test('un producto sin catálogo no mueve stock', () => {
    assert.deepStrictEqual(calcularMovimientos([item(null, 100)], []).movimientos, []);
});

test('el mismo producto en dos líneas se suma una vez', () => {
    assert.deepStrictEqual(calcularMovimientos([item(1, 3), item(1, 4)], []).movimientos[0].ajuste, 7);
});

test('compra ya aprobada: no se suma dos veces la misma mercancía', () => {
    const { movimientos, cierres } = calcularMovimientos([item(1, 20)], [{ id: 7, estado: 'aprobada', productos: [linea(1, 20)] }]);
    assert.deepStrictEqual(movimientos[0], { producto_id: 1, cantidad_factura: 20, ya_sumado: 20, ajuste: 0 });
    assert.strictEqual(cierres[0].estado, 'facturada');
});

test('llega más o menos de lo aprobado: se ajusta la diferencia', () => {
    const aprobada = () => [{ id: 7, estado: 'aprobada', productos: [linea(1, 20)] }];
    assert.strictEqual(calcularMovimientos([item(1, 25)], aprobada()).movimientos[0].ajuste, 5);
    assert.strictEqual(calcularMovimientos([item(1, 15)], aprobada()).movimientos[0].ajuste, -5);
});

test('una segunda factura del mismo producto suma completa', () => {
    const { cierres } = calcularMovimientos([item(1, 20)], [{ id: 7, estado: 'aprobada', productos: [linea(1, 20)] }]);
    const ahora = [{ id: 7, estado: 'aprobada', productos: cierres[0].productos }];
    assert.strictEqual(calcularMovimientos([item(1, 8)], ahora).movimientos[0].ajuste, 8);
});

test('solicitud pendiente: la factura suma todo y la cierra como cumplida', () => {
    const { movimientos, cierres } = calcularMovimientos([item(1, 10)], [{ id: 8, estado: 'pendiente', productos: [linea(1, 30)] }]);
    assert.strictEqual(movimientos[0].ajuste, 10);
    assert.strictEqual(cierres[0].estado, 'cumplida');
    assert.strictEqual(cierres[0].cerrada, true);
});

test('factura parcial: la solicitud sigue abierta con lo que falta', () => {
    const { cierres } = calcularMovimientos([item(1, 10)], [{ id: 8, estado: 'aprobada', productos: [linea(1, 10), linea(2, 5)] }]);
    assert.strictEqual(cierres[0].cerrada, false);
    assert.strictEqual(cierres[0].estado, 'aprobada');
    assert.deepStrictEqual(cierres[0].productos.map(p => Boolean(p.facturado)), [true, false]);
});

test('una solicitud que no tiene nada que ver no se toca', () => {
    assert.deepStrictEqual(calcularMovimientos([item(1, 1)], [{ id: 9, estado: 'pendiente', productos: [linea(2, 5)] }]).cierres, []);
});

test('el aviso explica los ajustes, lo que no entró y lo que llegó de menos', () => {
    const texto = telegramCompra({
        factura_id: 3,
        datos: { proveedor: 'X', numero: 'A-1', fecha: '2026-10-01', total: 1000 },
        stock: [{ nombre: 'Café', ya_sumado: 20, cantidad_factura: 15, ajuste: -5, stock: 30 }, { nombre: 'Miel', ya_sumado: 0, ajuste: 4, stock: 9 }],
        cierres: [7],
        sinCatalogo: ['Bolsas']
    });
    assert.match(texto, /Café: factura 15, ya se habían sumado 20 al aprobar → ajuste -5/);
    assert.match(texto, /Miel: \+4 → ahora hay 9/);
    assert.match(texto, /Bolsas/);
    assert.match(texto, /Llegó menos/);
    assert.match(texto, /#7/);
});

// ---------- Flujo completo con una base de datos en memoria ----------
const DATOS = { proveedor: 'Agroandina', nit: null, numero: 'A-1', fecha: '2026-10-01', subtotal: 100, iva: 0, total: 100, items: [{ producto_id: 1, descripcion: 'Café', cantidad: 10, valor_unitario: 10, subtotal: 100 }] };

function bdMemoria(solicitudes = []) {
    const bd = { stock: { 1: 5 }, compras: [], detalle: [], solicitudes, confirmaciones: 0, commits: 0, rollbacks: 0, fallarStock: false, async query(sql, v = []) {
        if (sql.includes('INSERT INTO automatizacion_ejecuciones')) return [{ insertId: 1 }];
        if (sql.includes('SELECT * FROM facturas')) return [[{ id: v[0], estado: 'confirmada', revisado_por: 9, datos_finales: JSON.stringify({ datos: DATOS }) }]];
        if (sql.includes('SELECT id FROM compras')) return [bd.compras.filter(c => c.factura_id === v[0])];
        if (sql.includes('FROM solicitudes_compra') && sql.includes('FOR UPDATE')) return [bd.solicitudes];
        if (sql.includes('INSERT INTO compras ')) { bd.compras.push({ id: bd.compras.length + 1, factura_id: v[0] }); return [{ insertId: bd.compras.length }]; }
        if (sql.includes('INSERT INTO compras_detalle')) { bd.detalle.push(v); return [{}]; }
        if (sql.includes('UPDATE productos SET stock')) {
            if (bd.fallarStock) throw new Error('timeout');
            bd.stock[v[1]] += v[0];
            return [{}];
        }
        if (sql.includes('SELECT nombre, stock')) return [[{ nombre: 'Café', stock: bd.stock[v[0]] }]];
        if (sql.includes('UPDATE solicitudes_compra')) {
            Object.assign(bd.solicitudes.find(s => s.id === v[5]), { productos: v[0], estado: v[1] });
            return [{}];
        }
        return [[]];
    }, async getConnection() {
        return { query: bd.query, beginTransaction: async () => {}, commit: async () => { bd.commits++; bd.compras.forEach(c => { c.confirmada = true; }); }, rollback: async () => { bd.rollbacks++; bd.compras = bd.compras.filter(c => c.confirmada); bd.detalle = []; }, release() {} };
    } };
    return bd;
}

function montar(bd) {
    const avisos = [];
    const motor = crearMotor({ db: bd, esperaBase: 1, registro: { error() {}, warn() {} } });
    registrar(motor, { db: bd, canales: { telegram: async (t) => { avisos.push(t); return { enviado: true }; } } });
    return { motor, avisos };
}

test('factura confirmada: registra la compra, suma el stock y avisa', async () => {
    const bd = bdMemoria();
    const { motor, avisos } = montar(bd);
    const r = await motor.ejecutarPorId('C06.factura-confirmada', { factura_id: 4 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(bd.stock[1], 15);
    assert.strictEqual(bd.compras.length, 1);
    assert.strictEqual(bd.detalle.length, 1);
    assert.strictEqual(bd.commits, 1);
    assert.match(avisos[0], /COMPRA REGISTRADA/);
});

test('procesar dos veces la misma factura no suma el stock dos veces', async () => {
    const bd = bdMemoria();
    const { motor } = montar(bd);
    await motor.ejecutarPorId('C06.factura-confirmada', { factura_id: 4 });
    const r = await motor.ejecutarPorId('C06.factura-confirmada', { factura_id: 4 });
    assert.strictEqual(r.resultado.repetida, true);
    assert.strictEqual(bd.stock[1], 15);
    assert.strictEqual(bd.compras.length, 1);
});

test('si algo falla a mitad de la transacción, se deshace y se reintenta', async () => {
    const bd = bdMemoria();
    bd.fallarStock = true;
    const { motor } = montar(bd);
    const r = await motor.ejecutarPorId('C06.factura-confirmada', { factura_id: 4 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reencolado, true);
    assert.ok(bd.rollbacks >= 1);
    assert.strictEqual(bd.commits, 0);
});

test('conciliación real: la solicitud aprobada queda facturada sin duplicar stock', async () => {
    const bd = bdMemoria([{ id: 7, estado: 'aprobada', productos: JSON.stringify([linea(1, 10)]) }]);
    const { motor, avisos } = montar(bd);
    await motor.ejecutarPorId('C06.factura-confirmada', { factura_id: 4 });
    assert.strictEqual(bd.stock[1], 5, 'el stock ya se había sumado al aprobar');
    assert.strictEqual(bd.solicitudes[0].estado, 'facturada');
    assert.match(avisos[0], /cerrada/);
});

test('aprobar una solicitud no vuelve a sumar lo que ya entró por factura', async () => {
    const solicitud = { id: 1, estado: 'aprobada', total_estimado: 100, orden: 'x', productos: JSON.stringify([linea(1, 10, { facturado: true, stock: 5, stock_minimo: 2, costo_estimado: 1 }), linea(2, 4, { stock: 5, stock_minimo: 2, costo_estimado: 1 })]) };
    const sumados = [];
    const bd = { async query(sql, v = []) {
        if (sql.includes('SELECT * FROM solicitudes_compra')) return [[solicitud]];
        if (sql.includes('INSERT INTO automatizacion_ejecuciones')) return [{ insertId: 1 }];
        if (sql.includes('UPDATE productos SET stock')) { sumados.push(v[1]); return [{ affectedRows: 1 }]; }
        if (sql.includes('FROM productos WHERE id')) return [[{ id: v[0], nombre: 'P', stock: 1 }]];
        return [[]];
    }, async getConnection() { return { query: bd.query, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} }; } };
    const motor = crearMotor({ db: bd, esperaBase: 1, registro: { error() {}, warn() {} } });
    const silencioso = { correo: async () => ({ enviado: true }), telegram: async () => ({ enviado: true }) };
    inventario.registrar(motor, { db: bd, canales: silencioso, ia: {}, firmar: () => 'f', entorno: {} });
    await motor.ejecutarPorId('C02.compra-aprobada', { solicitud_id: 1 });
    assert.deepStrictEqual(sumados, [2]);
});

// ---------- Confirmar con el producto elegido por el administrador ----------
function montarConfirmacion() {
    const catalogo = [{ id: 1, nombre: 'Café Orgánico' }, { id: 2, nombre: 'Miel de Abeja' }];
    const guardado = {};
    const bd = { async query(sql, v = []) {
        if (sql.includes('SELECT id, nombre FROM productos')) return [catalogo];
        if (sql.includes('SELECT * FROM facturas')) return [[{ id: 1, estado: 'por_revisar', datos_ia: null }]];
        if (sql.includes(`SET estado = 'confirmada'`)) { guardado.datos = JSON.parse(v[0]).datos; return [{ affectedRows: 1 }]; }
        if (sql.includes('INSERT INTO automatizacion_ejecuciones')) return [{ insertId: 1 }];
        return [[]];
    } };
    const motor = crearMotor({ db: bd, esperaBase: 1, registro: { error() {}, warn() {} } });
    motor.emitir = () => {};
    const servicio = facturas.registrar(motor, { db: bd, ia: { auditar: async () => {} }, extractor: {}, carpeta: fs.mkdtempSync(path.join(os.tmpdir(), 'f-')) });
    return { servicio, guardado };
}
const formulario = (items) => ({ proveedor: 'X', nit: '', numero: 'A-1', fecha: '2026-10-01', subtotal: 100, iva: 0, total: 100, items });

test('confirmación automática: queda auditada como decisión del sistema, no de una persona', async () => {
    const auditoria = [];
    const catalogo = [{ id: 1, nombre: 'Café Orgánico' }];
    const bd = { async query(sql) {
        if (sql.includes('SELECT id, nombre FROM productos')) return [catalogo];
        if (sql.includes('SELECT * FROM facturas')) return [[{ id: 1, estado: 'lista', confianza: 0.97, datos_ia: null }]];
        if (sql.includes(`SET estado = 'confirmada'`)) return [{ affectedRows: 1 }];
        return [[]];
    } };
    const motor = crearMotor({ db: bd, esperaBase: 1, registro: { error() {}, warn() {} } });
    const eventos = [];
    motor.emitir = (e) => eventos.push(e);
    const servicio = facturas.registrar(motor, { db: bd, ia: { auditar: async (f) => auditoria.push(f) }, extractor: {}, carpeta: fs.mkdtempSync(path.join(os.tmpdir(), 'f-')) });
    const r = await servicio.confirmar(1, formulario([{ descripcion: 'Café Orgánico', cantidad: 10, valor_unitario: 10, subtotal: 100, producto_id: 1 }]), null, { automatica: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(auditoria[0].proveedor, 'sistema');
    assert.match(auditoria[0].resultado, /automáticamente: confianza 97 %/);
    assert.deepStrictEqual(eventos, ['factura.confirmada']);
});

test('confirmar: el administrador puede enlazar un producto que la IA no reconoció', async () => {
    const { servicio, guardado } = montarConfirmacion();
    const r = await servicio.confirmar(1, formulario([{ descripcion: 'Producto raro', cantidad: 10, valor_unitario: 10, subtotal: 100, producto_id: '2' }]), 9);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(guardado.datos.items[0].producto_id, 2);
});

test('confirmar: "no es del catálogo" gana sobre el parecido automático', async () => {
    const { servicio, guardado } = montarConfirmacion();
    await servicio.confirmar(1, formulario([{ descripcion: 'Café Orgánico', cantidad: 10, valor_unitario: 10, subtotal: 100, producto_id: '' }]), 9);
    assert.strictEqual(guardado.datos.items[0].producto_id, null);
});

test('confirmar: rechaza un producto inexistente y cantidades que no se pueden sumar al stock', async () => {
    const { servicio } = montarConfirmacion();
    const uno = (cambios) => servicio.confirmar(1, formulario([{ descripcion: 'Café', cantidad: 10, valor_unitario: 10, subtotal: 100, producto_id: 1, ...cambios }]), 9);
    assert.match((await uno({ producto_id: 99 })).error, /no existe/);
    assert.match((await uno({ cantidad: 2.5, valor_unitario: 40 })).error, /entero/);
    assert.match((await uno({ cantidad: -10, valor_unitario: -10 })).error, /entero/);
});
