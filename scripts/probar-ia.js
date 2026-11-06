// scripts/probar-ia.js
// Comprueba en vivo cuáles modelos configurados responden. Uso: npm run ia:probar
// Envía una pregunta de ejemplo, sin datos personales. Nunca muestra las claves.

process.loadEnvFile();

const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { proveedoresDesdeEntorno, errorSeguro, conLimite } = require('../servicios/ia');

const TIEMPO_MS = 15000;

(async () => {
    const proveedores = proveedoresDesdeEntorno();
    if (proveedores.length === 0) {
        console.log('No hay modelos configurados: revisa GEMINI_API_KEY y GROQ_API_KEY en el .env');
        return;
    }

    const mensajes = [new SystemMessage('Responde en español en máximo 10 palabras.'), new HumanMessage('¿Qué se puede desayunar en los Andes?')];
    let funcionan = 0;
    for (const p of proveedores) {
        const inicio = Date.now();
        try {
            const r = await conLimite((signal) => p.crear().invoke(mensajes, { signal }), TIEMPO_MS);
            funcionan++;
            console.log(`✅ ${p.nombre}/${p.modelo} (${Date.now() - inicio} ms): ${String(r.content).replace(/\s+/g, ' ').slice(0, 70)}`);
        } catch (error) {
            console.log(`❌ ${p.nombre}/${p.modelo} (${Date.now() - inicio} ms): ${errorSeguro(error).replace(/\s+/g, ' ').slice(0, 140)}`);
        }
    }
    console.log(`\n${funcionan} de ${proveedores.length} modelos respondieron.`);
    process.exit(0);
})();
