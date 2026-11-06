// servicios/automatizacion/motor.js
// Motor de automatización: reemplaza a n8n dentro del propio aplicativo.
//   - Bus de eventos: la tienda emite "pedido.creado" y cada flujo suscrito se ejecuta.
//   - Tareas programadas (cron) con la hora de Colombia.
//   - Reintentos con espera creciente en cada paso externo.
//   - Bitácora: cada ejecución queda con fecha, entrada, pasos y resultado.
//   - Cola en la BD: esperas largas y reintentos tardíos sobreviven a un reinicio del servidor.

const { EventEmitter } = require('events');
const cron = require('node-cron');
const { paraBitacora, anonimizar } = require('./privacidad');

const ZONA_HORARIA = 'America/Bogota';
const REINTENTOS_PASO = 3;
const ESPERA_BASE_MS = 1000;
// Si un flujo falla por un problema temporal, se vuelve a intentar más tarde (en minutos)
const REENCOLAR_MINUTOS = [5, 15, 45];
const REVISAR_COLA_MS = 30 * 1000;

// Ejecuta fn con reintentos y espera creciente (1 s, 2 s, 4 s...).
// Un error marcado como "permanente" (ej. contraseña incorrecta) no se reintenta.
async function conReintentos(fn, { intentos = REINTENTOS_PASO, esperaBase = ESPERA_BASE_MS, alReintentar } = {}) {
    let ultimoError;
    for (let intento = 1; intento <= intentos; intento++) {
        try {
            return { valor: await fn(intento), intentos: intento };
        } catch (error) {
            ultimoError = error;
            error.intentos = intento;
            if (error.permanente || intento === intentos) break;
            if (alReintentar) alReintentar(intento, error);
            await new Promise(r => setTimeout(r, esperaBase * 2 ** (intento - 1)));
        }
    }
    throw ultimoError;
}

function crearMotor({ db, diagnosticar = () => ({}), alFallar = async () => {}, esperaBase = ESPERA_BASE_MS, registro = console }) {
    const bus = new EventEmitter();
    const flujos = new Map();
    const tareasCron = [];
    let temporizadorCola = null;

    // ---------- Bitácora (si falla, el flujo sigue: registrar nunca debe romper un proceso) ----------
    async function abrirBitacora(def, entrada, disparador) {
        try {
            const [r] = await db.query(
                `INSERT INTO automatizacion_ejecuciones (central, flujo_id, flujo, disparador, entrada, estado)
                 VALUES (?, ?, ?, ?, ?, 'en_curso')`,
                [def.central, def.id, def.flujo, disparador, paraBitacora(entrada)]
            );
            return r.insertId;
        } catch (error) {
            registro.error('⚠️ No se pudo escribir en la bitácora:', error.message);
            return null;
        }
    }

    async function cerrarBitacora(id, { estado, resultado, pasos, intentos, error, diagnostico, inicio }) {
        if (!id) return;
        try {
            await db.query(
                `UPDATE automatizacion_ejecuciones
                 SET estado = ?, resultado = ?, pasos = ?, intentos = ?, error = ?, causa = ?, gravedad = ?,
                     fin = NOW(), duracion_ms = ?
                 WHERE id = ?`,
                [estado, paraBitacora(resultado), paraBitacora(pasos), intentos,
                    error ? anonimizar(error.message).slice(0, 1000) : null,
                    diagnostico?.causa || null, diagnostico?.gravedad || null, Date.now() - inicio, id]
            );
        } catch (err) {
            registro.error('⚠️ No se pudo cerrar la bitácora:', err.message);
        }
    }

    // ---------- Cola en la base de datos ----------
    async function programar(flujoId, entrada, minutos, extra = {}) {
        if (!flujos.has(flujoId)) throw new Error(`Flujo desconocido: ${flujoId}`);
        await db.query(
            `INSERT INTO automatizacion_tareas (flujo_id, datos, ejecutar_en)
             VALUES (?, ?, NOW() + INTERVAL ? MINUTE)`,
            [flujoId, JSON.stringify({ entrada, ...extra }), minutos]
        );
    }

    async function procesarCola() {
        const [pendientes] = await db.query(
            `SELECT id, flujo_id, datos FROM automatizacion_tareas
             WHERE estado = 'pendiente' AND ejecutar_en <= NOW() ORDER BY ejecutar_en LIMIT 20`
        );
        for (const tarea of pendientes) {
            // "Reclamar" la tarea evita ejecutarla dos veces
            const [r] = await db.query(
                `UPDATE automatizacion_tareas SET estado = 'en_curso' WHERE id = ? AND estado = 'pendiente'`,
                [tarea.id]
            );
            if (r.affectedRows === 0) continue;

            const { entrada, pasos, reencolados } = typeof tarea.datos === 'string' ? JSON.parse(tarea.datos) : tarea.datos;
            const def = flujos.get(tarea.flujo_id);
            const final = def
                ? await ejecutar(def, entrada, { disparador: reencolados ? `reintento:${reencolados}` : 'cola', pasosPrevios: pasos, reencolados })
                : { ok: false };
            await db.query(`UPDATE automatizacion_tareas SET estado = ? WHERE id = ?`, [final.ok ? 'hecha' : 'error', tarea.id]);
        }
    }

    // ---------- Ejecución de un flujo ----------
    async function ejecutar(def, entrada, { disparador = 'manual', pasosPrevios = {}, reencolados = 0 } = {}) {
        const inicio = Date.now();
        const bitacoraId = await abrirBitacora(def, entrada, disparador);
        const pasos = [];
        const completados = { ...pasosPrevios };
        let maxIntentos = 1;

        const ctx = {
            // Un paso se reintenta solo. Si ya se completó en un intento anterior, no se repite
            // (así un reintento tardío no vuelve a enviar un correo que ya salió).
            async paso(nombre, fn, { intentos = REINTENTOS_PASO } = {}) {
                if (nombre in completados) {
                    pasos.push({ nombre, estado: 'ya_hecho' });
                    return completados[nombre];
                }
                const inicioPaso = Date.now();
                try {
                    const { valor, intentos: usados } = await conReintentos(fn, { intentos, esperaBase });
                    maxIntentos = Math.max(maxIntentos, usados);
                    const omitido = valor && valor.omitido;
                    pasos.push({ nombre, estado: omitido ? 'omitido' : 'ok', intentos: usados, ms: Date.now() - inicioPaso, ...(omitido ? { motivo: valor.motivo } : {}) });
                    if (!omitido) completados[nombre] = valor ?? null;
                    return valor;
                } catch (error) {
                    maxIntentos = Math.max(maxIntentos, error.intentos || 1);
                    error.paso = nombre;
                    pasos.push({ nombre, estado: 'error', intentos: error.intentos || 1, ms: Date.now() - inicioPaso, error: anonimizar(error.message).slice(0, 200) });
                    throw error;
                }
            },
            // Ramas en paralelo: si una falla, las demás terminan igual (como en n8n)
            async ramas(...funciones) {
                const resultados = await Promise.allSettled(funciones.map(f => f()));
                const fallo = resultados.find(r => r.status === 'rejected');
                if (fallo) throw fallo.reason;
                return resultados.map(r => r.value);
            },
            programar: (flujoId, datos, minutos) => programar(flujoId, datos, minutos)
        };

        try {
            const resultado = await def.ejecutar(entrada, ctx);
            const hayOmitidos = pasos.some(p => p.estado === 'omitido');
            await cerrarBitacora(bitacoraId, { estado: hayOmitidos ? 'parcial' : 'exito', resultado, pasos, intentos: maxIntentos, inicio });
            return { ok: true, resultado, bitacoraId, pasos };
        } catch (error) {
            const diagnostico = diagnosticar(error, def) || {};
            registro.error(`❌ [${def.central}] ${def.flujo}: ${anonimizar(error.message)}`);

            // Problema temporal: se reintenta más tarde desde la cola, sin repetir lo ya hecho.
            const espera = REENCOLAR_MINUTOS[reencolados];
            const reencolar = def.reencolar !== false && !error.permanente && espera !== undefined;
            if (reencolar) {
                try {
                    await programar(def.id, entrada, espera, { pasos: completados, reencolados: reencolados + 1 });
                } catch (errorCola) {
                    registro.error('⚠️ No se pudo reencolar el flujo:', errorCola.message);
                }
            }

            await cerrarBitacora(bitacoraId, { estado: 'error', resultado: reencolar ? { reintento_en_minutos: espera } : null, pasos, intentos: maxIntentos, error, diagnostico, inicio });

            // Solo se avisa cuando ya no quedan reintentos; el monitor no se vigila a sí mismo.
            if (!reencolar && !def.esMonitor) {
                try {
                    await alFallar({ def, error, diagnostico, disparador });
                } catch (errorAviso) {
                    registro.error('⚠️ No se pudo avisar del error:', errorAviso.message);
                }
            }
            return { ok: false, error, bitacoraId, pasos, reencolado: reencolar };
        }
    }

    // def: { id, central, flujo, evento?, cron?, reencolar?, esMonitor?, ejecutar(entrada, ctx) }
    function registrar(def) {
        if (flujos.has(def.id)) throw new Error(`Flujo repetido: ${def.id}`);
        flujos.set(def.id, def);
        if (def.evento) bus.on(def.evento, (datos) => ejecutar(def, datos, { disparador: `evento:${def.evento}` }));
    }

    return {
        registrar,
        ejecutar,
        programar,
        procesarCola,

        // Nunca lanza error ni bloquea: la respuesta al cliente no espera a las automatizaciones
        emitir(evento, datos) {
            setImmediate(() => bus.emit(evento, datos));
        },

        // Ejecuta un flujo por su id (ej. "Ejecutar ahora" desde el panel admin)
        ejecutarPorId(id, entrada = {}, disparador = 'manual') {
            const def = flujos.get(id);
            if (!def) throw new Error(`Flujo desconocido: ${id}`);
            return ejecutar(def, entrada, { disparador });
        },

        catalogo() {
            return [...flujos.values()].map(({ id, central, flujo, evento, cron: expresion }) =>
                ({ id, central, flujo, evento: evento || null, cron: expresion || null }));
        },

        async iniciar() {
            // Una tarea "en curso" tras un reinicio quedó a medias: vuelve a la cola
            await db.query(`UPDATE automatizacion_tareas SET estado = 'pendiente' WHERE estado = 'en_curso'`);

            for (const def of flujos.values()) {
                if (!def.cron) continue;
                tareasCron.push(cron.schedule(def.cron, () => ejecutar(def, {}, { disparador: `cron:${def.cron}` }), { timezone: ZONA_HORARIA }));
            }
            temporizadorCola = setInterval(() => {
                procesarCola().catch(error => registro.error('⚠️ Error revisando la cola:', error.message));
            }, REVISAR_COLA_MS);
            temporizadorCola.unref();
        },

        detener() {
            tareasCron.splice(0).forEach(t => t.stop());
            clearInterval(temporizadorCola);
        }
    };
}

module.exports = { crearMotor, conReintentos, REENCOLAR_MINUTOS };
