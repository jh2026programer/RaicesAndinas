// Pruebas del módulo de visión: validaciones, anonimización y flujo completo (sin internet)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { validarFactura, digitoVerificacion, nitValido, buscarProducto, fechaValida, UMBRAL_CONFIANZA } = require('../servicios/vision/validacion');
const { detectarDatosPersonales, confianzaDeLectura } = require('../servicios/vision/anonimizar');
const { interpretarRespuesta, crearExtractor } = require('../servicios/vision/extractor');
const { identificarArchivo } = require('../servicios/vision/imagen');
const facturas = require('../servicios/vision/facturas');
const { crearMotor } = require('../servicios/automatizacion/motor');

const catalogo = [{ id: 1, nombre: 'Café Orgánico' }, { id: 2, nombre: 'Miel de Abeja' }, { id: 3, nombre: 'Cañihua' }];
const hoy = new Date(2026, 10, 6);
const c = (valor, confianza = 0.98) => ({ valor, confianza });
const extraccionBuena = () => ({
    proveedor: c('Distribuidora Agroandina S.A.S.'), nit: c('900.456.123-1'), numero: c('FV-100'), fecha: c('2026-10-20'),
    subtotal: c(100000), iva: c(19000), total: c(119000),
    items: [
        { descripcion: 'Café Orgánico', cantidad: 2, valor_unitario: 30000, subtotal: 60000, confianza: 0.97 },
        { descripcion: 'Miel de Abeja', cantidad: 1, valor_unitario: 40000, subtotal: 40000, confianza: 0.99 }
    ]
});
const validar = (e, op = {}) => validarFactura(e, catalogo, { hoy, ...op });

test('NIT: calcula y comprueba el dígito de verificación de la DIAN', () => {
    assert.strictEqual(digitoVerificacion('900456123'), 1);
    assert.strictEqual(digitoVerificacion('860002964'), 4);
    assert.strictEqual(nitValido('900.456.123-1'), true);
    assert.strictEqual(nitValido('900456123-1'), true);
    assert.strictEqual(nitValido('900.456.123-2'), false);
    assert.strictEqual(nitValido('sin nit'), false);
    assert.strictEqual(nitValido(null), false);
});

test('fecha: rechaza inválidas, futuras y muy antiguas', () => {
    assert.strictEqual(fechaValida('2026-10-20', hoy), true);
    assert.strictEqual(fechaValida('2026-02-30', hoy), false);
    assert.strictEqual(fechaValida('2027-01-01', hoy), false);
    assert.strictEqual(fechaValida('2020-01-01', hoy), false);
    assert.strictEqual(fechaValida('20/10/2026', hoy), false);
});

test('catálogo: encuentra el producto aunque cambien tildes o tenga texto extra', () => {
    assert.strictEqual(buscarProducto('CAFE ORGANICO', catalogo).producto_id, 1);
    assert.strictEqual(buscarProducto('Café Orgánico 500 g', catalogo).producto_id, 1);
    assert.strictEqual(buscarProducto('Canihua', catalogo).producto_id, 3);
    assert.strictEqual(buscarProducto('Bolsas kraft', catalogo).producto_id, null);
});

test('una factura correcta y segura queda lista, sin revisión obligatoria', () => {
    const v = validar(extraccionBuena());
    assert.strictEqual(v.requiere_revision, false);
    assert.strictEqual(v.totales_ok, true);
    assert.strictEqual(v.confianza_global, 0.97);
    assert.deepStrictEqual(v.alertas, []);
    assert.strictEqual(v.datos.items[0].producto_id, 1);
});

test('la IA no decide sola: aunque diga 100 %, si las cuentas no dan se revisa', () => {
    const e = extraccionBuena();
    e.total = c(999000, 1);
    const v = validar(e);
    assert.strictEqual(v.requiere_revision, true);
    assert.strictEqual(v.totales_ok, false);
    assert.ok(v.confianza_global <= 0.4);
    assert.ok(v.alertas.some(a => /totales/.test(a)));
});

test('una línea mal multiplicada baja la confianza de esa línea', () => {
    const e = extraccionBuena();
    e.items[0].cantidad = 3;
    const v = validar(e);
    assert.strictEqual(v.datos.items[0].cuentas_ok, false);
    assert.strictEqual(v.requiere_revision, true);
});

test('confianza baja de un solo campo obliga a revisar', () => {
    const e = extraccionBuena();
    e.numero = c('FV-100', UMBRAL_CONFIANZA - 0.1);
    assert.strictEqual(validar(e).requiere_revision, true);
});

test('NIT inválido, ausente o producto desconocido generan alerta', () => {
    const malo = extraccionBuena();
    malo.nit = c('900.456.123-9');
    assert.ok(validar(malo).alertas.some(a => /verificación/.test(a)));

    const sinNit = extraccionBuena();
    sinNit.nit = c(null, 0);
    const v = validar(sinNit);
    assert.ok(v.alertas.some(a => /NIT/.test(a)));
    assert.strictEqual(v.requiere_revision, true);

    const ajeno = extraccionBuena();
    ajeno.items[1].descripcion = 'Bolsas kraft';
    assert.ok(validar(ajeno).alertas.some(a => /catálogo.*Bolsas/.test(a)));
});

test('la lectura solo con OCR nunca queda lista sin revisión', () => {
    const v = validar(extraccionBuena(), { confianzaMaxima: 0.7 });
    assert.strictEqual(v.requiere_revision, true);
    assert.ok(v.confianza_global <= 0.7);
});

// ---------- Anonimización ----------
const linea = (texto) => ({
    texto,
    palabras: texto.split(' ').map((t, i) => ({ texto: t, caja: { x0: i * 100, y0: 0, x1: i * 100 + 90, y1: 20 } }))
});
const anonimizar = (...textos) => detectarDatosPersonales(textos.map(linea));

test('anonimizar: tapa cédula, teléfono, correo, dirección y vendedor', () => {
    const { zonas, texto } = anonimizar(
        'Rosalba Mantilla Pico',
        'C.C. 63.482.915',
        'Dirección: Vereda La Esperanza, Málaga',
        'Tel: 314 882 0467',
        'Correo: rosalba@ficticio.test',
        'Vendedor: Marta Lucía Rueda'
    );
    assert.deepStrictEqual(zonas.map(z => z.tipo), ['cedula', 'direccion', 'telefono', 'correo', 'persona']);
    for (const dato of ['63.482.915', 'Esperanza', '882', 'rosalba@', 'Marta']) assert.ok(!texto.includes(dato), `quedó visible: ${dato}`);
    assert.match(texto, /Rosalba Mantilla Pico/);
});

test('anonimizar: reconoce los datos sin etiqueta por su forma', () => {
    const { zonas } = anonimizar('Bodega central 3148820467', 'ventas@empresa.co', 'Calle 12 # 5-22 San Gil', '(607) 645 8821');
    assert.deepStrictEqual(zonas.map(z => z.tipo), ['telefono', 'correo', 'direccion', 'telefono']);
});

test('anonimizar: conserva lo que el proceso necesita', () => {
    const { zonas, texto } = anonimizar(
        'Distribuidora Agroandina S.A.S.',
        'NIT 900.456.123-1',
        'Factura Número: FV-3038 Fecha: 2026-09-02',
        'Comprador: Raíces Andinas S.A.S.',
        'Documento ficticio para pruebas académicas · F05',
        'Café Orgánico 9 $27.000 $243.000',
        'TOTAL $1.234.567'
    );
    assert.deepStrictEqual(zonas, []);
    assert.match(texto, /900\.456\.123-1/);
    assert.match(texto, /\$1\.234\.567/);
});

test('anonimizar: reconoce la C.C. con cualquier puntuación', () => {
    for (const etiqueta of ['C.C.', 'CC', 'C.C', 'c.c:', 'CC.']) {
        assert.ok(!anonimizar(`${etiqueta} 63.482.915`).texto.includes('63.482'), `no tapó con ${etiqueta}`);
    }
});

test('anonimizar: una cédula a mitad de línea también se tapa', () => {
    const { texto } = anonimizar('Hernán Cáceres C.C. 91.237.604');
    assert.ok(!texto.includes('91.237.604'));
    assert.match(texto, /Hernán Cáceres/);
});

test('anonimizar: tolera errores del OCR en las etiquetas y basura al inicio de la línea', () => {
    const { texto } = anonimizar(
        'pirección: Carrera 45 # 12-30',
        'o ! Dirección: Avenida 19 # 110-40',
        'Vendedo: Marta Rueda',
        'Teléfono: 742 9033',
        'como rosalba.mantillaóficticio.test'
    );
    for (const dato of ['Carrera', 'Avenida', 'Marta', '9033', 'mantilla']) assert.ok(!texto.includes(dato), `quedó visible: ${dato}`);
});

test('anonimizar: reconoce un teléfono sin etiqueta, pero no confunde valores ni facturas', () => {
    assert.match(anonimizar('sucursal 742 9033 6').texto, /\[oculto\]/);
    assert.match(anonimizar('Rosalba Mantilla', '63.482.915').texto, /\[oculto\]/);
    // Debajo del encabezado de la tabla están los precios: nunca se tapan por su forma
    const tabla = anonimizar('Descripción Cant. V. unitario Subtotal', '1360 800 00', 'Aceite 12 25.200 302.400');
    assert.deepStrictEqual(tabla.zonas, []);
    assert.deepStrictEqual(anonimizar('Café Orgánico 18 $10.800 $183.600').zonas, []);
    // Aunque el OCR no encuentre el encabezado de la tabla, una fila con precios no se tapa
    assert.deepStrictEqual(anonimizar('Té de Hierbas 18 $9.600 $172.800').zonas, []);
    assert.deepStrictEqual(anonimizar('Mermelada 17 10.800,00 183.600,00').zonas, []);
    assert.deepStrictEqual(anonimizar('Panela 4 $9.000 $36.000').zonas, []);
    assert.deepStrictEqual(anonimizar('Factura No. 1234567 Fecha 2026-09-02').zonas, []);
    assert.deepStrictEqual(anonimizar('Total 1234567').zonas, []);
});

test('anonimizar: una fila de la tabla leída fuera de orden sigue sin taparse', () => {
    const fila = (texto, y) => ({ texto, palabras: texto.split(' ').map((t, i) => ({ texto: t, caja: { x0: i * 100, y0: y, x1: i * 100 + 90, y1: y + 20 } })) });
    const { zonas } = detectarDatosPersonales([fila('21 39600 831600', 500), fila('Descripción Cant. Subtotal', 400), fila('Rosalba 63.482.915', 100)]);
    assert.deepStrictEqual(zonas.map(z => z.tipo), ['telefono']);
    assert.strictEqual(zonas[0].caja.y0, 100);
});

test('anonimizar: si el OCR no lee el encabezado de la tabla, las filas bajo "Número / Fecha" no se tapan', () => {
    const fila = (texto, y) => ({ texto, palabras: texto.split(' ').map((t, i) => ({ texto: t, caja: { x0: i * 100, y0: y, x1: i * 100 + 90, y1: y + 20 } })) });
    const { zonas } = detectarDatosPersonales([
        fila('Bodega 645 8821', 100),
        fila('Factura de venta Número: A-3274 Fecha: 2026-10-26', 200),
        fila('Te de Hierbas 18 9600 172800', 400),
        fila('Subtotal 832800', 600)
    ]);
    assert.deepStrictEqual(zonas.map(z => z.caja.y0), [100]);
});

test('anonimizar: palabras parecidas a una etiqueta pero distintas no tapan nada', () => {
    assert.deepStrictEqual(anonimizar('Descripción Cant. V. unitario Subtotal').zonas, []);
    assert.deepStrictEqual(anonimizar('Comprador: Raíces Andinas S.A.S.').zonas, []);
    assert.deepStrictEqual(anonimizar('Quinua Real 3 5 15').zonas, []);
});

test('anonimizar: el NIT nunca se tapa aunque el OCR lo lea mal', () => {
    assert.deepStrictEqual(anonimizar('NlT 900456123 1').zonas, []);
    assert.deepStrictEqual(anonimizar('MT 900.456.123-1').zonas, []);
    assert.deepStrictEqual(anonimizar('804.012 377-1').zonas, []);
});

test('la seguridad del OCR se calcula con las palabras leídas', () => {
    assert.strictEqual(confianzaDeLectura([{ palabras: [{ confianza: 90 }, { confianza: 50 }] }]), 70);
    assert.strictEqual(confianzaDeLectura([]), 0);
});

// ---------- Interpretar la respuesta del modelo ----------
test('interpreta JSON envuelto en markdown y limpia el dinero', () => {
    const r = interpretarRespuesta('```json\n{"proveedor":{"valor":"X","confianza":0.9},"total":{"valor":"$1.234.567,00","confianza":0.8},"items":[{"descripcion":"Café","cantidad":"2","valor_unitario":"1.500","subtotal":3000,"confianza":0.7}]}\n```');
    assert.strictEqual(r.total.valor, 1234567);
    assert.strictEqual(r.items[0].cantidad, 2);
    assert.strictEqual(r.items[0].valor_unitario, 1500);
    assert.strictEqual(r.nit.valor, null);
    assert.strictEqual(r.es_factura, true);
});

test('respuesta sin JSON es un error; una imagen que no es factura se reconoce', () => {
    assert.throws(() => interpretarRespuesta('No puedo leer eso'), /JSON/);
    assert.strictEqual(interpretarRespuesta('{"es_factura": false}').es_factura, false);
});

test('una confianza fuera de rango no rompe la lectura', () => {
    const r = interpretarRespuesta('{"proveedor":{"valor":"X","confianza":7}}');
    assert.strictEqual(r.proveedor.confianza, 0);
});

// ---------- Plan B de la visión ----------
const respuesta = JSON.stringify({ es_factura: true, proveedor: { valor: 'X', confianza: 0.9 } });
const modelo = (nombre, modo, comportamiento) => ({ nombre, modelo: nombre, modo, crear: () => ({ invoke: comportamiento }) });

test('si la visión está saturada, espera e insiste antes de usar el texto del OCR', async () => {
    let intentos = 0;
    const extractor = crearExtractor({ registro: { warn() {} }, esperaSegundaPasada: 1, modelos: [
        modelo('gemini', 'imagen', async () => { if (++intentos === 1) throw new Error('503 high demand'); return { content: respuesta }; }),
        modelo('groq', 'texto', async () => { throw new Error('no debía llegar aquí'); })
    ] });
    const r = await extractor.extraer({ imagen: Buffer.from('x'), textoOCR: 't' });
    assert.strictEqual(r.modo, 'imagen');
    assert.strictEqual(intentos, 2);
});

test('un OCR poco seguro no se usa para leer la factura: se deja para reintentar', async () => {
    let llamadas = 0;
    const extractor = crearExtractor({ registro: { warn() {} }, esperaSegundaPasada: 1, modelos: [
        modelo('gemini', 'imagen', async () => { throw new Error('caído'); }),
        modelo('groq', 'texto', async () => { llamadas++; return { content: respuesta }; })
    ] });
    await assert.rejects(extractor.extraer({ imagen: Buffer.from('x'), textoOCR: 'basura', confianzaOCR: 40 }), (e) => e.sinModelos === true);
    assert.strictEqual(llamadas, 0);
});

test('plan B: si fallan los modelos de visión, usa el texto del OCR con confianza limitada', async () => {
    const textosEnviados = [];
    const extractor = crearExtractor({ registro: { warn() {} }, esperaSegundaPasada: 1, modelos: [
        modelo('gemini', 'imagen', async () => { throw new Error('503 high demand'); }),
        modelo('groq', 'texto', async (m) => { textosEnviados.push(m[1].content); return { content: respuesta }; })
    ] });
    const r = await extractor.extraer({ imagen: Buffer.from('x'), textoOCR: 'Tel: [oculto]' });
    assert.strictEqual(r.modelo, 'groq');
    assert.strictEqual(r.modo, 'texto');
    assert.strictEqual(r.confianza_maxima, 0.7);
    assert.match(textosEnviados[0], /\[oculto\]/);
});

test('un modelo colgado se corta y cada intento queda auditado', async () => {
    const auditoria = [];
    const extractor = crearExtractor({ registro: { warn() {} }, tiempoPorModelo: 30, modelos: [
        modelo('gemini', 'imagen', () => new Promise(() => {})),
        modelo('gemini2', 'imagen', async () => ({ content: respuesta }))
    ] });
    const r = await extractor.extraer({ imagen: Buffer.from('x'), textoOCR: 't', auditar: async (f) => auditoria.push(f) });
    assert.strictEqual(r.modelo, 'gemini2');
    assert.deepStrictEqual(auditoria.map(a => a.exito), [false, true]);
});

test('sin ningún modelo disponible lanza un error para reintentar luego', async () => {
    const extractor = crearExtractor({ registro: { warn() {} }, esperaSegundaPasada: 1, modelos: [modelo('gemini', 'imagen', async () => { throw new Error('caído'); })] });
    await assert.rejects(extractor.extraer({ imagen: Buffer.from('x'), textoOCR: 't' }), (e) => e.sinModelos === true);
});

// ---------- Archivos ----------
test('identifica el archivo por su contenido, no por su nombre', async () => {
    const jpg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    assert.deepStrictEqual(identificarArchivo(jpg), { tipo: 'image/jpeg', extension: 'jpg' });
    assert.strictEqual(identificarArchivo(Buffer.from('%PDF-1.7 ...')).tipo, 'application/pdf');
    assert.match(identificarArchivo(Buffer.from('<script>alert(1)</script>')).error, /Solo se aceptan/);
    assert.match(identificarArchivo(Buffer.alloc(0)).error, /vacío/);
    assert.match(identificarArchivo(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic')])).error, /HEIC/);
    assert.match(identificarArchivo(Buffer.alloc(11 * 1024 * 1024, 0xff)).error, /10 MB/);
});

// ---------- Confirmar y rechazar ----------
function bdFacturas(inicial) {
    const fila = { id: 1, tipo_mime: 'image/jpeg', archivo: 'a.jpg', archivo_anonimizado: null, datos_ia: JSON.stringify(validar(extraccionBuena())), estado: 'lista', confianza: 0.97, modelo: 'm', ...inicial };
    const bd = { fila, confirmadas: [], async query(sql, v = []) {
        if (sql.includes('INSERT INTO automatizacion_ejecuciones')) return [{ insertId: 1 }];
        if (sql.includes('SELECT id, nombre FROM productos')) return [catalogo];
        if (sql.includes('SELECT id, proveedor FROM facturas')) return [bd.confirmadas];
        if (sql.includes('SELECT * FROM facturas')) return [[fila]];
        if (sql.includes(`SET estado = 'confirmada'`)) {
            if (!['lista', 'por_revisar'].includes(fila.estado)) return [{ affectedRows: 0 }];
            fila.estado = 'confirmada';
            fila.corregida = v[6];
            fila.revisado_por = v[7];
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE facturas SET estado = ?')) { fila.estado = v[0]; return [{ affectedRows: 1 }]; }
        return [[]];
    } };
    return bd;
}

function montar(inicial) {
    const bd = bdFacturas(inicial);
    const auditoria = [];
    const eventos = [];
    const motor = crearMotor({ db: bd, esperaBase: 1, registro: { error() {}, warn() {} } });
    const original = motor.emitir;
    motor.emitir = (e, d) => { eventos.push(e); return original(e, d); };
    const servicio = facturas.registrar(motor, { db: bd, ia: { auditar: async (f) => auditoria.push(f) }, extractor: {}, carpeta: fs.mkdtempSync(path.join(os.tmpdir(), 'facturas-')) });
    return { bd, servicio, auditoria, eventos };
}

const datosFormulario = (cambios = {}) => ({
    proveedor: 'Distribuidora Agroandina S.A.S.', nit: '900.456.123-1', numero: 'FV-100', fecha: '2026-10-20', subtotal: 100000, iva: 19000, total: 119000,
    items: [{ descripcion: 'Café Orgánico', cantidad: 2, valor_unitario: 30000, subtotal: 60000 }, { descripcion: 'Miel de Abeja', cantidad: 1, valor_unitario: 40000, subtotal: 40000 }],
    ...cambios
});

test('confirmar sin cambios: queda registrado quién y que no hubo correcciones', async () => {
    const { bd, servicio, auditoria, eventos } = montar();
    const r = await servicio.confirmar(1, datosFormulario(), 9);
    assert.deepStrictEqual(r, { ok: true, corregida: false });
    assert.strictEqual(bd.fila.estado, 'confirmada');
    assert.strictEqual(bd.fila.revisado_por, 9);
    assert.match(auditoria[0].resultado, /sin cambios/);
    assert.ok(eventos.includes('factura.confirmada'));
});

test('confirmar con correcciones queda marcado; un segundo clic no hace nada', async () => {
    const { bd, servicio, eventos } = montar();
    const r = await servicio.confirmar(1, datosFormulario({ numero: 'FV-101' }), 9);
    assert.strictEqual(r.corregida, true);
    assert.strictEqual(bd.fila.corregida, 1);
    const segundo = await servicio.confirmar(1, datosFormulario(), 9);
    assert.strictEqual(segundo.status, 409);
    assert.strictEqual(eventos.filter(e => e === 'factura.confirmada').length, 1);
});

test('el servidor no acepta datos inconsistentes aunque el navegador los envíe', async () => {
    const { servicio } = montar();
    assert.match((await servicio.confirmar(1, datosFormulario({ total: 5 }), 9)).error, /totales/);
    assert.match((await servicio.confirmar(1, datosFormulario({ nit: '900.456.123-9' }), 9)).error, /NIT/);
    assert.match((await servicio.confirmar(1, datosFormulario({ proveedor: '' }), 9)).error, /proveedor/);
    assert.match((await servicio.confirmar(1, datosFormulario({ items: [] }), 9)).error, /al menos un producto/);
});

test('una factura que no cuadra solo pasa si el administrador la fuerza a sabiendas', async () => {
    const { bd, servicio } = montar();
    const primero = await servicio.confirmar(1, datosFormulario({ total: 5 }), 9);
    assert.strictEqual(primero.confirmable, true);
    const r = await servicio.confirmar(1, datosFormulario({ total: 5 }), 9, { forzar: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(bd.fila.estado, 'confirmada');
});

test('la misma factura de un proveedor no se confirma dos veces', async () => {
    const { bd, servicio } = montar();
    bd.confirmadas = [{ id: 7, proveedor: 'DISTRIBUIDORA AGROANDINA S.A.S.' }];
    assert.match((await servicio.confirmar(1, datosFormulario(), 9)).error, /ya se confirmó antes \(factura #7\)/);
});

test('rechazar borra las imágenes; una confirmada no se puede rechazar', async () => {
    const { bd, servicio } = montar();
    fs.writeFileSync(servicio.rutaDe('a.jpg'), 'x');
    assert.strictEqual((await servicio.rechazar(1, 9, 'borrosa')).ok, true);
    assert.strictEqual(bd.fila.estado, 'rechazada');
    assert.strictEqual(fs.existsSync(servicio.rutaDe('a.jpg')), false);

    const otro = montar({ estado: 'confirmada' });
    assert.strictEqual((await otro.servicio.rechazar(1, 9)).status, 409);
});

test('subir: rechaza lo que no es imagen y las nombres de archivo no salen de la carpeta', async () => {
    const { servicio } = montar();
    assert.strictEqual((await servicio.subir({ buffer: Buffer.from('hola'), usuarioId: 9 })).status, 400);
    assert.strictEqual(path.dirname(servicio.rutaDe('../../secreto.txt')), servicio.carpeta);
});
