// servicios/vision/imagen.js
// Valida el archivo por su contenido real (no por su extensión) y lo deja listo para procesar

const sharp = require('sharp');

const TAMANO_MAXIMO = 10 * 1024 * 1024;
const LADO_MAXIMO = 2000;

const TIPOS = {
    'image/jpeg': { extension: 'jpg', firma: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    'image/png': { extension: 'png', firma: (b) => b.subarray(0, 4).toString('hex') === '89504e47' },
    'image/webp': { extension: 'webp', firma: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
    'application/pdf': { extension: 'pdf', firma: (b) => b.subarray(0, 5).toString() === '%PDF-' }
};

const esHeic = (b) => b.subarray(4, 8).toString() === 'ftyp' && /heic|heix|hevc|mif1/.test(b.subarray(8, 12).toString());

// Devuelve { tipo, extension } o { error } con un mensaje para el usuario
function identificarArchivo(buffer) {
    if (!buffer || buffer.length === 0) return { error: 'El archivo está vacío.' };
    if (buffer.length > TAMANO_MAXIMO) return { error: 'El archivo pesa más de 10 MB.' };
    if (esHeic(buffer)) return { error: 'Las fotos HEIC de iPhone no son compatibles. Cambia la cámara a "Más compatible" (JPG) o usa el botón "Tomar foto".' };
    for (const [tipo, { extension, firma }] of Object.entries(TIPOS)) {
        if (firma(buffer)) return { tipo, extension };
    }
    return { error: 'Solo se aceptan fotos JPG, PNG o WEBP y archivos PDF.' };
}

// Primera página de un PDF como imagen (la librería carga pdf.js, por eso se requiere solo aquí)
async function pdfAImagen(buffer) {
    const { pdfToPng } = require('pdf-to-png-converter');
    const copia = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
    const paginas = await pdfToPng(copia, { viewportScale: 2.5, pagesToProcess: [1], verbosityLevel: 0 });
    if (!paginas.length || !paginas[0].content) throw new Error('No se pudo leer el PDF');
    return paginas[0].content;
}

// JPEG derecho (según la orientación de la cámara) y de tamaño razonable
async function prepararImagen(buffer, tipo) {
    const origen = tipo === 'application/pdf' ? await pdfAImagen(buffer) : buffer;
    return sharp(origen)
        .rotate()
        .resize({ width: LADO_MAXIMO, height: LADO_MAXIMO, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 88 })
        .toBuffer();
}

module.exports = { identificarArchivo, prepararImagen, TAMANO_MAXIMO };
