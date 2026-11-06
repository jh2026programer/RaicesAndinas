// servicios/automatizacion/index.js
// Une el motor, los canales, la IA y las 5 centrales.

const { crearMotor } = require('./motor');
const { crearCanales } = require('./canales');
const { crearIA, proveedoresDesdeEntorno } = require('../ia');
const { crearChatbotIA } = require('../ia/chatbot');
const pedidos = require('./pedidos');
const inventario = require('./inventario');
const atencion = require('./atencion');
const reportes = require('./reportes');
const monitoreo = require('./monitoreo');
const facturas = require('../vision/facturas');

function crearAutomatizacion({ db, firmar, entorno = process.env, canales = crearCanales(entorno), ia = crearIA({ db, proveedores: proveedoresDesdeEntorno(entorno) }), registro = console, esperaBase }) {
    const chatbotIA = crearChatbotIA({ ia, db, entorno });

    const motor = crearMotor({
        db,
        registro,
        esperaBase,
        diagnosticar: monitoreo.diagnosticar,
        alFallar: (info) => motor.ejecutarPorId('C05.aviso-error', monitoreo.datosDelError(info), `error:${info.def.id}`)
    });

    pedidos.registrar(motor, { db, canales });
    const compras = inventario.registrar(motor, { db, canales, ia, firmar, entorno });
    atencion.registrar(motor, { canales, chatbotIA });
    reportes.registrar(motor, { db, canales, ia, entorno });
    monitoreo.registrar(motor, { canales, entorno });
    const lectorFacturas = facturas.registrar(motor, { db, ia });

    // Ley 1581: los registros técnicos no se guardan más tiempo del necesario
    motor.registrar({
        id: 'C05.limpieza', central: 'C05 Monitoreo', flujo: 'Limpieza de registros antiguos', cron: '0 3 * * *',
        async ejecutar(_, ctx) {
            await ctx.paso('Borrar registros vencidos', async () => {
                await db.query('DELETE FROM automatizacion_ejecuciones WHERE inicio < NOW() - INTERVAL 90 DAY');
                await db.query('DELETE FROM ia_auditoria WHERE fecha < NOW() - INTERVAL 180 DAY');
                await db.query(`DELETE FROM automatizacion_tareas WHERE estado IN ('hecha', 'error') AND ejecutar_en < NOW() - INTERVAL 30 DAY`);
            });
            return { limpio: true };
        }
    });

    return {
        motor,
        canales,
        ia,
        compras,
        facturas: lectorFacturas,
        async iniciar() {
            await motor.iniciar();
            await lectorFacturas.recuperarAtascadas();
        },
        emitir: (evento, datos) => motor.emitir(evento, datos),
        // Chatbot en vivo: devuelve la respuesta de la IA o null para que la tienda use sus reglas
        async responderChat(datos) {
            const r = await motor.ejecutarPorId('C03.chatbot', datos, 'chat');
            return r.ok ? r.resultado : { respuesta: null, proveedor: 'reglas' };
        }
    };
}

module.exports = { crearAutomatizacion };
