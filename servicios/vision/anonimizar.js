// servicios/vision/anonimizar.js
// Ley 1581: antes de que una imagen salga hacia un servicio externo, un OCR que corre en este
// mismo servidor busca los datos personales y los tapa con rectángulos negros.
// Se conservan el nombre del proveedor y el NIT: son los datos de negocio que el proceso necesita.

const os = require('os');
const path = require('path');
const sharp = require('sharp');

const MIN_PALABRAS_LEGIBLES = 12;
const MARGEN = 5;

const CORREO = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const CELULAR = /(?:^|\D)(?:\+?57[\s.-]*)?3\d{2}[\s.-]*\d{3}[\s.-]*\d{4}(?:\D|$)/;
const FIJO = /\(?\+?(?:60\d|57)\)?[\s.-]*\d{3}[\s.-]*\d{4}/;
const ETIQUETAS_LINEA = [
    // Todo lo que sigue a la etiqueta en esa línea es personal
    { tipo: 'cedula', patron: /^(?:c\.?\s*c\.?|c[eé]dula|documento\s+(?:de\s+)?identidad|identificaci[oó]n)\b/i },
    { tipo: 'telefono', patron: /^(?:tel[eé]?f?o?n?o?s?\.?|cel(?:ular)?\.?|m[oó]vil|whatsapp|contacto)\b/i },
    { tipo: 'direccion', patron: /^(?:direcci[oó]n|dir\.?|domicilio)\b/i },
    { tipo: 'correo', patron: /^(?:correo|e-?mail|email)\b/i },
    { tipo: 'persona', patron: /^(?:vendedor(?:a)?|atendido|atendi[oó]|asesor(?:a)?|cajero(?:a)?|elabor[oó]|recibi[oó]|firma)\b/i }
];
const INICIO_DIRECCION = /^(?:calle|cll|cl|carrera|cra|cr|kr|avenida|av|diagonal|dg|transversal|tv|vereda|manzana|mz)\b\.?/i;

const unirCajas = (cajas) => ({
    x0: Math.min(...cajas.map(c => c.x0)), y0: Math.min(...cajas.map(c => c.y0)),
    x1: Math.max(...cajas.map(c => c.x1)), y1: Math.max(...cajas.map(c => c.y1))
});

// Separa la etiqueta (ej. "Tel:") de su valor. Si la etiqueta y el valor van separados en columnas también funciona.
function palabrasDespuesDeEtiqueta(palabras) {
    const i = palabras.findIndex(p => /[:.]$/.test(p.texto));
    return i >= 0 && i < palabras.length - 1 && i <= 2 ? palabras.slice(i + 1) : palabras.slice(1);
}

// lineas: [{ texto, palabras: [{ texto, caja }] }]. Devuelve las zonas a tapar y el texto ya sin esos datos.
function detectarDatosPersonales(lineas) {
    const zonas = [];
    const textoSeguro = [];

    for (const linea of lineas) {
        const palabras = linea.palabras.filter(p => p.texto.trim());
        if (palabras.length === 0) continue;
        const texto = palabras.map(p => p.texto).join(' ');
        const textoLimpio = texto.replace(/^[^\p{L}\d(+]+/u, '');

        let tapar = null;
        let tipo = null;

        // 1. Línea con etiqueta
        const etiqueta = ETIQUETAS_LINEA.find(e => e.patron.test(textoLimpio));
        if (etiqueta && palabras.length > 1) {
            tapar = palabrasDespuesDeEtiqueta(palabras);
            tipo = etiqueta.tipo;
        }

        // 2. Sin etiqueta: se reconoce por la forma del dato. "NIT" nunca se tapa.
        if (!tapar && !/\bnit\b/i.test(texto)) {
            const correo = palabras.filter(p => CORREO.test(p.texto));
            if (correo.length) {
                tapar = correo;
                tipo = 'correo';
            } else if (CELULAR.test(texto) || FIJO.test(texto)) {
                tapar = palabras.filter(p => /\d/.test(p.texto));
                tipo = 'telefono';
            } else if (INICIO_DIRECCION.test(textoLimpio) && /\d|#/.test(texto)) {
                tapar = palabras;
                tipo = 'direccion';
            }
        }

        // 3. Una cédula a mitad de línea ("Rosalba Mantilla C.C. 63.482.915")
        if (!tapar) {
            const i = palabras.findIndex(p => /^c\.?c\.?:?$/i.test(p.texto));
            if (i >= 0 && i < palabras.length - 1) {
                tapar = palabras.slice(i + 1);
                tipo = 'cedula';
            }
        }

        if (tapar && tapar.length) {
            zonas.push({ tipo, caja: unirCajas(tapar.map(p => p.caja)) });
            const ocultas = new Set(tapar);
            textoSeguro.push(palabras.map(p => (ocultas.has(p) ? '[oculto]' : p.texto)).join(' '));
        } else {
            textoSeguro.push(texto);
        }
    }
    return { zonas, texto: textoSeguro.join('\n') };
}

// ---------- OCR local con Tesseract: la imagen no sale de este servidor ----------
let trabajador = null;

async function obtenerOCR() {
    if (!trabajador) {
        const { createWorker } = require('tesseract.js');
        // Los datos del idioma se descargan una vez y quedan en caché
        trabajador = createWorker('spa', 1, { cachePath: path.join(os.tmpdir(), 'raices-andinas-ocr'), logger: () => {} });
    }
    return trabajador;
}

async function leerConOCR(jpeg) {
    const worker = await obtenerOCR();
    // Blanco y negro con buen contraste: el OCR lee mejor las fotos de celular
    const limpia = await sharp(jpeg).greyscale().normalize().sharpen().toBuffer();
    const { data } = await worker.recognize(limpia, {}, { text: true, blocks: true });
    const lineas = [];
    for (const bloque of data.blocks || []) {
        for (const parrafo of bloque.paragraphs || []) {
            for (const linea of parrafo.lines || []) {
                lineas.push({
                    texto: linea.text.trim(),
                    palabras: (linea.words || []).map(w => ({ texto: w.text, caja: w.bbox }))
                });
            }
        }
    }
    return lineas;
}

async function tapar(jpeg, zonas) {
    if (zonas.length === 0) return jpeg;
    const { width, height } = await sharp(jpeg).metadata();
    const rectangulos = zonas.map(({ caja }) => {
        const x = Math.max(0, caja.x0 - MARGEN);
        const y = Math.max(0, caja.y0 - MARGEN);
        return `<rect x="${x}" y="${y}" width="${caja.x1 - caja.x0 + MARGEN * 2}" height="${caja.y1 - caja.y0 + MARGEN * 2}" fill="#000"/>`;
    }).join('');
    const capa = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rectangulos}</svg>`);
    return sharp(jpeg).composite([{ input: capa }]).jpeg({ quality: 88 }).toBuffer();
}

// Devuelve { legible, imagen, texto, zonas, palabras }
async function anonimizarImagen(jpeg) {
    const lineas = await leerConOCR(jpeg);
    const palabras = lineas.reduce((s, l) => s + l.palabras.length, 0);
    // Si el OCR casi no lee, tampoco podría encontrar los datos personales: no se envía a nadie
    if (palabras < MIN_PALABRAS_LEGIBLES) return { legible: false, palabras, zonas: [], texto: '', imagen: null };
    const { zonas, texto } = detectarDatosPersonales(lineas);
    return { legible: true, palabras, zonas, texto, imagen: await tapar(jpeg, zonas) };
}

async function cerrarOCR() {
    if (trabajador) {
        const w = await trabajador;
        trabajador = null;
        await w.terminate();
    }
}

module.exports = { anonimizarImagen, detectarDatosPersonales, leerConOCR, cerrarOCR, MIN_PALABRAS_LEGIBLES };
