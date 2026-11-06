// Pruebas de la capa de IA: plan B entre modelos, herramientas, memoria y auditoría (sin internet)
const { test } = require('node:test');
const assert = require('node:assert');
const { crearIA, proveedoresDesdeEntorno, errorSeguro, tipoDeFalla, conLimite } = require('../servicios/ia');
const { crearChatbotIA, crearHerramientas, buscarEnCatalogo, memoria } = require('../servicios/ia/chatbot');

const silencio = { error() {}, warn() {} };

// Modelo falso: devuelve las respuestas indicadas y guarda los mensajes que recibe
function modeloFalso(nombre, respuestas) {
    const estado = { llamadas: [], herramientas: null };
    return {
        nombre, modelo: `${nombre}-falso`, estado,
        crear: () => ({
            bindTools(h) { estado.herramientas = h; return this; },
            async invoke(mensajes) {
                estado.llamadas.push(mensajes);
                const r = respuestas.shift();
                if (r instanceof Error) throw r;
                return r;
            }
        })
    };
}

function bdAuditoria() {
    const bd = { filas: [], async query(sql, v = []) {
        if (sql.includes('INSERT INTO ia_auditoria')) bd.filas.push({ funcion: v[0], proveedor: v[2], entrada: v[4], resultado: v[5], exito: v[7], error: v[8] });
        if (sql.includes('FROM pedidos')) { bd.usuarioConsultado = v[0]; return [[{ id: 5, estado: 'enviado', total: 1000 }]]; }
        return [[]];
    } };
    return bd;
}

const preguntar = (ia) => ia.generar({ funcion: 'prueba', sistema: 'Sistema', pregunta: 'hola' });

test('usa Gemini cuando responde', async () => {
    const bd = bdAuditoria();
    const groq = modeloFalso('groq', [{ content: 'de groq' }]);
    const ia = crearIA({ db: bd, registro: silencio, proveedores: [modeloFalso('gemini', [{ content: 'de gemini' }]), groq] });
    const r = await preguntar(ia);
    assert.strictEqual(r.texto, 'de gemini');
    assert.strictEqual(r.proveedor, 'gemini');
    assert.strictEqual(groq.estado.llamadas.length, 0);
    assert.strictEqual(bd.filas[0].exito, 1);
});

test('plan B: si Gemini falla responde Groq y ambos intentos quedan auditados', async () => {
    const bd = bdAuditoria();
    const ia = crearIA({ db: bd, registro: silencio, proveedores: [modeloFalso('gemini', [new Error('503 overloaded')]), modeloFalso('groq', [{ content: 'de groq' }])] });
    const r = await preguntar(ia);
    assert.strictEqual(r.proveedor, 'groq');
    assert.deepStrictEqual(bd.filas.map(f => [f.proveedor, f.exito]), [['gemini', 0], ['groq', 1]]);
});

test('una respuesta vacía cuenta como falla y pasa al siguiente modelo', async () => {
    const ia = crearIA({ registro: silencio, proveedores: [modeloFalso('gemini', [{ content: '   ' }]), modeloFalso('groq', [{ content: 'ok' }])] });
    assert.strictEqual((await preguntar(ia)).proveedor, 'groq');
});

test('si ningún modelo responde lanza un error claro (quien llama usa su respaldo)', async () => {
    const ia = crearIA({ registro: silencio, proveedores: [modeloFalso('gemini', [new Error('caído')])] });
    await assert.rejects(preguntar(ia), /Ningún modelo de IA respondió/);
    await assert.rejects(preguntar(crearIA({ registro: silencio, proveedores: [] })), /No hay modelos de IA configurados/);
});

test('cuota agotada: deja de insistirle a ese modelo por un minuto', async () => {
    const gemini = modeloFalso('gemini', [new Error('429 quota exceeded')]);
    const ia = crearIA({ registro: silencio, proveedores: [gemini, modeloFalso('groq', [{ content: 'a' }, { content: 'b' }])] });
    await preguntar(ia);
    await preguntar(ia);
    assert.strictEqual(gemini.estado.llamadas.length, 1);
    assert.strictEqual(ia.estado()[0].en_espera, true);
});

test('las preguntas se anonimizan antes de salir hacia el modelo y en la auditoría', async () => {
    const bd = bdAuditoria();
    const gemini = modeloFalso('gemini', [{ content: 'ok' }]);
    const ia = crearIA({ db: bd, registro: silencio, proveedores: [gemini] });
    await ia.generar({ funcion: 'chatbot', sistema: 'S', pregunta: 'mi correo es ana@gmail.com y mi cel 3001234567' });
    const enviado = gemini.estado.llamadas[0].at(-1).content;
    assert.doesNotMatch(enviado, /ana@gmail|3001234567/);
    assert.doesNotMatch(bd.filas[0].entrada, /ana@gmail|3001234567/);
});

test('un modelo colgado no bloquea al cliente: se corta y responde el siguiente', async () => {
    const colgado = { nombre: 'gemini', modelo: 'colgado', crear: () => ({ invoke: () => new Promise(() => {}) }) };
    const ia = crearIA({ registro: silencio, proveedores: [colgado, modeloFalso('groq', [{ content: 'de groq' }])] });
    const inicio = Date.now();
    const r = await ia.generar({ funcion: 'prueba', sistema: 'S', pregunta: 'hola', tiempoPorModelo: 50 });
    assert.strictEqual(r.proveedor, 'groq');
    assert.ok(Date.now() - inicio < 1000);
});

test('el tiempo total se respeta aunque queden modelos por probar', async () => {
    const colgado = (modelo) => ({ nombre: 'gemini', modelo, crear: () => ({ invoke: () => new Promise(() => {}) }) });
    const ia = crearIA({ registro: silencio, proveedores: [colgado('a'), colgado('b'), colgado('c')] });
    const inicio = Date.now();
    await assert.rejects(ia.generar({ funcion: 'prueba', sistema: 'S', pregunta: 'hola', tiempoPorModelo: 50, tiempoTotal: 80 }), /Ningún modelo/);
    assert.ok(Date.now() - inicio < 500);
});

test('un modelo saturado descansa y el siguiente mensaje no lo espera', async () => {
    const saturado = modeloFalso('gemini', [new Error('[503 Service Unavailable] high demand')]);
    const ia = crearIA({ registro: silencio, proveedores: [saturado, modeloFalso('groq', [{ content: 'a' }, { content: 'b' }])] });
    await preguntar(ia);
    await preguntar(ia);
    assert.strictEqual(saturado.estado.llamadas.length, 1);
});

test('dentro de un proveedor, si un modelo falla se prueba otro del mismo', async () => {
    const a = { ...modeloFalso('gemini', [new Error('[503] high demand')]), modelo: 'a' };
    const b = { ...modeloFalso('gemini', [{ content: 'de b' }]), modelo: 'b' };
    const r = await preguntar(crearIA({ registro: silencio, proveedores: [a, b] }));
    assert.strictEqual(r.modelo, 'b');
    assert.strictEqual(r.texto, 'de b');
});

test('clasifica las fallas de los proveedores', () => {
    assert.strictEqual(tipoDeFalla(new Error('429 quota exceeded')), 'cuota');
    assert.strictEqual(tipoDeFalla(new Error('[503 Service Unavailable] high demand')), 'saturado');
    assert.strictEqual(tipoDeFalla(new Error('The model does not exist')), 'inexistente');
    assert.strictEqual(tipoDeFalla(new Error('otra cosa')), null);
});

test('conLimite corta y cancela una tarea que no termina', async () => {
    let cancelada = false;
    await assert.rejects(conLimite((senal) => {
        senal.addEventListener('abort', () => { cancelada = true; });
        return new Promise(() => {});
    }, 20), (e) => e.tiempoAgotado === true);
    assert.strictEqual(cancelada, true);
});

test('un error del proveedor no deja claves en la auditoría', () => {
    assert.doesNotMatch(errorSeguro(new Error('fallo en https://x.com?key=ABC123SECRETO')), /ABC123SECRETO/);
});

test('el modelo puede usar una herramienta y recibe su resultado', async () => {
    const gemini = modeloFalso('gemini', [
        { content: '', tool_calls: [{ id: 'l1', name: 'buscar_productos', args: { consulta: 'cafe' } }] },
        { content: 'El café cuesta $10.000' }
    ]);
    const ia = crearIA({ registro: silencio, proveedores: [gemini] });
    const catalogo = [{ nombre: 'Café de origen', descripcion: 'Tostado', categoria_nombre: 'Bebidas', precio_final: 10000, descuento: 0, stock: 4 }];
    const r = await ia.generar({ funcion: 'chatbot', sistema: 'S', pregunta: '¿qué café tienen?', herramientas: crearHerramientas({ catalogo }) });
    assert.strictEqual(r.texto, 'El café cuesta $10.000');
    assert.deepStrictEqual(r.herramientas, ['buscar_productos']);
    assert.match(gemini.estado.llamadas[1].at(-1).content, /Café de origen/);
});

test('buscar en el catálogo ignora tildes y mayúsculas', () => {
    const catalogo = [{ nombre: 'Café', descripcion: '' }, { nombre: 'Miel de páramo', descripcion: '' }];
    assert.deepStrictEqual(buscarEnCatalogo(catalogo, 'CAFE').map(p => p.nombre), ['Café']);
    assert.deepStrictEqual(buscarEnCatalogo(catalogo, 'paramo').map(p => p.nombre), ['Miel de páramo']);
    assert.deepStrictEqual(buscarEnCatalogo(catalogo, 'zapatos'), []);
});

test('un visitante no tiene la herramienta de pedidos; un cliente solo ve los suyos', async () => {
    const bd = bdAuditoria();
    assert.deepStrictEqual(crearHerramientas({ db: bd, catalogo: [] }).map(h => h.name), ['buscar_productos']);

    const conSesion = crearHerramientas({ db: bd, catalogo: [], usuarioId: 42 });
    const pedidos = conSesion.find(h => h.name === 'estado_de_mis_pedidos');
    // Aunque el modelo envíe otro usuario, se consulta el de la sesión
    const salida = await pedidos.invoke({ usuario_id: 99 });
    assert.strictEqual(bd.usuarioConsultado, 42);
    assert.match(salida, /enviado/);
});

test('memoria: el historial se convierte en mensajes sin datos personales', () => {
    const m = memoria([{ de: 'cliente', texto: 'escríbeme a ana@gmail.com' }, { de: 'bot', texto: 'Claro' }]);
    assert.strictEqual(m[0].getType(), 'human');
    assert.strictEqual(m[1].getType(), 'ai');
    assert.doesNotMatch(m[0].content, /ana@gmail/);
});

test('CHATBOT_IA=false apaga la IA del chat sin llamar a ningún modelo', async () => {
    const gemini = modeloFalso('gemini', []);
    const ia = crearIA({ registro: silencio, proveedores: [gemini] });
    const chatbot = crearChatbotIA({ ia, entorno: { CHATBOT_IA: 'false' } });
    assert.strictEqual(await chatbot.responder({ texto: 'hola', catalogo: [] }), null);
    assert.strictEqual(gemini.estado.llamadas.length, 0);
});

test('sin claves no hay proveedores; con claves aparecen en el orden del plan B', () => {
    assert.deepStrictEqual(proveedoresDesdeEntorno({}), []);
    const lista = proveedoresDesdeEntorno({ GROQ_API_KEY: 'g', GEMINI_API_KEY: 'x', GEMINI_MODELOS: 'models/a, b', GROQ_MODELOS: 'c', OLLAMA_URL: 'http://localhost:11434' });
    assert.deepStrictEqual(lista.map(p => `${p.nombre}/${p.modelo}`), ['gemini/a', 'gemini/b', 'groq/c', 'ollama/llama3.2']);
    const porDefecto = proveedoresDesdeEntorno({ GEMINI_API_KEY: 'x', GROQ_API_KEY: 'g' });
    assert.ok(porDefecto.filter(p => p.nombre === 'gemini').length >= 2, 'debe haber varios modelos de respaldo');
    assert.ok(porDefecto.filter(p => p.nombre === 'groq').length >= 2);
});

test('los modelos reales de LangChain aceptan las herramientas del chatbot', () => {
    const herramientas = crearHerramientas({ db: bdAuditoria(), catalogo: [], usuarioId: 1 });
    for (const p of proveedoresDesdeEntorno({ GEMINI_API_KEY: 'x', GROQ_API_KEY: 'x', OLLAMA_URL: 'http://localhost:11434' })) {
        assert.doesNotThrow(() => p.crear().bindTools(herramientas), `${p.nombre} no aceptó las herramientas`);
    }
});
