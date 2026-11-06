// servicios/ia/index.js
// Capa de IA con LangChain. Plan B ante fallas o cuota agotada:
//   modelos de Gemini → modelos de Groq → Ollama local (si está configurado) → error controlado
// Quien llama decide qué hacer si no hay IA (el chatbot usa sus reglas, las órdenes un texto base).
// Cada intento queda en la tabla de auditoría (ia_auditoria).

const { HumanMessage, SystemMessage, ToolMessage } = require('@langchain/core/messages');
const { anonimizar } = require('../automatizacion/privacidad');

// Los modelos gratuitos cambian con el tiempo: se ajustan con GEMINI_MODELOS y GROQ_MODELOS en el .env
// (comprobar cuáles responden con: npm run ia:probar)
const MODELOS_GEMINI = 'gemini-3.5-flash-lite,gemini-3.6-flash,gemini-3.1-flash-lite';
const MODELOS_GROQ = 'openai/gpt-oss-20b,qwen/qwen3.8-27b,openai/gpt-oss-120b';

const TIEMPO_POR_MODELO_MS = 12000;
const TIEMPO_TOTAL_MS = 25000;
const MAX_RONDAS_HERRAMIENTAS = 3;

// Cuánto se deja descansar un modelo que falló, para no hacer esperar al siguiente cliente
const ENFRIAMIENTO_MS = {
    cuota: 60 * 1000,          // 429: cuota agotada
    saturado: 30 * 1000,       // 503 o se tardó demasiado
    inexistente: 60 * 60 * 1000 // 404: el proveedor retiró el modelo
};

const listaModelos = (texto) => String(texto).split(',').map(m => m.trim().replace(/^models\//, '')).filter(Boolean);

// Proveedores disponibles según las claves del .env (las claves nunca van en el código)
function proveedoresDesdeEntorno(entorno = process.env) {
    const lista = [];
    if (entorno.GEMINI_API_KEY) {
        for (const modelo of listaModelos(entorno.GEMINI_MODELOS || MODELOS_GEMINI)) {
            lista.push({
                nombre: 'gemini', modelo,
                crear() {
                    const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
                    return new ChatGoogleGenerativeAI({ apiKey: entorno.GEMINI_API_KEY, model: modelo, temperature: 0.4, maxOutputTokens: 2048, maxRetries: 0 });
                }
            });
        }
    }
    if (entorno.GROQ_API_KEY) {
        for (const modelo of listaModelos(entorno.GROQ_MODELOS || MODELOS_GROQ)) {
            lista.push({
                nombre: 'groq', modelo,
                crear() {
                    const { ChatGroq } = require('@langchain/groq');
                    return new ChatGroq({ apiKey: entorno.GROQ_API_KEY, model: modelo, temperature: 0.4, maxTokens: 1024, maxRetries: 0 });
                }
            });
        }
    }
    if (entorno.OLLAMA_URL) {
        const modelo = entorno.OLLAMA_MODELO || 'llama3.2';
        lista.push({
            nombre: 'ollama', modelo,
            crear() {
                const { ChatOllama } = require('@langchain/ollama');
                return new ChatOllama({ baseUrl: entorno.OLLAMA_URL, model: modelo, temperature: 0.4 });
            }
        });
    }
    return lista;
}

function textoDe(respuesta) {
    const c = respuesta.content;
    const texto = typeof c === 'string' ? c : (c || []).filter(p => p.type === 'text').map(p => p.text).join('');
    return texto.trim();
}

function tipoDeFalla(error) {
    const texto = `${error.status || ''} ${error.message || ''}`;
    if (/429|quota|rate.?limit|resource.?exhausted/i.test(texto)) return 'cuota';
    if (/404|does not exist|not found|no longer available/i.test(texto)) return 'inexistente';
    if (error.tiempoAgotado || /503|overloaded|high demand|unavailable|fetch failed/i.test(texto)) return 'saturado';
    return null;
}

// Límite real de tiempo: la librería de Gemini puede ignorar la señal de cancelación y colgarse minutos
function conLimite(fn, ms) {
    const control = new AbortController();
    let temporizador;
    const limite = new Promise((_, rechazar) => {
        temporizador = setTimeout(() => {
            control.abort();
            rechazar(Object.assign(new Error(`El modelo tardó más de ${Math.round(ms / 1000)} s en responder`), { tiempoAgotado: true }));
        }, ms);
    });
    return Promise.race([fn(control.signal), limite]).finally(() => clearTimeout(temporizador));
}

// El mensaje de error de un proveedor podría incluir una clave: nunca se guarda completo
const errorSeguro = (error) => anonimizar(String(error.message || error)).replace(/(key|token)=[^\s&]+/gi, '$1=***').slice(0, 300);

function crearIA({ db, proveedores = proveedoresDesdeEntorno(), registro = console } = {}) {
    const enfriando = new Map();
    const clave = (p) => `${p.nombre}/${p.modelo}`;

    async function auditar(fila) {
        if (!db) return;
        try {
            await db.query(
                `INSERT INTO ia_auditoria (funcion, usuario_id, proveedor, modelo, entrada, resultado, confianza, exito, error, duracion_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [fila.funcion, fila.usuarioId ?? null, fila.proveedor, fila.modelo, String(fila.entrada ?? '').slice(0, 500),
                    fila.resultado ? String(fila.resultado).slice(0, 1000) : null, fila.confianza ?? null,
                    fila.exito ? 1 : 0, fila.error ?? null, fila.duracion]
            );
        } catch (error) {
            registro.error('⚠️ No se pudo escribir la auditoría de IA:', error.message);
        }
    }

    // Conversación con el modelo; si pide usar una herramienta, se ejecuta y se le devuelve el resultado
    async function conversar(proveedor, mensajes, herramientas, señal) {
        const base = proveedor.crear();
        const modelo = herramientas.length ? base.bindTools(herramientas) : base;
        const usadas = [];
        const lista = [...mensajes];

        for (let ronda = 0; ronda < MAX_RONDAS_HERRAMIENTAS; ronda++) {
            const respuesta = await modelo.invoke(lista, { signal: señal });
            if (!respuesta.tool_calls || respuesta.tool_calls.length === 0) return { texto: textoDe(respuesta), usadas };

            lista.push(respuesta);
            for (const llamada of respuesta.tool_calls) {
                const herramienta = herramientas.find(h => h.name === llamada.name);
                usadas.push(llamada.name);
                const salida = herramienta
                    ? await herramienta.invoke(llamada.args).catch(error => `No se pudo consultar: ${error.message}`)
                    : 'Esa herramienta no existe.';
                lista.push(new ToolMessage({ tool_call_id: llamada.id, name: llamada.name, content: String(salida) }));
            }
        }
        // Demasiadas rondas: se pide la respuesta final sin más herramientas
        return { texto: textoDe(await base.invoke(lista, { signal: señal })), usadas };
    }

    // Devuelve { texto, proveedor, modelo, herramientas } o lanza error si ningún modelo responde
    async function generar({ funcion, sistema, historial = [], pregunta, herramientas = [], usuarioId = null, tiempoPorModelo = TIEMPO_POR_MODELO_MS, tiempoTotal = TIEMPO_TOTAL_MS }) {
        const preguntaSegura = anonimizar(pregunta);
        const mensajes = [new SystemMessage(sistema), ...historial, new HumanMessage(preguntaSegura)];
        const errores = [];
        const limiteTotal = Date.now() + tiempoTotal;

        for (const proveedor of proveedores) {
            if (Date.now() < (enfriando.get(clave(proveedor)) || 0)) continue;
            const restante = limiteTotal - Date.now();
            if (restante <= 0) {
                errores.push('se agotó el tiempo total');
                break;
            }

            const inicio = Date.now();
            const base = { funcion, usuarioId, proveedor: proveedor.nombre, modelo: proveedor.modelo, entrada: preguntaSegura };
            try {
                const { texto, usadas } = await conLimite(
                    (señal) => conversar(proveedor, mensajes, herramientas, señal),
                    Math.min(tiempoPorModelo, restante)
                );
                if (!texto) throw new Error('El modelo devolvió una respuesta vacía');
                await auditar({ ...base, resultado: texto, exito: true, duracion: Date.now() - inicio });
                return { texto, proveedor: proveedor.nombre, modelo: proveedor.modelo, herramientas: usadas };
            } catch (error) {
                const detalle = errorSeguro(error);
                errores.push(`${clave(proveedor)}: ${detalle}`);
                registro.warn(`⚠️ IA ${clave(proveedor)} falló: ${detalle}`);
                const falla = tipoDeFalla(error);
                if (falla) enfriando.set(clave(proveedor), Date.now() + ENFRIAMIENTO_MS[falla]);
                await auditar({ ...base, error: detalle, exito: false, duracion: Date.now() - inicio });
            }
        }
        if (proveedores.length === 0) throw new Error('No hay modelos de IA configurados');
        throw new Error(`Ningún modelo de IA respondió (${errores.join(' | ') || 'todos en espera'})`);
    }

    return {
        generar,
        generarTexto: async (opciones) => (await generar(opciones)).texto,
        estado: () => proveedores.map(p => ({ nombre: p.nombre, modelo: p.modelo, en_espera: Date.now() < (enfriando.get(clave(p)) || 0) }))
    };
}

module.exports = { crearIA, proveedoresDesdeEntorno, errorSeguro, tipoDeFalla, conLimite };
