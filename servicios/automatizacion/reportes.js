// servicios/automatizacion/reportes.js
// C04 · Centro de Reportes e Inteligencia: reportes programados y analista semanal con IA

const consultas = require('../consultas');
const { pesos, esc, plantillaCorreo, textoIAaHtml } = require('./plantillas');

const CENTRAL = 'C04 Reportes';

function textoResumenDiario({ stock_bajo, pedidos_atrasados, horas_limite }) {
    const lineas = ['☀️ RESUMEN DIARIO - Raíces Andinas', ''];
    if (stock_bajo.length > 0) {
        lineas.push(`📦 Productos para reponer (${stock_bajo.length}):`);
        stock_bajo.forEach(p => lineas.push(`${p.stock === 0 ? '🔴 AGOTADO' : '🟡'} ${p.nombre}: ${p.stock} uds (mínimo ${p.stock_minimo})`));
        lineas.push('');
    }
    if (pedidos_atrasados.length > 0) {
        lineas.push(`⏰ Pedidos pendientes hace más de ${horas_limite} h (${pedidos_atrasados.length}):`);
        pedidos_atrasados.forEach(p => lineas.push(`• #${p.id} - ${p.nombres} ${p.apellidos} - ${pesos(p.total)} (${Math.floor(p.horas_pendiente / 24)} días)`));
    }
    return lineas.join('\n');
}

function textoCierreDia(d) {
    let comparacion = '';
    if (d.ingresos_ayer > 0) {
        const cambio = Math.round((d.ingresos_hoy - d.ingresos_ayer) / d.ingresos_ayer * 100);
        comparacion = cambio >= 0 ? `📈 ${cambio}% más que ayer` : `📉 ${Math.abs(cambio)}% menos que ayer`;
    } else if (d.ingresos_hoy > 0) {
        comparacion = '📈 Ayer no hubo ventas';
    }
    const lineas = ['🌙 CIERRE DEL DÍA - Raíces Andinas', ''];
    if (d.pedidos_hoy === 0) {
        lineas.push('Hoy no hubo ventas. 💤');
    } else {
        lineas.push(`🧾 Pedidos: ${d.pedidos_hoy}`, `💰 Ventas: ${pesos(d.ingresos_hoy)}`);
        if (comparacion) lineas.push(comparacion);
        if (d.top_productos.length > 0) {
            lineas.push('', '🏆 Lo más vendido hoy:');
            d.top_productos.forEach((p, i) => lineas.push(`${['🥇', '🥈', '🥉'][i]} ${p.nombre} (${p.unidades} uds)`));
        }
    }
    lineas.push('');
    if (d.cancelados_hoy > 0) lineas.push(`❌ Cancelados hoy: ${d.cancelados_hoy}`);
    lineas.push(`👥 Clientes nuevos hoy: ${d.clientes_nuevos}`, `⏳ Pedidos por atender: ${d.pedidos_pendientes}`);
    return lineas.join('\n');
}

const variacion = (x, y) => (y ? Math.round((x - y) / y * 100) : (x ? 100 : 0));

function calcularKpis(ind, ventas, inv) {
    const top = ventas.filter(p => p && p.nombre && p.unidades > 0)
        .sort((a, b) => b.unidades - a.unidades).slice(0, 5);
    const a = ind.actual;
    const b = ind.anterior;

    const kpis = [
        { nombre: 'Ventas', actual: pesos(a.ingresos), anterior: pesos(b.ingresos), cambio: variacion(a.ingresos, b.ingresos) },
        { nombre: 'Pedidos', actual: a.pedidos, anterior: b.pedidos, cambio: variacion(a.pedidos, b.pedidos) },
        { nombre: 'Ticket promedio', actual: pesos(a.ticket_promedio), anterior: pesos(b.ticket_promedio), cambio: variacion(a.ticket_promedio, b.ticket_promedio) },
        { nombre: 'Clientes nuevos', actual: a.clientes_nuevos, anterior: b.clientes_nuevos, cambio: variacion(a.clientes_nuevos, b.clientes_nuevos) },
        { nombre: 'Cancelaciones', actual: a.cancelados, anterior: b.cancelados, cambio: variacion(a.cancelados, b.cancelados) },
        { nombre: 'Chats atendidos', actual: a.chats, anterior: b.chats, cambio: variacion(a.chats, b.chats) },
        { nombre: 'Satisfacción', actual: a.satisfaccion ?? '—', anterior: b.satisfaccion ?? '—', cambio: null }
    ];

    // Reglas de negocio para las alertas críticas
    const alertas = [];
    const agotados = inv.stock_bajo.filter(p => p.stock === 0);
    if (agotados.length) alertas.push(`${agotados.length} producto(s) agotado(s): ${agotados.map(p => p.nombre).join(', ')}`);
    if (b.ingresos > 0 && variacion(a.ingresos, b.ingresos) <= -30) alertas.push(`Las ventas cayeron ${Math.abs(variacion(a.ingresos, b.ingresos))}% frente a la semana anterior`);
    if (a.satisfaccion !== null && a.satisfaccion < 3) alertas.push(`La satisfacción de compras está en ${a.satisfaccion}/5`);
    if (inv.pedidos_atrasados.length) alertas.push(`${inv.pedidos_atrasados.length} pedido(s) llevan más de 48 h sin atender`);

    return { kpis, top, alertas };
}

function promptAnalista({ kpis, top, alertas }, inv) {
    const datosTexto = [
        ...kpis.map(k => `- ${k.nombre}: ${k.actual} (semana anterior: ${k.anterior}${k.cambio !== null ? `, cambio ${k.cambio}%` : ''})`),
        `- Productos más vendidos: ${top.length ? top.map(p => `${p.nombre} (${p.unidades} uds)`).join(', ') : 'sin ventas'}`,
        `- Productos con stock bajo: ${inv.stock_bajo.length ? inv.stock_bajo.map(p => `${p.nombre} (${p.stock})`).join(', ') : 'ninguno'}`,
        `- Alertas: ${alertas.length ? alertas.join('; ') : 'ninguna'}`
    ].join('\n');

    return [
        'Eres un analista de negocio de "Raíces Andinas", una tienda online colombiana de productos andinos.',
        'Analiza los indicadores de la semana y responde en español, en máximo 170 palabras, con este formato en texto plano:',
        'RESUMEN: (2 frases)',
        'LO POSITIVO: (1-2 puntos)',
        'LO QUE PREOCUPA: (1-2 puntos)',
        'RECOMENDACIONES: (3 acciones concretas numeradas)',
        'Usa solo estos datos, no inventes cifras.',
        '',
        'DATOS DE LA SEMANA:',
        datosTexto
    ].join('\n');
}

function correoInforme({ kpis, top, alertas }, analisis) {
    const flecha = (c) => (c === null ? '' : c > 0 ? `<span style="color:#2f855a">▲ ${c}%</span>` : c < 0 ? `<span style="color:#c0392b">▼ ${Math.abs(c)}%</span>` : '=');
    const maxUnidades = Math.max(1, ...top.map(p => p.unidades));
    return plantillaCorreo(
        '📊 Informe semanal de negocio',
        `<h3 style="color:#1a3c2a;">Indicadores (últimos 7 días vs. semana anterior)</h3>
         <table style="width:100%;border-collapse:collapse;font-size:14px;">
           <tr style="background:#f0ede4;"><th style="text-align:left;padding:8px;">Indicador</th><th style="padding:8px;">Esta semana</th><th style="padding:8px;">Anterior</th><th style="padding:8px;">Cambio</th></tr>
           ${kpis.map(k => `<tr style="border-bottom:1px solid #eee;"><td style="padding:8px;">${k.nombre}</td><td style="padding:8px;text-align:center;"><strong>${k.actual}</strong></td><td style="padding:8px;text-align:center;color:#888;">${k.anterior}</td><td style="padding:8px;text-align:center;">${flecha(k.cambio)}</td></tr>`).join('')}
         </table>
         <h3 style="color:#1a3c2a;">🏆 Productos más vendidos</h3>
         ${top.length ? top.map(p => `
           <div style="margin:6px 0;font-size:14px;">${esc(p.nombre)} · ${p.unidades} uds
             <div style="background:#f0ede4;border-radius:6px;height:12px;"><div style="background:#d4a853;height:12px;border-radius:6px;width:${Math.round(p.unidades / maxUnidades * 100)}%;"></div></div>
           </div>`).join('') : '<p>Sin ventas esta semana.</p>'}
         ${alertas.length ? `<h3 style="color:#c0392b;">🚨 Alertas</h3><ul>${alertas.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
         <h3 style="color:#1a3c2a;">🤖 Análisis del asistente de IA</h3>
         <p style="background:#f7f5f0;padding:14px;border-radius:8px;">${textoIAaHtml(analisis)}</p>`
    );
}

function telegramSemanal({ kpis, top }) {
    return [
        '📊 INFORME SEMANAL',
        '',
        ...kpis.slice(0, 4).map(k => `• ${k.nombre}: ${k.actual}${k.cambio !== null ? ` (${k.cambio >= 0 ? '+' : ''}${k.cambio}%)` : ''}`),
        '',
        `🏆 Top: ${top.slice(0, 3).map(p => p.nombre).join(', ') || 'sin ventas'}`,
        '📧 El informe completo con el análisis de IA está en tu correo.'
    ].join('\n');
}

function correoMensual(r) {
    const v = r.ventas;
    const c = r.calificaciones;
    const filaKpi = (etiqueta, valor) =>
        `<tr><td style="padding:8px;border-bottom:1px solid #eee;">${etiqueta}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right;font-weight:bold;">${valor}</td></tr>`;
    const top = v.top_productos.length > 0
        ? `<ol>${v.top_productos.map(p => `<li>${esc(p.nombre)}: ${p.unidades} uds · ${pesos(p.ingresos)}</li>`).join('')}</ol>`
        : '<p>No hubo ventas este mes.</p>';
    return plantillaCorreo(
        `📊 Reporte mensual ${r.mes}`,
        `<h3 style="color:#1a3c2a;">Ventas</h3>
         <table style="width:100%;border-collapse:collapse;">
           ${filaKpi('Pedidos realizados', v.pedidos)}
           ${filaKpi('Pedidos cancelados', v.cancelados)}
           ${filaKpi('Ingresos (sin cancelados)', pesos(v.ingresos))}
         </table>
         <h3 style="color:#1a3c2a;">Productos más vendidos</h3>
         ${top}
         <h3 style="color:#1a3c2a;">Atención del chatbot</h3>
         <table style="width:100%;border-collapse:collapse;">
           ${filaKpi('Personas atendidas', r.personas_atendidas)}
           ${filaKpi('Calificación promedio', `${c.promedio} / 5 (${c.total} calificaciones)`)}
         </table>
         <h3 style="color:#1a3c2a;">Satisfacción de compras (encuestas)</h3>
         <table style="width:100%;border-collapse:collapse;">
           ${filaKpi('Promedio', r.satisfaccion_compras.promedio ? `${r.satisfaccion_compras.promedio} / 5` : 'Sin encuestas')}
           ${filaKpi('Encuestas respondidas', r.satisfaccion_compras.total)}
         </table>
         <h3 style="color:#1a3c2a;">Sugerencias</h3>
         <ul>${r.sugerencias.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`
    );
}

// Mes anterior a la fecha dada (enero → diciembre del año pasado)
function mesAnterior(fecha = new Date()) {
    const mes = fecha.getMonth(); // 0 = enero
    return mes === 0 ? { mes: 12, anio: fecha.getFullYear() - 1 } : { mes, anio: fecha.getFullYear() };
}

function registrar(motor, { db, canales, ia, entorno = process.env }) {
    motor.registrar({
        id: 'C04.resumen-diario', central: CENTRAL, flujo: 'Resumen diario', cron: '0 8 * * *',
        async ejecutar(_, ctx) {
            const d = await ctx.paso('Consultar inventario y pedidos', () => consultas.resumenDiario(db, 48));
            if (d.stock_bajo.length + d.pedidos_atrasados.length === 0) return { enviado: false, motivo: 'Todo en orden' };
            await ctx.paso('Telegram: resumen diario', () => canales.telegram(textoResumenDiario(d)));
            return { enviado: true, stock_bajo: d.stock_bajo.length, atrasados: d.pedidos_atrasados.length };
        }
    });

    motor.registrar({
        id: 'C04.cierre-dia', central: CENTRAL, flujo: 'Cierre del día', cron: '0 20 * * *',
        async ejecutar(_, ctx) {
            const d = await ctx.paso('Consultar ventas del día', () => consultas.cierreDia(db));
            await ctx.paso('Telegram: cierre del día', () => canales.telegram(textoCierreDia(d)));
            return { pedidos: d.pedidos_hoy, ingresos: d.ingresos_hoy };
        }
    });

    motor.registrar({
        id: 'C04.analista-semanal', central: CENTRAL, flujo: 'Analista semanal con IA', cron: '0 9 * * 1',
        async ejecutar(_, ctx) {
            // Tres fuentes en paralelo
            const [ind, ventas, inv] = await ctx.ramas(
                () => ctx.paso('Indicadores de la semana', () => consultas.indicadores(db, 7)),
                () => ctx.paso('Ventas por producto (7 días)', () => consultas.ventasProductos(db, 7)),
                () => ctx.paso('Estado del inventario', () => consultas.resumenDiario(db, 48))
            );
            const informe = calcularKpis(ind, ventas, inv);

            const analisis = await ctx.paso('IA: analista de negocio', async () => {
                const texto = await ia.generarTexto({
                    funcion: 'analista_semanal',
                    sistema: promptAnalista(informe, inv),
                    pregunta: 'Analiza la semana y dame tus recomendaciones.'
                }).catch(() => null);
                return texto || 'La IA no estuvo disponible en este momento. Revisa los indicadores de la tabla.';
            }, { intentos: 1 });

            const ramas = [
                () => ctx.paso('Correo: informe semanal', () => canales.correo({ para: entorno.ADMIN_EMAIL, asunto: '📊 Informe semanal Raíces Andinas', html: correoInforme(informe, analisis) })),
                () => ctx.paso('Telegram: resumen semanal', () => canales.telegram(telegramSemanal(informe)))
            ];
            if (informe.alertas.length > 0) {
                ramas.push(() => ctx.paso('Telegram: alerta urgente', () => canales.telegram(`🚨 ALERTAS CRÍTICAS DE LA SEMANA\n\n${informe.alertas.map(a => `• ${a}`).join('\n')}`)));
            }
            await ctx.ramas(...ramas);
            return { alertas: informe.alertas.length, top: informe.top.map(p => p.nombre) };
        }
    });

    motor.registrar({
        id: 'C04.reporte-mensual', central: CENTRAL, flujo: 'Reporte mensual', cron: '0 7 1 * *',
        async ejecutar(_, ctx) {
            const { mes, anio } = mesAnterior();
            const r = await ctx.paso('Consultar reporte del mes anterior', () => consultas.reporteMensual(db, mes, anio));
            await ctx.paso('Correo: reporte mensual', () => canales.correo({ para: entorno.ADMIN_EMAIL, asunto: `📊 Reporte mensual Raíces Andinas - ${r.mes}`, html: correoMensual(r) }));
            return { mes: r.mes, pedidos: r.ventas.pedidos, ingresos: r.ventas.ingresos };
        }
    });
}

module.exports = { registrar, textoResumenDiario, textoCierreDia, calcularKpis, variacion, mesAnterior };
