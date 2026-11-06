// scripts/generar-facturas-prueba.js
// Crea 20 facturas FICTICIAS para imprimir y fotografiar, con sus respuestas correctas.
// Uso: npm run facturas:generar  →  pruebas-facturas/facturas-para-imprimir.pdf y verdad.json
// Los datos son inventados y siempre salen iguales (la semilla es fija).

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { digitoVerificacion } = require('../servicios/vision/validacion');

const CARPETA = path.join(__dirname, '..', 'pruebas-facturas');
const CATALOGO = [
    ['Café Orgánico', 27000], ['Miel de Abeja', 24000], ['Quinua Real', 16800], ['Panela Artesanal', 9000],
    ['Aguardiente Andino', 35400], ['Mermelada de Mora', 10800], ['Chocolate Artesanal', 22800],
    ['Aceite de Oliva', 25200], ['Sal de Maras', 13200], ['Té de Hierbas', 9600], ['Cañihua', 39600]
];
const AJENOS = [['Bolsas kraft de empaque', 1200], ['Etiquetas adhesivas', 300]];

const conNit = (base) => `${base.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${digitoVerificacion(base)}`;

const EMPRESAS = [
    { nombre: 'Distribuidora Agroandina S.A.S.', nit: conNit('900456123'), direccion: 'Carrera 45 # 12-30, Bucaramanga', telefono: '(607) 645 8821', correo: 'ventas@agroandina-ficticia.test' },
    { nombre: 'Cooperativa Café del Páramo', nit: conNit('804012377'), direccion: 'Calle 8 # 3-15, Socorro', telefono: '(607) 727 1140', correo: 'contacto@cafeparamo-ficticia.test' },
    { nombre: 'Productos del Altiplano Ltda.', nit: conNit('860533291'), direccion: 'Avenida 19 # 110-40, Bogotá', telefono: '(601) 742 9033', correo: 'pedidos@altiplano-ficticia.test' }
];
const PERSONAS = [
    { nombre: 'Rosalba Mantilla Pico', cc: '63.482.915', direccion: 'Vereda La Esperanza, Málaga', telefono: '314 882 0467', correo: 'rosalba.mantilla@ficticio.test' },
    { nombre: 'Hernán Cáceres Duarte', cc: '91.237.604', direccion: 'Calle 12 # 5-22, San Gil', telefono: '317 540 2298', correo: 'hernancaceres@ficticio.test' }
];
const VENDEDORES = ['Marta Lucía Rueda', 'Carlos Andrés Suárez', 'Diana Patricia Ortiz'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Generador pseudoaleatorio con semilla fija
let semilla = 20261106;
const azar = (n) => { semilla = (semilla * 1664525 + 1013904223) % 4294967296; return Math.floor(semilla / 4294967296 * n); };
const elegir = (lista) => lista[azar(lista.length)];

const dinero = (v, estilo) => (estilo === 1 ? `${Math.round(v).toLocaleString('es-CO')},00` : `$${Math.round(v).toLocaleString('es-CO')}`);

function crearFactura(i) {
    const esPersona = i % 5 === 4; // F05, F10, F15, F20
    const emisor = esPersona ? PERSONAS[i % 2] : EMPRESAS[i % 3];
    const usados = new Set();
    const cuantos = 2 + azar(4);
    const items = [];
    while (items.length < cuantos) {
        const [descripcion, costo] = (i % 7 === 6 && items.length === 0) ? elegir(AJENOS) : elegir(CATALOGO);
        if (usados.has(descripcion)) continue;
        usados.add(descripcion);
        const cantidad = (descripcion.includes('Bolsas') || descripcion.includes('Etiquetas')) ? (2 + azar(5)) * 50 : 3 + azar(22);
        items.push({ descripcion, cantidad, valor_unitario: costo, subtotal: cantidad * costo });
    }
    const subtotal = items.reduce((s, x) => s + x.subtotal, 0);
    const conIva = i % 3 !== 1 && !esPersona;
    const iva = conIva ? Math.round(subtotal * 0.19) : 0;
    const dia = 1 + azar(28);
    const mes = 7 + azar(3);
    return {
        codigo: `F${String(i + 1).padStart(2, '0')}`,
        esPersona, emisor, items, subtotal, iva, total: subtotal + iva, dia, mes,
        numero: `${elegir(['FV', 'FE', 'A', 'SETT'])}-${1000 + azar(8999)}`,
        fecha: `2026-${String(mes + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`,
        vendedor: i % 2 === 0 ? VENDEDORES[i % 3] : null
    };
}

function fechaImpresa(f, estilo) {
    if (estilo === 0) return f.fecha;
    if (estilo === 1) return `${String(f.dia).padStart(2, '0')}/${String(f.mes + 1).padStart(2, '0')}/2026`;
    return `${f.dia} de ${MESES[f.mes]} de 2026`;
}

// Cuatro diseños distintos, para no probar siempre con el mismo formato
function dibujar(doc, f, indice) {
    const diseno = indice % 4;
    const fuente = ['Helvetica', 'Times-Roman', 'Courier', 'Helvetica'][diseno];
    const negrilla = ['Helvetica-Bold', 'Times-Bold', 'Courier-Bold', 'Helvetica-Bold'][diseno];
    const estiloDinero = diseno === 1 ? 1 : 0;
    const e = f.emisor;
    const x = 56;
    const ancho = 500;
    let y = 56;

    const texto = (t, px, py, op = {}) => doc.font(op.negrilla ? negrilla : fuente).fontSize(op.tam || 10).fillColor(op.color || '#111').text(t, px, py, { lineBreak: false, width: op.ancho, align: op.alinear || 'left' });

    if (diseno === 3) {
        doc.rect(x, y - 10, ancho, 66).fill('#1f3d5c');
        texto(e.nombre, x + 12, y, { negrilla: true, tam: 15, color: '#fff' });
        texto(f.esPersona ? `C.C. ${e.cc}` : `NIT: ${e.nit}`, x + 12, y + 22, { color: '#fff' });
        texto('FACTURA DE VENTA', x + 300, y + 22, { negrilla: true, color: '#fff', ancho: 188, alinear: 'right' });
        y += 66;
    } else {
        texto(diseno === 2 ? e.nombre.toUpperCase() : e.nombre, x, y, { negrilla: true, tam: 15 });
        y += 22;
        texto(f.esPersona ? `C.C. ${e.cc}` : `NIT ${e.nit}`, x, y);
        y += 15;
    }
    texto(`Dirección: ${e.direccion}`, x, y); y += 15;
    texto(`Tel: ${e.telefono}`, x, y); y += 15;
    texto(`Correo: ${e.correo}`, x, y); y += 26;

    if (diseno !== 3) { texto(diseno === 2 ? 'FACTURA No.' : 'Factura de venta', x, y, { negrilla: true, tam: 12 }); }
    texto(`Número: ${f.numero}`, x + (diseno === 3 ? 0 : 200), y, { negrilla: true });
    texto(`Fecha: ${fechaImpresa(f, indice % 3)}`, x + 340, y); y += 24;

    texto('Comprador: Raíces Andinas S.A.S.', x, y); y += 15;
    if (f.vendedor) { texto(`Vendedor: ${f.vendedor}`, x, y); y += 15; }
    y += 12;

    const cols = [x, x + 270, x + 330, x + 415];
    const fila = (a, b, c, d, op = {}) => {
        texto(a, cols[0] + 4, y, op);
        texto(b, cols[1], y, { ...op, ancho: 50, alinear: 'right' });
        texto(c, cols[2], y, { ...op, ancho: 80, alinear: 'right' });
        texto(d, cols[3], y, { ...op, ancho: 81, alinear: 'right' });
    };
    if (diseno !== 2) doc.rect(x, y - 5, ancho, 20).fill(diseno === 3 ? '#dfe7ef' : '#eeeeee');
    fila('Descripción', 'Cant.', 'V. unitario', 'Subtotal', { negrilla: true });
    y += 20;
    for (const it of f.items) {
        fila(it.descripcion, String(it.cantidad), dinero(it.valor_unitario, estiloDinero), dinero(it.subtotal, estiloDinero));
        y += 18;
        if (diseno === 0 || diseno === 3) doc.moveTo(x, y - 5).lineTo(x + ancho, y - 5).strokeColor('#cccccc').stroke();
    }
    y += 12;
    const total = (etiqueta, v, negrita) => {
        texto(etiqueta, cols[2] - 20, y, { negrilla: negrita, ancho: 100, alinear: 'right' });
        texto(dinero(v, estiloDinero), cols[3], y, { negrilla: negrita, ancho: 81, alinear: 'right' });
        y += 17;
    };
    total('Subtotal', f.subtotal);
    total('IVA 19%', f.iva);
    total('TOTAL', f.total, true);

    texto(`Documento ficticio para pruebas académicas · ${f.codigo}`, x, 730, { tam: 7, color: '#777' });
}

function main() {
    fs.mkdirSync(path.join(CARPETA, 'fotos'), { recursive: true });
    const doc = new PDFDocument({ size: 'LETTER', autoFirstPage: false, info: { Title: 'Facturas ficticias de prueba' } });
    doc.pipe(fs.createWriteStream(path.join(CARPETA, 'facturas-para-imprimir.pdf')));

    const verdad = {};
    for (let i = 0; i < 20; i++) {
        const f = crearFactura(i);
        doc.addPage();
        dibujar(doc, f, i);
        const e = f.emisor;
        verdad[f.codigo] = {
            proveedor: e.nombre,
            // La cédula de una persona natural se tapa antes de ir a la IA: lo correcto es que no la lea
            nit: f.esPersona ? null : e.nit,
            numero: f.numero,
            fecha: f.fecha,
            subtotal: f.subtotal,
            iva: f.iva,
            total: f.total,
            items: f.items,
            datos_personales: [e.telefono, e.correo, e.direccion, ...(f.esPersona ? [e.cc] : []), ...(f.vendedor ? [f.vendedor] : [])]
        };
    }
    doc.end();
    fs.writeFileSync(path.join(CARPETA, 'verdad.json'), `${JSON.stringify(verdad, null, 2)}\n`);
    console.log(`✅ 20 facturas en ${path.join(CARPETA, 'facturas-para-imprimir.pdf')}`);
}

if (require.main === module) main();
