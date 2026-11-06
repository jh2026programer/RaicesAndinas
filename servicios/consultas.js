// servicios/consultas.js
// Consultas de negocio compartidas por la API del panel admin y el motor de automatización

async function reporteMensual(db, mes, anio) {
    const [[atendidas]] = await db.query(
        `SELECT COUNT(DISTINCT session_id) as total FROM chats
        WHERE MONTH(fecha_inicio) = ? AND YEAR(fecha_inicio) = ?`,
        [mes, anio]
    );

    const [[calificaciones]] = await db.query(
        `SELECT
            AVG(puntuacion) as promedio,
            COUNT(*) as total,
            SUM(CASE WHEN puntuacion = 5 THEN 1 ELSE 0 END) as cinco,
            SUM(CASE WHEN puntuacion = 4 THEN 1 ELSE 0 END) as cuatro,
            SUM(CASE WHEN puntuacion = 3 THEN 1 ELSE 0 END) as tres,
            SUM(CASE WHEN puntuacion = 2 THEN 1 ELSE 0 END) as dos,
            SUM(CASE WHEN puntuacion = 1 THEN 1 ELSE 0 END) as uno
        FROM calificaciones c
        JOIN chats ch ON c.chat_id = ch.id
        WHERE MONTH(ch.fecha_inicio) = ? AND YEAR(ch.fecha_inicio) = ?`,
        [mes, anio]
    );

    const [sugerenciasData] = await db.query(
        `SELECT c.puntuacion, c.comentario, ch.escalado_humano
        FROM calificaciones c
        JOIN chats ch ON c.chat_id = ch.id
        WHERE MONTH(ch.fecha_inicio) = ? AND YEAR(ch.fecha_inicio) = ?
        ORDER BY c.fecha DESC LIMIT 20`,
        [mes, anio]
    );

    // Ventas del mes (los pedidos cancelados no cuentan como ingreso)
    const [[ventas]] = await db.query(
        `SELECT
            COUNT(*) as pedidos,
            SUM(CASE WHEN estado = 'cancelado' THEN 1 ELSE 0 END) as cancelados,
            COALESCE(SUM(CASE WHEN estado <> 'cancelado' THEN total ELSE 0 END), 0) as ingresos
        FROM pedidos
        WHERE MONTH(fecha) = ? AND YEAR(fecha) = ?`,
        [mes, anio]
    );

    const [topProductos] = await db.query(
        `SELECT pr.nombre, SUM(dp.cantidad) as unidades, SUM(dp.subtotal) as ingresos
        FROM detalle_pedido dp
        JOIN pedidos p ON dp.pedido_id = p.id
        JOIN productos pr ON dp.producto_id = pr.id
        WHERE p.estado <> 'cancelado' AND MONTH(p.fecha) = ? AND YEAR(p.fecha) = ?
        GROUP BY pr.id, pr.nombre
        ORDER BY unidades DESC
        LIMIT 5`,
        [mes, anio]
    );

    // Encuestas de satisfacción de compras respondidas en el mes
    const [[encuestas]] = await db.query(
        `SELECT AVG(puntuacion) as promedio, COUNT(*) as total
         FROM encuestas WHERE MONTH(fecha) = ? AND YEAR(fecha) = ?`,
        [mes, anio]
    );

    // Sugerencias automáticas (máximo 3)
    const sugerencias = [];
    const totalCalif = calificaciones.total || 0;
    const promedio = parseFloat(calificaciones.promedio || 0);

    if (totalCalif > 0) {
        if (promedio >= 4.5) {
            sugerencias.push('🌟 Excelente promedio de calificaciones. Mantener las estrategias actuales de atención.');
        } else if (promedio >= 3.5) {
            sugerencias.push('📈 Buen promedio de calificaciones. Se sugiere mejorar en tiempos de respuesta.');
        } else {
            sugerencias.push('⚠️ Calificaciones bajas. Revisar urgentemente los protocolos de atención al cliente.');
        }
    } else {
        sugerencias.push('📊 No hay calificaciones registradas. Promover la encuesta de satisfacción después del chat.');
    }

    const escalados = sugerenciasData.filter(s => s.escalado_humano).length;
    if (escalados > 3) {
        sugerencias.push(`📞 ${escalados} conversaciones escaladas a humano. Mejorar el conocimiento del chatbot.`);
    }

    const palabrasNegativas = ['mal', 'tard', 'error', 'problema', 'queja'];
    const comentarioNegativo = sugerenciasData.find(s =>
        s.comentario && palabrasNegativas.some(p => s.comentario.toLowerCase().includes(p)));
    if (comentarioNegativo && sugerencias.length < 3) {
        sugerencias.push(`📝 Comentario negativo detectado: "${comentarioNegativo.comentario}". Revisar este caso.`);
    }

    return {
        mes: `${anio}-${String(mes).padStart(2, '0')}`,
        personas_atendidas: atendidas.total || 0,
        calificaciones: {
            promedio: promedio.toFixed(2),
            total: totalCalif,
            distribucion: {
                '5': Number(calificaciones.cinco) || 0,
                '4': Number(calificaciones.cuatro) || 0,
                '3': Number(calificaciones.tres) || 0,
                '2': Number(calificaciones.dos) || 0,
                '1': Number(calificaciones.uno) || 0
            }
        },
        sugerencias: sugerencias.slice(0, 3),
        ventas: {
            pedidos: ventas.pedidos || 0,
            cancelados: Number(ventas.cancelados) || 0,
            ingresos: parseFloat(ventas.ingresos) || 0,
            top_productos: topProductos.map(p => ({
                nombre: p.nombre,
                unidades: Number(p.unidades),
                ingresos: parseFloat(p.ingresos)
            }))
        },
        satisfaccion_compras: {
            promedio: encuestas.promedio ? parseFloat(encuestas.promedio).toFixed(2) : null,
            total: encuestas.total || 0
        }
    };
}

async function resumenDiario(db, horas = 48) {
    const [stockBajo] = await db.query(
        `SELECT id, nombre, stock, stock_minimo
         FROM productos
         WHERE stock <= stock_minimo
         ORDER BY stock ASC`
    );

    const [pedidosAtrasados] = await db.query(
        `SELECT p.id, p.total, p.fecha, u.nombres, u.apellidos, u.correo,
                TIMESTAMPDIFF(HOUR, p.fecha, NOW()) as horas_pendiente
         FROM pedidos p
         JOIN usuarios u ON p.usuario_id = u.id
         WHERE p.estado = 'pendiente' AND p.fecha <= NOW() - INTERVAL ? HOUR
         ORDER BY p.fecha ASC`,
        [horas]
    );

    return {
        fecha: new Date().toISOString(),
        stock_bajo: stockBajo,
        pedidos_atrasados: pedidosAtrasados,
        horas_limite: horas
    };
}

async function cierreDia(db) {
    // Ventas de hoy y de ayer (los pedidos cancelados no cuentan como venta)
    const [[ventas]] = await db.query(
        `SELECT
            SUM(CASE WHEN DATE(fecha) = CURDATE() AND estado <> 'cancelado' THEN 1 ELSE 0 END) as pedidos_hoy,
            COALESCE(SUM(CASE WHEN DATE(fecha) = CURDATE() AND estado <> 'cancelado' THEN total ELSE 0 END), 0) as ingresos_hoy,
            SUM(CASE WHEN DATE(fecha) = CURDATE() AND estado = 'cancelado' THEN 1 ELSE 0 END) as cancelados_hoy,
            COALESCE(SUM(CASE WHEN DATE(fecha) = CURDATE() - INTERVAL 1 DAY AND estado <> 'cancelado' THEN total ELSE 0 END), 0) as ingresos_ayer
         FROM pedidos
         WHERE fecha >= CURDATE() - INTERVAL 1 DAY`
    );

    const [topProductos] = await db.query(
        `SELECT pr.nombre, SUM(dp.cantidad) as unidades
         FROM detalle_pedido dp
         JOIN pedidos p ON dp.pedido_id = p.id
         JOIN productos pr ON dp.producto_id = pr.id
         WHERE DATE(p.fecha) = CURDATE() AND p.estado <> 'cancelado'
         GROUP BY pr.id, pr.nombre
         ORDER BY unidades DESC
         LIMIT 3`
    );

    const [[pendientes]] = await db.query(`SELECT COUNT(*) as total FROM pedidos WHERE estado = 'pendiente'`);
    const [[nuevosClientes]] = await db.query(
        `SELECT COUNT(*) as total FROM usuarios WHERE rol = 'cliente' AND DATE(fecha_registro) = CURDATE()`
    );

    return {
        fecha: new Date().toISOString(),
        pedidos_hoy: Number(ventas.pedidos_hoy) || 0,
        ingresos_hoy: parseFloat(ventas.ingresos_hoy) || 0,
        cancelados_hoy: Number(ventas.cancelados_hoy) || 0,
        ingresos_ayer: parseFloat(ventas.ingresos_ayer) || 0,
        top_productos: topProductos.map(p => ({ nombre: p.nombre, unidades: Number(p.unidades) })),
        pedidos_pendientes: pendientes.total,
        clientes_nuevos: nuevosClientes.total
    };
}

// Historial de compras de un cliente (para clasificarlo como nuevo, recurrente o VIP)
async function historialCliente(db, usuarioId, excluirPedido = 0) {
    const [[historial]] = await db.query(
        `SELECT COUNT(*) as pedidos_previos,
                COALESCE(SUM(total), 0) as total_gastado,
                MIN(fecha) as primera_compra
         FROM pedidos
         WHERE usuario_id = ? AND estado <> 'cancelado' AND id <> ?`,
        [usuarioId, excluirPedido]
    );
    return {
        usuario_id: parseInt(usuarioId),
        pedidos_previos: historial.pedidos_previos,
        total_gastado: parseFloat(historial.total_gastado),
        primera_compra: historial.primera_compra
    };
}

// Ventas por producto en los últimos N días
async function ventasProductos(db, dias = 30, productoId = null) {
    const [filas] = await db.query(
        `SELECT pr.id, pr.nombre, pr.stock, pr.stock_minimo, pr.precio,
                COALESCE(SUM(CASE WHEN p.id IS NOT NULL THEN dp.cantidad ELSE 0 END), 0) as unidades,
                COALESCE(SUM(CASE WHEN p.id IS NOT NULL THEN dp.subtotal ELSE 0 END), 0) as ingresos
         FROM productos pr
         LEFT JOIN detalle_pedido dp ON dp.producto_id = pr.id
         LEFT JOIN pedidos p ON p.id = dp.pedido_id AND p.estado <> 'cancelado' AND p.fecha >= NOW() - INTERVAL ? DAY
         ${productoId ? 'WHERE pr.id = ?' : ''}
         GROUP BY pr.id
         ORDER BY unidades DESC`,
        productoId ? [dias, productoId] : [dias]
    );
    return filas.map(f => ({
        id: f.id,
        nombre: f.nombre,
        stock: f.stock,
        stock_minimo: f.stock_minimo,
        precio: parseFloat(f.precio),
        unidades: Number(f.unidades),
        ingresos: parseFloat(f.ingresos),
        dias
    }));
}

// Suma unidades al stock. Devuelve null si el producto no existe.
async function reabastecer(db, productoId, cantidad) {
    const [result] = await db.query('UPDATE productos SET stock = stock + ? WHERE id = ?', [cantidad, productoId]);
    if (result.affectedRows === 0) return null;
    const [[producto]] = await db.query('SELECT id, nombre, stock, stock_minimo FROM productos WHERE id = ?', [productoId]);
    console.log(`📦 Reabastecido: ${producto.nombre} +${cantidad} → ${producto.stock}`);
    return { agregado: cantidad, ...producto };
}

// Indicadores del periodo actual vs. el periodo anterior (para el analista semanal)
async function indicadores(db, dias = 7) {
    const periodo = async (desde, hasta) => {
        const [[v]] = await db.query(
            `SELECT SUM(CASE WHEN estado <> 'cancelado' THEN 1 ELSE 0 END) as pedidos,
                    COALESCE(SUM(CASE WHEN estado <> 'cancelado' THEN total ELSE 0 END), 0) as ingresos,
                    SUM(CASE WHEN estado = 'cancelado' THEN 1 ELSE 0 END) as cancelados
             FROM pedidos WHERE fecha >= NOW() - INTERVAL ? DAY AND fecha < NOW() - INTERVAL ? DAY`,
            [desde, hasta]
        );
        const [[c]] = await db.query(
            `SELECT COUNT(*) as total FROM usuarios
             WHERE rol = 'cliente' AND fecha_registro >= NOW() - INTERVAL ? DAY AND fecha_registro < NOW() - INTERVAL ? DAY`,
            [desde, hasta]
        );
        const [[e]] = await db.query(
            `SELECT AVG(puntuacion) as promedio, COUNT(*) as total FROM encuestas
             WHERE fecha >= NOW() - INTERVAL ? DAY AND fecha < NOW() - INTERVAL ? DAY`,
            [desde, hasta]
        );
        const [[ch]] = await db.query(
            `SELECT COUNT(*) as chats, SUM(escalado_humano) as escalados FROM chats
             WHERE fecha_inicio >= NOW() - INTERVAL ? DAY AND fecha_inicio < NOW() - INTERVAL ? DAY`,
            [desde, hasta]
        );
        const pedidos = Number(v.pedidos) || 0;
        const ingresos = parseFloat(v.ingresos) || 0;
        return {
            pedidos,
            ingresos,
            cancelados: Number(v.cancelados) || 0,
            ticket_promedio: pedidos ? Math.round(ingresos / pedidos) : 0,
            clientes_nuevos: c.total,
            satisfaccion: e.promedio ? parseFloat(parseFloat(e.promedio).toFixed(2)) : null,
            encuestas: e.total,
            chats: ch.chats,
            chats_escalados: Number(ch.escalados) || 0
        };
    };
    return { dias, actual: await periodo(dias, 0), anterior: await periodo(dias * 2, dias) };
}

module.exports = { reporteMensual, resumenDiario, cierreDia, historialCliente, ventasProductos, reabastecer, indicadores };
