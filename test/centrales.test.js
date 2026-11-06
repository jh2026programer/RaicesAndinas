// Pruebas de las reglas de negocio de las centrales (las mismas que tenían los flujos de n8n)
const { test } = require('node:test');
const assert = require('node:assert');
const pedidos = require('../servicios/automatizacion/pedidos');
const inventario = require('../servicios/automatizacion/inventario');
const atencion = require('../servicios/automatizacion/atencion');
const reportes = require('../servicios/automatizacion/reportes');
const monitoreo = require('../servicios/automatizacion/monitoreo');
const { crearMotor } = require('../servicios/automatizacion/motor');
const { anonimizar } = require('../servicios/automatizacion/privacidad');
const { esc, pesos } = require('../servicios/automatizacion/plantillas');

test('C01: clasifica al cliente como nuevo, recurrente o VIP', () => {
    const c = pedidos.clasificarCliente;
    assert.strictEqual(c({ pedidos_previos: 0, total_gastado: 0 }), 'nuevo');
    assert.strictEqual(c({ pedidos_previos: 1, total_gastado: 50000 }), 'recurrente');
    assert.strictEqual(c({ pedidos_previos: 4, total_gastado: 299999 }), 'recurrente');
    assert.strictEqual(c({ pedidos_previos: 5, total_gastado: 0 }), 'vip');
    assert.strictEqual(c({ pedidos_previos: 1, total_gastado: 300000 }), 'vip');
});

test('C01: nivel de la encuesta según las estrellas', () => {
    assert.deepStrictEqual([1, 2, 3, 4, 5].map(pedidos.nivelEncuesta), ['mala', 'mala', 'regular', 'buena', 'buena']);
});

test('C01: una cancelación es tardía si el pedido ya había salido', () => {
    assert.strictEqual(pedidos.esCancelacionTardia('enviado'), true);
    assert.strictEqual(pedidos.esCancelacionTardia('entregado'), true);
    assert.strictEqual(pedidos.esCancelacionTardia('pendiente'), false);
});

const pedido = { id: 9, total: 250000, costo_envio: 0, metodo_pago: 'Efectivo', direccion_envio: 'Calle 1', items: [{ nombre: 'Café', cantidad: 2, subtotal: 50000 }] };
const cliente = { nombres: 'Ana', apellidos: 'Pérez', correo: 'ana@x.co' };

test('C01: los pedidos de más de $200.000 se marcan prioritarios', () => {
    const h = { pedidos_previos: 0, total_gastado: 0 };
    assert.match(pedidos.telegramPedido('nuevo', pedido, cliente, h), /PEDIDO PRIORITARIO/);
    assert.doesNotMatch(pedidos.telegramPedido('nuevo', { ...pedido, total: 200000 }, cliente, h), /PRIORITARIO/);
});

test('C01: cada estado tiene su correo; "pendiente" no envía nada', () => {
    for (const estado of ['confirmado', 'enviado', 'entregado', 'cancelado']) {
        assert.ok(pedidos.correoEstado(estado, pedido, cliente).asunto.includes('#9'));
    }
    assert.strictEqual(pedidos.correoEstado('pendiente', pedido, cliente), null);
});

test('C02: la cantidad sugerida cubre 3 semanas de demanda más el mínimo', () => {
    const r = inventario.cantidadSugerida({ id: 1, nombre: 'Café', stock: 3, stock_minimo: 5, precio: 10000, unidades: 30, dias: 30 });
    assert.strictEqual(r.cantidad_sugerida, 23); // 21 días × 1 diaria + 5 mínimo − 3 en stock
    assert.strictEqual(r.costo_estimado, 138000); // 60 % del precio de venta
    assert.strictEqual(r.demanda_semanal, 7);
});

test('C02: sin ventas pide al menos el doble del mínimo o 5 unidades', () => {
    const base = { id: 1, nombre: 'X', stock: 0, precio: 1000, unidades: 0, dias: 30 };
    assert.strictEqual(inventario.cantidadSugerida({ ...base, stock_minimo: 4 }).cantidad_sugerida, 8);
    assert.strictEqual(inventario.cantidadSugerida({ ...base, stock_minimo: 1 }).cantidad_sugerida, 5);
});

// Base de datos en memoria para el circuito de aprobación
function bdCompras() {
    const bd = { solicitudes: [], stock: { 1: 3 }, tareas: [], async query(sql, v = []) {
        if (sql.includes('INSERT INTO solicitudes_compra')) {
            bd.solicitudes.push({ id: bd.solicitudes.length + 1, productos: v[0], total_estimado: v[1], orden: v[2], estado: 'pendiente' });
            return [{ insertId: bd.solicitudes.length }];
        }
        if (sql.includes('UPDATE solicitudes_compra')) {
            const s = bd.solicitudes.find(x => x.id === v[2] && x.estado === 'pendiente');
            if (s) s.estado = v[0];
            return [{ affectedRows: s ? 1 : 0 }];
        }
        if (sql.includes(`SELECT productos FROM solicitudes_compra`)) return [bd.solicitudes.filter(s => s.estado === 'pendiente')];
        if (sql.includes('SELECT * FROM solicitudes_compra')) return [bd.solicitudes.filter(s => s.id === v[0])];
        if (sql.includes('FROM productos pr')) return [[{ id: 1, nombre: 'Café', stock: 3, stock_minimo: 5, precio: '10000', unidades: '30', ingresos: '0' }]];
        if (sql.includes('UPDATE productos SET stock')) { bd.stock[v[1]] += v[0]; return [{ affectedRows: 1 }]; }
        if (sql.includes('FROM productos WHERE id')) return [[{ id: v[0], nombre: 'Café', stock: bd.stock[v[0]], stock_minimo: 5 }]];
        if (sql.includes('INSERT INTO automatizacion_tareas')) { bd.tareas.push({ flujo: v[0], minutos: v[2] }); return [{}]; }
        if (sql.includes('INSERT INTO automatizacion_ejecuciones')) return [{ insertId: 1 }];
        return [[]];
    }, async getConnection() {
        return { query: bd.query, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
    } };
    return bd;
}

function montarInventario(bd, ia = { generarTexto: async () => 'Orden redactada por la IA' }) {
    const enviados = { correos: [], telegram: [] };
    const canales = { correo: async (m) => { enviados.correos.push(m); return { enviado: true }; }, telegram: async (t) => { enviados.telegram.push(t); return { enviado: true }; } };
    const motor = crearMotor({ db: bd, esperaBase: 1, registro: { error() {}, warn() {} } });
    const compras = inventario.registrar(motor, { db: bd, canales, ia, firmar: (x) => `firma-${x}`, entorno: { ADMIN_EMAIL: 'dueno@x.co' } });
    return { motor, compras, enviados };
}

const stockBajo = { pedido_id: 1, productos: [{ id: 1, nombre: 'Café', stock: 3, stock_minimo: 5 }] };

test('C02: stock bajo crea la solicitud y pide aprobación con enlace firmado', async () => {
    const bd = bdCompras();
    const { motor, enviados } = montarInventario(bd);
    const r = await motor.ejecutarPorId('C02.stock-bajo', stockBajo);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(bd.solicitudes.length, 1);
    assert.match(enviados.correos[0].html, /api\/compras\/1\/decision\?token=firma-compra:1&decision=aprobar/);
    assert.match(enviados.correos[0].html, /Orden redactada por la IA/);
    assert.deepStrictEqual(bd.tareas, [{ flujo: 'C02.compra-vencida', minutos: 1440 }]);
});

test('C02: si la IA falla, la compra sigue con un texto base', async () => {
    const bd = bdCompras();
    const { motor, enviados } = montarInventario(bd, { generarTexto: async () => { throw new Error('sin cuota'); } });
    const r = await motor.ejecutarPorId('C02.stock-bajo', stockBajo);
    assert.strictEqual(r.ok, true);
    assert.match(enviados.correos[0].html, /Solicitamos el despacho/);
});

test('C02: no pide dos veces un producto que ya espera decisión', async () => {
    const bd = bdCompras();
    const { motor, enviados } = montarInventario(bd);
    await motor.ejecutarPorId('C02.stock-bajo', stockBajo);
    await motor.ejecutarPorId('C02.stock-bajo', stockBajo);
    assert.strictEqual(bd.solicitudes.length, 1);
    assert.strictEqual(enviados.correos.length, 1);
});

test('C02: aprobar dos veces no suma el stock dos veces', async () => {
    const bd = bdCompras();
    const { motor, compras } = montarInventario(bd);
    await motor.ejecutarPorId('C02.stock-bajo', stockBajo);

    assert.strictEqual(await compras.aplicarDecision(1, 'aprobar', 'prueba'), true);
    assert.strictEqual(await compras.aplicarDecision(1, 'aprobar', 'prueba'), false);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(bd.stock[1], 3 + 23);
    assert.strictEqual(bd.solicitudes[0].estado, 'aprobada');
});

test('C02: rechazar no toca el stock; una solicitud ya decidida no vence', async () => {
    const bd = bdCompras();
    const { motor, compras, enviados } = montarInventario(bd);
    await motor.ejecutarPorId('C02.stock-bajo', stockBajo);
    await compras.aplicarDecision(1, 'rechazar', 'prueba');
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(bd.stock[1], 3);
    assert.ok(enviados.telegram.some(t => t.includes('RECHAZADA')));

    const r = await motor.ejecutarPorId('C02.compra-vencida', { solicitud_id: 1 });
    assert.strictEqual(r.resultado.vencida, false);
    assert.strictEqual(bd.solicitudes[0].estado, 'rechazada');
});

test('C02: sin respuesta en 24 h la solicitud vence y avisa', async () => {
    const bd = bdCompras();
    const { motor, enviados } = montarInventario(bd);
    await motor.ejecutarPorId('C02.stock-bajo', stockBajo);
    const r = await motor.ejecutarPorId('C02.compra-vencida', { solicitud_id: 1 });
    assert.strictEqual(r.resultado.vencida, true);
    assert.strictEqual(bd.solicitudes[0].estado, 'vencida');
    assert.ok(enviados.telegram.some(t => t.includes('Nadie aprobó')));
});

test('C02: el token del enlace solo sirve para su solicitud', () => {
    const { compras } = montarInventario(bdCompras());
    assert.strictEqual(compras.tokenValido(1, 'firma-compra:1'), true);
    assert.strictEqual(compras.tokenValido(2, 'firma-compra:1'), false);
    assert.strictEqual(compras.tokenValido(1, 'inventado'), false);
    assert.strictEqual(compras.tokenValido(1, undefined), false);
});

test('C03: el aviso de asesor distingue cliente registrado y visitante', () => {
    assert.match(atencion.telegramAsesor({ chat_id: 1, cliente }), /UN CLIENTE PIDE.*\n\n👤 Ana/);
    assert.match(atencion.telegramAsesor({ chat_id: 1, cliente: null }), /UN VISITANTE PIDE/);
});

test('C04: el cierre del día compara con ayer', () => {
    const base = { pedidos_hoy: 2, ingresos_hoy: 150000, top_productos: [], cancelados_hoy: 0, clientes_nuevos: 1, pedidos_pendientes: 1 };
    assert.match(reportes.textoCierreDia({ ...base, ingresos_ayer: 100000 }), /50% más que ayer/);
    assert.match(reportes.textoCierreDia({ ...base, ingresos_ayer: 300000 }), /50% menos que ayer/);
    assert.match(reportes.textoCierreDia({ ...base, pedidos_hoy: 0, ingresos_hoy: 0, ingresos_ayer: 0 }), /Hoy no hubo ventas/);
});

test('C04: los KPI ordenan el top 5 y levantan alertas críticas', () => {
    const periodo = { ingresos: 100, pedidos: 1, ticket_promedio: 100, clientes_nuevos: 0, cancelados: 0, chats: 0, satisfaccion: 2 };
    const ventas = [1, 2, 3, 4, 5, 6].map(n => ({ nombre: `P${n}`, unidades: n }));
    const r = reportes.calcularKpis(
        { actual: periodo, anterior: { ...periodo, ingresos: 1000 } },
        [...ventas, { nombre: 'Sin ventas', unidades: 0 }],
        { stock_bajo: [{ nombre: 'Café', stock: 0 }], pedidos_atrasados: [{ id: 1 }] }
    );
    assert.deepStrictEqual(r.top.map(p => p.nombre), ['P6', 'P5', 'P4', 'P3', 'P2']);
    assert.strictEqual(r.alertas.length, 4);
    assert.strictEqual(reportes.variacion(150, 100), 50);
    assert.strictEqual(reportes.variacion(5, 0), 100);
});

test('C04: el reporte de enero corresponde a diciembre del año anterior', () => {
    assert.deepStrictEqual(reportes.mesAnterior(new Date(2027, 0, 1)), { mes: 12, anio: 2026 });
    assert.deepStrictEqual(reportes.mesAnterior(new Date(2026, 10, 1)), { mes: 10, anio: 2026 });
});

test('C04: el resumen diario lista stock y pedidos atrasados', () => {
    const texto = reportes.textoResumenDiario({
        horas_limite: 48,
        stock_bajo: [{ nombre: 'Café', stock: 0, stock_minimo: 5 }],
        pedidos_atrasados: [{ id: 3, nombres: 'Ana', apellidos: 'P', total: 1000, horas_pendiente: 72 }]
    });
    assert.match(texto, /AGOTADO Café/);
    assert.match(texto, /#3 - Ana P - \$1\.000 \(3 días\)/);
});

test('C05: diagnostica la causa y la gravedad', () => {
    const d = (m, code) => monitoreo.diagnosticar(Object.assign(new Error(m), code ? { code } : {}));
    assert.strictEqual(d('Gmail rechazó el envío (535)').categoria, 'Gmail');
    assert.strictEqual(d('Telegram respondió 400: chat not found').categoria, 'Telegram');
    assert.strictEqual(d('fallo', 'ER_NO_SUCH_TABLE').categoria, 'Base de datos');
    assert.strictEqual(d('503 overloaded').gravedad, 'media');
    assert.strictEqual(d('429 quota').categoria, 'Límite de uso');
    assert.strictEqual(d('Request timed out').gravedad, 'baja');
    assert.strictEqual(d('algo raro').categoria, 'Otro');
});

test('C05: nunca avisa por el mismo canal que está fallando', () => {
    assert.deepStrictEqual(monitoreo.canalesDeAviso({ gravedad: 'critica', categoria: 'Gmail' }), { telegram: true, correo: false });
    assert.deepStrictEqual(monitoreo.canalesDeAviso({ gravedad: 'critica', categoria: 'Telegram' }), { telegram: false, correo: true });
    assert.deepStrictEqual(monitoreo.canalesDeAviso({ gravedad: 'media', categoria: 'IA' }), { telegram: true, correo: false });
    assert.deepStrictEqual(monitoreo.canalesDeAviso({ gravedad: 'baja', categoria: 'Otro' }), { telegram: false, correo: false });
});

test('privacidad: quita correos, teléfonos y cédulas de un texto libre', () => {
    const r = anonimizar('Soy Ana, ana@gmail.com, cel 300 123 4567, CC 1098765432, pedido 12');
    assert.doesNotMatch(r, /ana@gmail|300 123|1098765432/);
    assert.match(r, /pedido 12/);
});

test('plantillas: escapa HTML y da formato de pesos', () => {
    assert.strictEqual(esc('<b>"x"</b>'), '&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
    assert.strictEqual(pesos(1234567), '$1.234.567');
});
