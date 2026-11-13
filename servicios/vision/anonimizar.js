// servicios/vision/anonimizar.js
// Ley 1581: antes de que una imagen salga hacia un servicio externo, un OCR que corre en este
// mismo servidor busca los datos personales y los tapa con rectángulos negros.
// Se conservan el nombre del proveedor y el NIT: son los datos de negocio que el proceso necesita.

const os = require('os');
const path = require('path');
const sharp = require('sharp');

const MIN_PALABRAS_LEGIBLES = 12;
// Si el OCR casi no reconoce palabras con seguridad, tampoco puede garantizar que encontró los datos personales
const MIN_CONFIANZA_OCR = 45;
const MARGEN = 5;

// Los correos pierden la @ en fotos malas ("rosalba.mantillaóficticio.test")
const CORREO = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-zÀ-ÿ0-9._%+-]{4,}\.(?:test|com|co|net|org|edu)\b/;
const CELULAR = /(?:^|\D)(?:\+?57[\s.-]*)?3\d{2}[\s.-]*\d{3}[\s.-]*\d{4}(?:\D|$)/;
const FIJO = /\(?\+?(?:60\d|57)\)?[\s.-]*\d{3}[\s.-]*\d{4}/;
const MIN_DIGITOS_TELEFONO = 7;

// Después de una etiqueta, todo lo que sigue en esa línea es personal.
// "error" es cuántas letras puede leer mal el OCR ("pirección", "Vendedor" como "Vendedo").
const ETIQUETAS = [
    { tipo: 'cedula', palabras: ['cedula', 'identificacion'], error: 2 },
    { tipo: 'cedula', palabras: ['cc'], error: 0 },
    { tipo: 'telefono', palabras: ['telefono', 'telefonos', 'celular', 'movil', 'whatsapp', 'contacto'], error: 2 },
    { tipo: 'telefono', palabras: ['tel', 'cel'], error: 0 },
    { tipo: 'direccion', palabras: ['direccion', 'domicilio'], error: 2 },
    { tipo: 'direccion', palabras: ['dir'], error: 0 },
    { tipo: 'correo', palabras: ['correo', 'email', 'e-mail'], error: 1 },
    { tipo: 'persona', palabras: ['vendedor', 'vendedora', 'atendido', 'asesor', 'asesora', 'cajero', 'cajera', 'elaboro', 'recibio'], error: 2 }
];
const INICIO_DIRECCION = /^(?:calle|cll|cl|carrera|cra|cr|kr|avenida|av|diagonal|dg|transversal|tv|vereda|manzana|mz)\b\.?/i;

const unirCajas = (cajas) => ({
    x0: Math.min(...cajas.map(c => c.x0)), y0: Math.min(...cajas.map(c => c.y0)),
    x1: Math.max(...cajas.map(c => c.x1)), y1: Math.max(...cajas.map(c => c.y1))
});

const limpiarPalabra = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]/g, '');

// Letras distintas entre dos palabras (distancia de Levenshtein)
function distancia(a, b) {
    let previa = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const actual = [i];
        for (let j = 1; j <= b.length; j++) {
            actual[j] = Math.min(actual[j - 1] + 1, previa[j] + 1, previa[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        previa = actual;
    }
    return previa[b.length];
}

function etiquetaDe(texto) {
    const palabra = limpiarPalabra(texto);
    if (palabra.length < 2) return null;
    return ETIQUETAS.find(e => e.palabras.some(p => distancia(palabra, p) <= e.error)) || null;
}

// Números sueltos con forma de teléfono o cédula. Debajo del encabezado de la tabla nunca se aplica:
// allí están las cantidades y los precios, que el proceso necesita.
function numerosDeContacto(palabras) {
    // Un precio ($ o miles con punto: "9.600", "183.600,00") junto a otros números es una fila de productos
    const conPrecio = palabras.filter(p => /\$|\d{1,3}(?:[.,]\d{3})+/.test(p.texto));
    const conNumeros = palabras.filter(p => /\d/.test(p.texto));
    const cedulaSola = conPrecio.length === 1 && !/\$|,\d{2}$/.test(conPrecio[0].texto) && conNumeros.length === 1;
    if (conPrecio.length && !cedulaSola) return [];
    const candidatas = palabras.filter(p => /\d/.test(p.texto) && !/\$/.test(p.texto));
    const digitos = candidatas.reduce((n, p) => n + p.texto.replace(/\D/g, '').length, 0);
    return digitos >= MIN_DIGITOS_TELEFONO ? candidatas : [];
}
const ENCABEZADO_TABLA = /descrip|unitario|cant\b|subtotal/i;
// El NIT lleva dígito de verificación ("900.456.123-1"): la cédula no, y así se distinguen
const FORMA_NIT = /\d{3}[.,\s]*\d{3}[.,\s]*\d{3}\s*-\s*\d/;
const DATOS_DE_NEGOCIO = /factura|n[uú]mero|fecha|total|iva|comprador/i;

// lineas: [{ texto, palabras: [{ texto, caja }] }]. Devuelve las zonas a tapar y el texto ya sin esos datos.
function detectarDatosPersonales(lineas) {
    const zonas = [];
    const textoSeguro = [];

    // El OCR puede leer las líneas en desorden: la tabla se ubica por su posición en la hoja
    const encabezados = lineas.filter(l => l.palabras.length && ENCABEZADO_TABLA.test(l.palabras.map(p => p.texto).join(' ')));
    const inicioTabla = encabezados.length ? Math.min(...encabezados.flatMap(l => l.palabras.map(p => p.caja.y0))) : Infinity;

    for (const linea of lineas) {
        const palabras = linea.palabras.filter(p => p.texto.trim());
        if (palabras.length === 0) continue;
        const texto = palabras.map(p => p.texto).join(' ');
        const textoLimpio = texto.replace(/^[^\p{L}\d(+]+/u, '');
        const esNit = /\bn[il1]t\b/i.test(texto) || FORMA_NIT.test(texto);
        const enLaTabla = Math.min(...palabras.map(p => p.caja.y1)) >= inicioTabla;

        let tapar = null;
        let tipo = null;

        // 1. Etiqueta en cualquier parte de la línea, aunque el OCR ponga basura antes
        const i = palabras.findIndex(p => etiquetaDe(p.texto));
        if (i >= 0 && i < palabras.length - 1) {
            tapar = palabras.slice(i + 1);
            tipo = etiquetaDe(palabras[i].texto).tipo;
        }

        // 2. Sin etiqueta: se reconoce por la forma del dato. "NIT" nunca se tapa.
        if (!tapar && !esNit) {
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
            } else if (!enLaTabla && !DATOS_DE_NEGOCIO.test(texto) && numerosDeContacto(palabras).length) {
                tapar = numerosDeContacto(palabras);
                tipo = 'telefono';
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

// Varias lecturas: cada limpieza ve cosas distintas. Desenfocar borra las rayas de fotografiar una
// pantalla; ampliar ayuda con la letra pequeña. Se eligieron midiendo contra facturas de respuesta conocida.
// modo: 6 lee la página como un bloque (mejor con fotos malas), 3 detecta la estructura sola.
const LIMPIEZAS = [
    { escala: 2, modo: '6', aplicar: (imagen, ancho) => imagen.greyscale().blur(2).resize({ width: ancho * 2 }).normalize() },
    { escala: 1, modo: '6', aplicar: (imagen) => imagen.greyscale().blur(1.2).normalize() },
    { escala: 2, modo: '6', aplicar: (imagen, ancho) => imagen.greyscale().median(3).resize({ width: ancho * 2 }).normalize() },
    { escala: 2, modo: '3', aplicar: (imagen, ancho) => imagen.greyscale().blur(2).resize({ width: ancho * 2 }).normalize() },
    { escala: 1, modo: '3', aplicar: (imagen) => imagen.greyscale().normalize().sharpen() },
    // Letra clara sobre fondo oscuro (encabezados de color): se invierte para poder leerla
    { escala: 2, modo: '6', aplicar: (imagen, ancho) => imagen.greyscale().blur(1.2).resize({ width: ancho * 2 }).negate().normalize() }
];

async function leerConOCR(jpeg, lectura = LIMPIEZAS[0]) {
    const worker = await obtenerOCR();
    const { width } = await sharp(jpeg).metadata();
    const limpia = await lectura.aplicar(sharp(jpeg), width).toBuffer();
    await worker.setParameters({ tessedit_pageseg_mode: lectura.modo });
    const { data } = await worker.recognize(limpia, {}, { text: true, blocks: true });
    // Las cajas vuelven al tamaño de la imagen original
    const reducir = ({ x0, y0, x1, y1 }) => ({ x0: x0 / lectura.escala, y0: y0 / lectura.escala, x1: x1 / lectura.escala, y1: y1 / lectura.escala });
    const lineas = [];
    for (const bloque of data.blocks || []) {
        for (const parrafo of bloque.paragraphs || []) {
            for (const linea of parrafo.lines || []) {
                lineas.push({
                    texto: linea.text.trim(),
                    palabras: (linea.words || []).map(w => ({ texto: w.text, caja: reducir(w.bbox), confianza: w.confidence }))
                });
            }
        }
    }
    return lineas;
}

const contarPalabras = (lineas) => lineas.reduce((s, l) => s + l.palabras.length, 0);

// Qué tan seguro está el OCR de lo que leyó, de 0 a 100
function confianzaDeLectura(lineas) {
    const palabras = lineas.flatMap(l => l.palabras).filter(p => typeof p.confianza === 'number');
    return palabras.length ? palabras.reduce((s, p) => s + p.confianza, 0) / palabras.length : 0;
}

async function tapar(jpeg, zonas) {
    if (zonas.length === 0) return jpeg;
    const { width, height } = await sharp(jpeg).metadata();
    const rectangulos = zonas.map(({ caja }) => {
        const x = Math.max(0, caja.x0 - MARGEN);
        const y = Math.max(0, caja.y0 - MARGEN);
        return `<rect x="${Math.round(x)}" y="${Math.round(y)}" width="${Math.round(caja.x1 - caja.x0 + MARGEN * 2)}" height="${Math.round(caja.y1 - caja.y0 + MARGEN * 2)}" fill="#000"/>`;
    }).join('');
    const capa = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rectangulos}</svg>`);
    return sharp(jpeg).composite([{ input: capa }]).jpeg({ quality: 88 }).toBuffer();
}

// Devuelve { legible, imagen, texto, zonas, palabras, confianza_ocr }
async function anonimizarImagen(jpeg) {
    // Se tapa lo que encuentre CUALQUIERA de las lecturas: lo que una no ve, la otra puede verlo
    const lecturas = [];
    for (const limpieza of LIMPIEZAS) lecturas.push(await leerConOCR(jpeg, limpieza));

    const mejor = lecturas.reduce((a, b) => (confianzaDeLectura(b) > confianzaDeLectura(a) ? b : a));
    const palabras = Math.max(...lecturas.map(contarPalabras));
    const confianza = Math.round(confianzaDeLectura(mejor));

    // Si el OCR no puede leer con seguridad, tampoco puede garantizar que tapó todo: no se envía a nadie
    if (palabras < MIN_PALABRAS_LEGIBLES || confianza < MIN_CONFIANZA_OCR) {
        return { legible: false, palabras, confianza_ocr: confianza, zonas: [], texto: '', imagen: null };
    }

    const zonas = lecturas.flatMap(l => detectarDatosPersonales(l).zonas);
    const { texto } = detectarDatosPersonales(mejor);
    let imagen = await tapar(jpeg, zonas);

    // Segunda revisión: sin el ruido de lo ya tapado, a veces aparece lo que se había escapado
    const faltantes = detectarDatosPersonales(await leerConOCR(imagen)).zonas;
    if (faltantes.length) imagen = await tapar(imagen, faltantes);

    return { legible: true, palabras, confianza_ocr: confianza, zonas: [...zonas, ...faltantes], texto, imagen };
}

async function cerrarOCR() {
    if (trabajador) {
        const w = await trabajador;
        trabajador = null;
        await w.terminate();
    }
}

module.exports = { anonimizarImagen, detectarDatosPersonales, leerConOCR, cerrarOCR, etiquetaDe, confianzaDeLectura, LIMPIEZAS, MIN_PALABRAS_LEGIBLES, MIN_CONFIANZA_OCR };
