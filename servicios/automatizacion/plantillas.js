// servicios/automatizacion/plantillas.js
// Formato de dinero y plantillas HTML de los correos (las mismas de las centrales de n8n)

const pesos = (valor) => '$' + Math.round(Number(valor) || 0).toLocaleString('es-CO');

const esc = (texto) => String(texto ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const tiendaUrl = () => process.env.TIENDA_URL || `http://localhost:${process.env.PORT || 3000}`;

const plantillaCorreo = (titulo, contenido) => `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f7f5f0;padding:24px;">
  <div style="background:#1a3c2a;color:#fff;padding:20px 24px;border-radius:10px 10px 0 0;">
    <h1 style="margin:0;font-size:22px;">🌿 Raíces Andinas</h1>
  </div>
  <div style="background:#fff;padding:24px;border-radius:0 0 10px 10px;color:#333;line-height:1.5;">
    <h2 style="color:#1a3c2a;margin-top:0;">${titulo}</h2>
    ${contenido}
    <p style="margin-top:24px;"><a href="${tiendaUrl()}" style="background:#d4a853;color:#1a3c2a;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold;">Visitar la tienda</a></p>
  </div>
  <p style="text-align:center;color:#888;font-size:12px;">Raíces Andinas · Productos andinos auténticos</p>
</div>`;

const tablaItems = (items) => `
<table style="width:100%;border-collapse:collapse;font-size:14px;">
  <tr style="background:#f0ede4;"><th style="text-align:left;padding:8px;">Producto</th><th style="padding:8px;">Cant.</th><th style="text-align:right;padding:8px;">Subtotal</th></tr>
  ${(items || []).map(i => `<tr style="border-bottom:1px solid #eee;"><td style="padding:8px;">${esc(i.nombre)}</td><td style="text-align:center;padding:8px;">${i.cantidad}</td><td style="text-align:right;padding:8px;">${pesos(i.subtotal)}</td></tr>`).join('')}
</table>`;

// Convierte el texto de la IA (*negrita* y saltos de línea) en HTML seguro
const textoIAaHtml = (texto) => esc(texto).replace(/\*\*?(.+?)\*\*?/g, '<strong>$1</strong>').replace(/\n/g, '<br>');

// Página que se muestra en el navegador al abrir un enlace del correo
const paginaSimple = (titulo, texto, icono, extra = '') => `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(titulo)}</title></head>` +
    `<body style="margin:0;font-family:Arial,sans-serif;background:#f7f5f0;display:flex;align-items:center;justify-content:center;min-height:100vh;">` +
    `<div style="background:#fff;max-width:460px;margin:16px;padding:40px;border-radius:16px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.08);">` +
    `<div style="font-size:56px;">${icono}</div><h1 style="color:#1a3c2a;">${esc(titulo)}</h1><p style="color:#555;line-height:1.6;">${esc(texto)}</p>${extra}` +
    `<a href="/admin.html" style="display:inline-block;margin-top:16px;color:#1a3c2a;">Ir al panel admin</a></div></body></html>`;

module.exports = { pesos, esc, tiendaUrl, plantillaCorreo, tablaItems, textoIAaHtml, paginaSimple };
