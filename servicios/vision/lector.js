// servicios/vision/lector.js
// El proceso completo de leer una factura, sin base de datos: lo usan el flujo del motor y el evaluador de precisión

const { prepararImagen } = require('./imagen');
const { anonimizarImagen } = require('./anonimizar');
const { validarFactura } = require('./validacion');

// Resultado: { estado: 'lista' | 'por_revisar' | 'no_legible', motivo?, validacion?, ... }
async function leerFactura({ archivo, tipo, catalogo, extractor, auditar, usuarioId, entrada, alPaso = async (_, fn) => fn() }) {
    const jpeg = await alPaso('Preparar imagen', () => prepararImagen(archivo, tipo));

    const anon = await alPaso('OCR local y anonimización', () => anonimizarImagen(jpeg));
    if (!anon.legible) {
        return { estado: 'no_legible', motivo: 'No se pudo leer con seguridad, así que no se envió a la IA para proteger los datos personales. Vuelve a tomar la foto con buena luz, sin reflejos y con la factura completa.', anon };
    }

    const lectura = await alPaso('IA: extraer datos', () => extractor.extraer({
        imagen: anon.imagen, textoOCR: anon.texto, confianzaOCR: anon.confianza_ocr, auditar, usuarioId, entrada
    }));
    if (!lectura.extraccion.es_factura) {
        return { estado: 'no_legible', motivo: 'La imagen no parece una factura.', anon, lectura };
    }

    const validacion = await alPaso('Validar con reglas y catálogo', async () =>
        validarFactura(lectura.extraccion, catalogo, { confianzaMaxima: lectura.confianza_maxima }));

    return { estado: validacion.requiere_revision ? 'por_revisar' : 'lista', anon, lectura, validacion };
}

module.exports = { leerFactura };
