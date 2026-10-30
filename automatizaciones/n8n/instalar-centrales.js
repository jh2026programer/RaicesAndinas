// automatizaciones/n8n/instalar-centrales.js
// Instala las 5 centrales de automatización en n8n y apaga (sin borrar) los 13 flujos individuales,
// porque las centrales usan los mismos webhooks y no pueden estar activos dos flujos con el mismo webhook.
//
// Requisito: n8n debe estar CERRADO.
// Uso:  npm run n8n:centrales
// Para volver a los 13 flujos individuales:  npm run n8n:instalar  (y luego despublicar las centrales)

const { execSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const CARPETA = path.join(__dirname, 'centrales');
const FLUJOS_ANTIGUOS = Array.from({ length: 13 }, (_, i) => `RaicesAndinas0${String(i + 1).padStart(2, '0')}`);

const n8n = (comando) => execSync(`npx --yes n8n@2.42.5 ${comando}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: os.homedir() });

function puertoOcupado(puerto) {
    return new Promise(resolve => {
        const socket = net.connect(puerto, '127.0.0.1');
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
    });
}

(async () => {
    if (await puertoOcupado(5678)) {
        console.error('❌ n8n está abierto. Cierra la ventana de n8n y vuelve a ejecutar este comando.');
        process.exit(1);
    }

    console.log('🛠️  Generando centrales...');
    execSync(`node "${path.join(__dirname, 'generar-centrales.js')}"`, { stdio: 'inherit' });

    console.log('\n⏸️  Apagando los flujos individuales (quedan guardados como respaldo)...');
    for (const id of FLUJOS_ANTIGUOS) {
        try {
            n8n(`unpublish:workflow --id=${id}`);
            console.log(`   ⏸️ ${id}`);
        } catch {
            console.log(`   – ${id} (no existía o ya estaba apagado)`);
        }
    }

    // El centro de monitoreo va primero: las demás centrales lo usan como "flujo de errores"
    const archivos = fs.readdirSync(CARPETA).filter(a => a.endsWith('.json'))
        .sort((a, b) => (a.startsWith('C05') ? -1 : b.startsWith('C05') ? 1 : a.localeCompare(b)));

    console.log('\n📥 Instalando centrales...');
    for (const archivo of archivos) {
        const ruta = path.join(CARPETA, archivo);
        const { id, name } = JSON.parse(fs.readFileSync(ruta, 'utf8'));
        try {
            n8n(`import:workflow --input="${ruta}"`);
            n8n(`publish:workflow --id=${id}`);
            console.log(`   🟢 ${name}`);
        } catch (error) {
            console.error(`❌ Error con ${archivo}:\n${error.stderr || error.message}`);
            process.exit(1);
        }
    }

    console.log('\n✅ Listo. Abre n8n de nuevo (iniciar-todo.bat) para que las centrales queden activas.');
})();
