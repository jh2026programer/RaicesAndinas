// servicios/ia/index.js
// Capa de IA con LangChain. Plan B ante fallas o cuota agotada:
//   Gemini (principal) → Groq (si falla) → Ollama local (si está configurado) → error controlado
// Quien llama decide qué hacer si no hay IA (el chatbot usa sus reglas, las órdenes un texto base).
// Cada intento queda en la tabla de auditoría (ia_auditoria).

const { HumanMessage, SystemMessage, ToolMessage } = require('@langchain/core/messages');
const { anonimizar } = require('../automatizacion/privacidad');

const TIEMPO_MAXIMO_MS = 25000;
const MAX_RONDAS_HERRAMIENTAS = 3;
const ENFRIAMIENTO_CUOTA_MS = 60 * 1000;

// Proveedores disponibles según las claves del .env (las claves nunca van en el código)
function proveedoresDesdeEntorno(entorno = process.env) {
    const lista = [];
    if (entorno.GEMINI_API_KEY) {
        const modelo = String(entorno.GEMINI_MODELO || 'gemini-3.8-flash').replace(/^models\//, '');
        lista.push({
            nombre: 'gemini', modelo,
            crear() {
                const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
                return new ChatGoogleGenerativeAI({ apiKey: entorno.GEMINI_API_KEY, model: modelo, temperature: 0.4, maxOutputTokens: 2048, maxRetries: 0 });
            }
        });
    }
    if (entorno.GROQ_API_KEY) {
        const modelo = entorno.GROQ_MODELO || 'llama-3.3-70b-versatile';
        lista.push({
            nombre: 'groq', modelo,
            crear() {
                const { ChatGroq } = require('@langchain/groq');
                return new ChatGroq({ apiKey: entorno.GROQ_API_KEY, model: modelo, temperature: 0.4, maxTokens: 1024, maxRetries: 0 });
            }
        });
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

const esCuotaAgotada = (error) => /429|quota|rate.?limit|resource.?exhausted/i.test(`${error.status || ''} ${error.message || ''}`);

// El mensaje de error de un proveedor podría incluir una clave: nunca se guarda completo
const errorSeguro = (error) => anonimizar(String(error.message || error)).replace(/(key|token)=[^\s&]+/gi, '$1=***').slice(0, 300);

function crearIA({ db, proveedores = proveedoresDesdeEntorno(), registro = console } = {}) {
    const enfriando = new Map();

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

    // Devuelve { texto, proveedor, modelo, herramientas } o lanza error si ningún proveedor responde
    async function generar({ funcion, sistema, historial = [], pregunta, herramientas = [], usuarioId = null, tiempoMaximo = TIEMPO_MAXIMO_MS }) {
        const preguntaSegura = anonimizar(pregunta);
        const mensajes = [new SystemMessage(sistema), ...historial, new HumanMessage(preguntaSegura)];
        const errores = [];

        for (const proveedor of proveedores) {
            if (Date.now() < (enfriando.get(proveedor.nombre) || 0)) {
                errores.push(`${proveedor.nombre}: en espera por cuota agotada`);
                continue;
            }
            const inicio = Date.now();
            const base = { funcion, usuarioId, proveedor: proveedor.nombre, modelo: proveedor.modelo, entrada: preguntaSegura };
            try {
                const { texto, usadas } = await conversar(proveedor, mensajes, herramientas, AbortSignal.timeout(tiempoMaximo));
                if (!texto) throw new Error('El modelo devolvió una respuesta vacía');
                await auditar({ ...base, resultado: texto, exito: true, duracion: Date.now() - inicio });
                return { texto, proveedor: proveedor.nombre, modelo: proveedor.modelo, herramientas: usadas };
            } catch (error) {
                const detalle = errorSeguro(error);
                errores.push(`${proveedor.nombre}: ${detalle}`);
                registro.warn(`⚠️ IA ${proveedor.nombre} falló: ${detalle}`);
                if (esCuotaAgotada(error)) enfriando.set(proveedor.nombre, Date.now() + ENFRIAMIENTO_CUOTA_MS);
                await auditar({ ...base, error: detalle, exito: false, duracion: Date.now() - inicio });
            }
        }
        throw new Error(proveedores.length ? `Ningún modelo de IA respondió (${errores.join(' | ')})` : 'No hay modelos de IA configurados');
    }

    return {
        generar,
        generarTexto: async (opciones) => (await generar(opciones)).texto,
        estado: () => proveedores.map(p => ({ nombre: p.nombre, modelo: p.modelo, en_espera: Date.now() < (enfriando.get(p.nombre) || 0) }))
    };
}

module.exports = { crearIA, proveedoresDesdeEntorno, errorSeguro };
