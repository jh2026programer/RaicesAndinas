// scripts/evaluar-facturas.js
// Mide la precisión del módulo de visión con fotos reales y reporta el % de aciertos por campo.
// 1) Imprime pruebas-facturas/facturas-para-imprimir.pdf y fotografía cada hoja con el celular.
// 2) Guarda las fotos en pruebas-facturas/fotos/ con el código de la hoja: F01.jpg, F02.jpg, ...
//    También sirve el número de la hoja: 1.jpeg, 2.jpeg, ...
// 3) npm run facturas:evaluar           →  pruebas-facturas/resultados.md
//    (se puede indicar otra carpeta y una nota sobre cómo se tomaron las imágenes:
//     node scripts/evaluar-facturas.js <carpeta> <archivo-salida.md> "<nota>")

process.loadEnvFile();

const fs = require('fs');
const path = require('path');
const { identificarArchivo } = require('../servicios/vision/imagen');
const { crearExtractor } = require('../servicios/vision/extractor');
const { leerFactura } = require('../servicios/vision/lector');
const { cerrarOCR, leerConOCR, LIMPIEZAS } = require('../servicios/vision/anonimizar');
const { normalizar } = require('../servicios/vision/validacion');

const RAIZ = path.join(__dirname, '..', 'pruebas-facturas');
const CARPETA = path.resolve(process.argv[2] || path.join(RAIZ, 'fotos'));
const SALIDA = path.resolve(process.argv[3] || path.join(RAIZ, 'resultados.md'));
const NOTA = process.argv[4] || '';
const PAUSA_MS = 5000; // para respetar el límite por minuto del nivel gratuito

// "F07.jpg" o "7.jpeg" → "F07"
function codigoDe(nombre) {
    const m = nombre.match(/^F?(\d{1,2})\.(jpe?g|png|webp|pdf)$/i);
    return m ? `F${m[1].padStart(2, '0')}` : null;
}

const textoIgual = (a, b) => normalizar(a) === normalizar(b);
const soloCaracteres = (v) => String(v ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();

const COMPARAR = {
    proveedor: (a, b) => textoIgual(a, b),
    nit: (a, b) => (b === null ? a === null : soloCaracteres(a) === soloCaracteres(b)),
    numero: (a, b) => soloCaracteres(a) === soloCaracteres(b),
    fecha: (a, b) => a === b,
    subtotal: (a, b) => Number(a) === Number(b),
    iva: (a, b) => Number(a) === Number(b),
    total: (a, b) => Number(a) === Number(b)
};

function compararItems(leidos = [], reales = []) {
    let aciertos = 0;
    for (const real of reales) {
        const it = leidos.find(x => textoIgual(x.descripcion, real.descripcion));
        if (it && Number(it.cantidad) === real.cantidad && Number(it.valor_unitario) === real.valor_unitario && Number(it.subtotal) === real.subtotal) aciertos++;
    }
    return { aciertos, total: reales.length };
}

async function catalogoDeLaTienda() {
    const mysql = require('mysql2/promise');
    const db = await mysql.createConnection({ host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'raices_andinas' });
    const [filas] = await db.query('SELECT id, nombre FROM productos');
    await db.end();
    return filas;
}

(async () => {
    const verdad = JSON.parse(fs.readFileSync(path.join(RAIZ, 'verdad.json'), 'utf8'));
    const archivos = fs.existsSync(CARPETA) ? fs.readdirSync(CARPETA).filter(f => codigoDe(f)).sort((a, b) => codigoDe(a).localeCompare(codigoDe(b))) : [];
    if (archivos.length === 0) {
        console.log(`No hay fotos en ${CARPETA}. Deben llamarse F01.jpg o 1.jpg, según el código al pie de cada hoja.`);
        process.exit(1);
    }

    const catalogo = await catalogoDeLaTienda();
    const extractor = crearExtractor();
    const campos = Object.fromEntries(Object.keys(COMPARAR).map(c => [c, { aciertos: 0, total: 0 }]));
    const items = { aciertos: 0, total: 0 };
    const privacidad = { datos: 0, filtrados: 0, detalle: [] };
    const filas = [];
    const decisiones = { lista: 0, por_revisar: 0, no_legible: 0, error: 0 };
    const seguridad = { auto_con_error: 0, auto: 0 };

    for (const nombre of archivos) {
        const codigo = codigoDe(nombre);
        const real = verdad[codigo];
        if (!real) continue;
        const archivo = fs.readFileSync(path.join(CARPETA, nombre));
        const { tipo } = identificarArchivo(archivo);
        const inicio = Date.now();
        process.stdout.write(`${codigo}... `);

        let r;
        try {
            r = await leerFactura({ archivo, tipo, catalogo, extractor, entrada: codigo });
        } catch (error) {
            decisiones.error++;
            console.log(`error: ${error.message.slice(0, 120)}`);
            filas.push(`| ${codigo} | error | — | — | — | ${error.message.slice(0, 80)} |`);
            for (const c of Object.keys(campos)) campos[c].total++;
            items.total += real.items.length;
            continue;
        }
        decisiones[r.estado]++;

        const d = r.validacion?.datos || {};
        const fallados = [];
        for (const [c, igual] of Object.entries(COMPARAR)) {
            campos[c].total++;
            if (r.validacion && igual(d[c] ?? null, real[c])) campos[c].aciertos++;
            else fallados.push(c);
        }
        const ci = compararItems(d.items, real.items);
        items.aciertos += ci.aciertos;
        items.total += ci.total;
        if (ci.aciertos < ci.total) fallados.push(`productos ${ci.aciertos}/${ci.total}`);

        // ¿Algún dato personal sigue legible en la imagen que sale hacia la IA? Se comprueba releyéndola con el OCR.
        let filtrados = [];
        if (r.anon.imagen) {
            let texto = '';
            for (const limpieza of LIMPIEZAS) texto += ` ${normalizar((await leerConOCR(r.anon.imagen, limpieza)).map(l => l.texto).join(' '))}`;
            filtrados = real.datos_personales.filter(p => texto.includes(normalizar(p)));
        }
        privacidad.datos += real.datos_personales.length;
        privacidad.filtrados += filtrados.length;
        if (filtrados.length) privacidad.detalle.push(`${codigo}: ${filtrados.length}`);

        if (r.estado === 'lista') {
            seguridad.auto++;
            if (fallados.length) seguridad.auto_con_error++;
        }

        const seg = ((Date.now() - inicio) / 1000).toFixed(1);
        const conf = r.validacion ? r.validacion.confianza_global : '—';
        const modelo = r.lectura ? `${r.lectura.modelo} (${r.lectura.modo})` : '—';
        console.log(`${r.estado} · confianza ${conf} · ${seg} s · ${fallados.join(', ') || 'todo correcto'}`);
        filas.push(`| ${codigo} | ${r.estado} | ${conf} | ${modelo} | ${seg} s | ${fallados.join(', ') || 'todo correcto'} |`);
        await new Promise(res => setTimeout(res, PAUSA_MS));
    }
    await cerrarOCR();

    const pct = (a, t) => (t ? `${(a / t * 100).toFixed(1)} %` : '—');
    const totalCampos = Object.values(campos).reduce((s, c) => ({ aciertos: s.aciertos + c.aciertos, total: s.total + c.total }), { aciertos: 0, total: 0 });
    const reporte = [
        `# Resultados del módulo de visión`,
        '',
        `Fotos evaluadas: **${filas.length}** (${CARPETA.includes('fotos') ? 'carpeta de fotos' : path.basename(CARPETA)}). Fecha: ${new Date().toISOString().slice(0, 10)}.`,
        '',
        ...(NOTA ? [`**Cómo se tomaron las imágenes:** ${NOTA}`, ''] : []),
        '## Aciertos por campo',
        '',
        '| Campo | Aciertos | Porcentaje |',
        '| --- | --- | --- |',
        ...Object.entries(campos).map(([c, v]) => `| ${c} | ${v.aciertos}/${v.total} | ${pct(v.aciertos, v.total)} |`),
        `| productos (línea completa) | ${items.aciertos}/${items.total} | ${pct(items.aciertos, items.total)} |`,
        `| **Total de campos** | **${totalCampos.aciertos + items.aciertos}/${totalCampos.total + items.total}** | **${pct(totalCampos.aciertos + items.aciertos, totalCampos.total + items.total)}** |`,
        '',
        '## Decisión del sistema',
        '',
        `- Listas para confirmar: ${decisiones.lista}`,
        `- Enviadas a revisión humana: ${decisiones.por_revisar}`,
        `- Rechazadas por ilegibles: ${decisiones.no_legible}`,
        `- Con error: ${decisiones.error}`,
        `- Marcadas "lista" que tenían algún error: ${seguridad.auto_con_error} de ${seguridad.auto}`,
        '',
        '## Protección de datos personales',
        '',
        `Datos personales impresos: ${privacidad.datos}. El OCR todavía los lee en la imagen enviada a la IA: ${privacidad.filtrados}${privacidad.detalle.length ? ` (${privacidad.detalle.join(', ')})` : ''}.`,
        '',
        '> Este conteo es solo un límite inferior: en fotos malas el OCR no lee datos que una persona sí puede leer. La medida válida es revisar a ojo las imágenes tapadas.',
        '',
        '## Detalle',
        '',
        '| Factura | Decisión | Confianza | Modelo | Tiempo | Fallos |',
        '| --- | --- | --- | --- | --- | --- |',
        ...filas,
        ''
    ].join('\n');
    fs.writeFileSync(SALIDA, reporte);
    console.log(`\n${reporte.split('## Detalle')[0]}\nReporte guardado en ${SALIDA}`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(2); });
