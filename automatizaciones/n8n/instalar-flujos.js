// automatizaciones/n8n/instalar-flujos.js
// Genera los flujos, los importa en n8n y los publica (activa), todo por terminal.
//
// Requisitos:
//   1. n8n debe estar CERRADO (cerrar la ventana "n8n").
//   2. En n8n deben existir las credenciales "Gmail Raices Andinas" y "Telegram Raices Andinas".
//
// Uso:  npm run n8n:instalar                 (luego volver a abrir n8n)
//       npm run n8n:instalar -- --omitir=09   (instala todos menos el flujo 09)

const { execSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const CARPETA_FLUJOS = path.join(__dirname, 'flujos');
const SOLO_IMPORTAR = process.argv.includes('--sin-publicar');
const OMITIR = (process.argv.find(a => a.startsWith('--omitir=')) || '').replace('--omitir=', '').split(',').filter(Boolean);

function n8n(comando) {
    return execSync(`npx --yes n8n@2.42.5 ${comando}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: os.homedir() });
}

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

    console.log('🛠️  Generando flujos...');
    execSync(`node "${path.join(__dirname, 'generar-flujos.js')}"`, { stdio: 'inherit' });

    const archivos = fs.readdirSync(CARPETA_FLUJOS).filter(a => a.endsWith('.json') && !OMITIR.some(n => a.startsWith(n))).sort();

    for (const archivo of archivos) {
        const ruta = path.join(CARPETA_FLUJOS, archivo);
        const { id, name } = JSON.parse(fs.readFileSync(ruta, 'utf8'));

        try {
            n8n(`import:workflow --input="${ruta}"`);
            console.log(`📥 Importado: ${name}`);

            if (!SOLO_IMPORTAR) {
                n8n(`publish:workflow --id=${id}`);
                console.log(`🟢 Publicado: ${name}`);
            }
        } catch (error) {
            console.error(`❌ Error con ${archivo}:\n${error.stderr || error.message}`);
            process.exit(1);
        }
    }

    console.log('\n✅ Listo. Abre n8n de nuevo (iniciar-todo.bat o "npx n8n") para que los flujos queden activos.');
})();
