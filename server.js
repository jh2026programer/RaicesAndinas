// server.js - Servidor de la tienda Raíces Andinas

// Cargar variables de entorno desde .env (antes de requerir db.js)
try {
    process.loadEnvFile();
} catch (error) {
    console.warn('⚠️ No se encontró el archivo .env, usando valores por defecto');
}

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, probarConexion } = require('./db');
const chatbot = require('./servicios/chatbot');

const app = express();
const PORT = process.env.PORT || 3000;
const TIENDA_URL = process.env.TIENDA_URL || `http://localhost:${PORT}`;

// Reglas de envío (las usan el carrito, el servidor y el chatbot)
const ENVIO = {
    costo: 8000,
    gratisDesde: 80000 // envío gratis en compras MAYORES a este valor
};

// Minutos que espera n8n después de la entrega para enviar la encuesta (3 días por defecto)
const ENCUESTA_ESPERA_MINUTOS = parseInt(process.env.ENCUESTA_ESPERA_MINUTOS) || 4320;

// ============================================
// AUTENTICACIÓN (clientes y administradores)
// ============================================
// Token firmado (HMAC): "<datos en base64>.<firma>". No requiere guardar sesiones en BD.
const TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_HORAS = { admin: 8, cliente: 24 * 7 };

function firmar(datos) {
    return crypto.createHmac('sha256', TOKEN_SECRET).update(datos).digest('base64url');
}

function generarToken(usuarioId, rol) {
    const datos = Buffer.from(JSON.stringify({
        id: usuarioId,
        rol: rol,
        exp: Date.now() + (TOKEN_HORAS[rol] || 24) * 60 * 60 * 1000
    })).toString('base64url');
    return `${datos}.${firmar(datos)}`;
}

function compararSeguro(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function verificarToken(token) {
    const [datos, firma] = String(token).split('.');
    if (!datos || !firma || !compararSeguro(firma, firmar(datos))) return null;
    try {
        const payload = JSON.parse(Buffer.from(datos, 'base64url').toString());
        return payload.exp > Date.now() ? payload : null;
    } catch {
        return null;
    }
}

function sesionDe(req) {
    const auth = req.get('authorization') || '';
    return auth.startsWith('Bearer ') ? verificarToken(auth.slice(7)) : null;
}

// Permite el acceso a un admin con sesión válida o a n8n con su API key
function requiereAdmin(req, res, next) {
    const apiKey = req.get('x-api-key');
    if (apiKey && process.env.AUTOMATION_API_KEY && compararSeguro(apiKey, process.env.AUTOMATION_API_KEY)) {
        return next();
    }

    const sesion = sesionDe(req);
    if (sesion && sesion.rol === 'admin') {
        req.sesion = sesion;
        return next();
    }

    res.status(401).json({ error: 'No autorizado. Inicia sesión como administrador.' });
}

// Exige un cliente con sesión iniciada (o un admin)
function requiereUsuario(req, res, next) {
    const sesion = sesionDe(req);
    if (!sesion) {
        return res.status(401).json({ error: 'Tu sesión expiró. Inicia sesión de nuevo.' });
    }
    req.sesion = sesion;
    next();
}

// Un cliente solo puede ver sus propios datos; un admin puede ver los de todos
function esDuenioOAdmin(req, usuarioId) {
    return req.sesion.rol === 'admin' || req.sesion.id === parseInt(usuarioId);
}

// Firma para los enlaces de la encuesta (evita que alguien califique pedidos ajenos)
function tokenEncuesta(pedidoId) {
    return firmar(`encuesta:${pedidoId}`).slice(0, 32);
}

// ============================================
// AUTOMATIZACIONES (n8n)
// ============================================
// Envía un evento a un webhook de n8n sin bloquear la respuesta al cliente.
// Si n8n está apagado, la tienda sigue funcionando normalmente.
function notificarN8n(evento, datos) {
    const baseUrl = process.env.N8N_WEBHOOK_URL;
    if (!baseUrl) return;

    fetch(`${baseUrl}/${evento}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evento, fecha: new Date().toISOString(), ...datos }),
        signal: AbortSignal.timeout(5000)
    })
        .then(res => console.log(`🔔 n8n [${evento}] → ${res.status}`))
        .catch(err => console.warn(`⚠️ n8n [${evento}] no disponible: ${err.message}`));
}

// Pregunta a la IA (flujo de n8n con Gemini) y ESPERA la respuesta.
// Si Gemini falla de forma temporal (ej. "alta demanda"), se reintenta una vez.
// Devuelve null si la IA no está disponible, para usar las reglas como respaldo.
async function consultarIA(datos, intento = 1) {
    const baseUrl = process.env.N8N_WEBHOOK_URL;
    if (!baseUrl || process.env.CHATBOT_IA === 'false') return null;

    const inicio = Date.now();
    try {
        const res = await fetch(`${baseUrl}/chatbot-ia`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(datos),
            signal: AbortSignal.timeout(30000)
        });
        if (!res.ok) {
            console.warn(`⚠️ IA del chatbot respondió ${res.status} (intento ${intento})`);
            // 500 = el flujo falló (normalmente Gemini saturado). Reintentar si aún hay tiempo.
            if (res.status >= 500 && intento === 1 && Date.now() - inicio < 15000) {
                await new Promise(r => setTimeout(r, 1500));
                return consultarIA(datos, 2);
            }
            return null;
        }
        const resultado = await res.json();
        const respuesta = String(resultado.respuesta || '').trim();
        return respuesta || null;
    } catch (error) {
        console.warn(`⚠️ IA del chatbot no disponible: ${error.message}`);
        return null;
    }
}

async function obtenerItemsPedido(pedidoId) {
    const [items] = await db.query(
        `SELECT pr.nombre, pr.imagen, dp.cantidad, dp.precio_unitario, dp.subtotal
         FROM detalle_pedido dp
         JOIN productos pr ON dp.producto_id = pr.id
         WHERE dp.pedido_id = ?`,
        [pedidoId]
    );
    return items;
}

// ============================================
// PRODUCTOS: utilidades
// ============================================
function precioConDescuento(precio, descuento) {
    return Math.round(parseFloat(precio) * (1 - (parseInt(descuento) || 0) / 100));
}

function formatearProducto(p) {
    const descuento = parseInt(p.descuento) || 0;
    return {
        ...p,
        precio: parseFloat(p.precio),
        descuento: descuento,
        precio_final: precioConDescuento(p.precio, descuento),
        destacado: Boolean(p.destacado)
    };
}

async function listarProductos() {
    const [productos] = await db.query(
        `SELECT p.*, c.nombre as categoria_nombre
        FROM productos p
        LEFT JOIN categorias c ON p.categoria_id = c.id
        ORDER BY p.destacado DESC, p.nombre ASC`
    );
    return productos.map(formatearProducto);
}

// Valida los datos del formulario de producto. Devuelve { error } o { datos }
function validarProducto(body) {
    const nombre = String(body.nombre || '').trim();
    const precio = parseFloat(body.precio);
    const stock = parseInt(body.stock) || 0;
    const stockMinimo = body.stock_minimo === undefined || body.stock_minimo === '' ? 5 : parseInt(body.stock_minimo);
    const descuento = parseInt(body.descuento) || 0;
    const imagen = String(body.imagen || '').trim();

    if (!nombre || !(precio > 0)) return { error: 'Nombre y precio (mayor que 0) son obligatorios' };
    if (stock < 0 || stockMinimo < 0) return { error: 'El stock no puede ser negativo' };
    if (descuento < 0 || descuento > 90) return { error: 'El descuento debe estar entre 0 y 90 %' };
    if (imagen && !/^https?:\/\/\S+$/i.test(imagen)) {
        return { error: 'La imagen debe ser un enlace que empiece por http:// o https://' };
    }
    if (imagen.length > 1000) return { error: 'El enlace de la imagen es demasiado largo' };

    return {
        datos: [
            nombre,
            String(body.descripcion || '').trim() || null,
            precio,
            stock,
            stockMinimo,
            body.categoria_id || null,
            Boolean(body.destacado),
            imagen || null,
            descuento
        ]
    };
}

// ============================================
// MIDDLEWARE E INICIO
// ============================================
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let bdConectada = false;

// Migraciones: ajustes de la base de datos que se aplican solos al iniciar
// (ver database/migraciones/). "IF NOT EXISTS" hace que sea seguro ejecutarlas siempre.
async function aplicarMigraciones() {
    await db.query('ALTER TABLE chats ADD COLUMN IF NOT EXISTS solicitud_asesor TINYINT(1) NOT NULL DEFAULT 0');
    await db.query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS descuento TINYINT UNSIGNED NOT NULL DEFAULT 0');
    await db.query('ALTER TABLE productos MODIFY imagen VARCHAR(1000) NULL');
    await db.query('ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS costo_envio DECIMAL(10,2) NOT NULL DEFAULT 0');
    await db.query(
        `CREATE TABLE IF NOT EXISTS password_resets (
            id INT AUTO_INCREMENT PRIMARY KEY,
            usuario_id INT NOT NULL,
            token_hash CHAR(64) NOT NULL,
            expira DATETIME NOT NULL,
            usado TINYINT(1) NOT NULL DEFAULT 0,
            creado TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY (token_hash),
            FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
        )`
    );
    await db.query(
        `CREATE TABLE IF NOT EXISTS encuestas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            pedido_id INT NOT NULL UNIQUE,
            puntuacion TINYINT NOT NULL CHECK (puntuacion BETWEEN 1 AND 5),
            comentario TEXT NULL,
            fecha TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE
        )`
    );
}

(async function iniciar() {
    bdConectada = await probarConexion();
    if (bdConectada) {
        try {
            await aplicarMigraciones();
            console.log('✅ Base de datos lista');
        } catch (error) {
            console.error('❌ Error aplicando migraciones:', error.message);
        }
    } else {
        console.log('❌ Error: No se pudo conectar a MySQL. Asegúrate de que XAMPP esté corriendo.');
    }
})();

// Todas las rutas /api necesitan la base de datos
app.use('/api', (req, res, next) => {
    if (!bdConectada) {
        return res.status(503).json({ error: 'Base de datos no disponible. ¿Está encendido MySQL en XAMPP?' });
    }
    next();
});

// Configuración pública de la tienda (la usa el carrito para calcular el envío)
app.get('/api/config', (req, res) => {
    res.json({ envio_costo: ENVIO.costo, envio_gratis_desde: ENVIO.gratisDesde });
});

// ============================================
// 1. REGISTRO DE USUARIO
// ============================================
app.post('/api/registro', async (req, res) => {
    try {
        const {
            nombres, apellidos, password,
            telefono, direccion, ciudad, documento,
            eps, condiciones_salud,
            consentimiento_publico, consentimiento_sensible
        } = req.body;
        const correo = String(req.body.correo || '').trim().toLowerCase();

        if (!nombres || !apellidos || !correo || !password) {
            return res.status(400).json({ error: 'Todos los campos obligatorios deben estar llenos' });
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
            return res.status(400).json({ error: 'El correo no es válido' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
        }

        if (!consentimiento_publico) {
            return res.status(400).json({ error: 'Debe aceptar el tratamiento de datos personales' });
        }

        if ((eps || condiciones_salud) && !consentimiento_sensible) {
            return res.status(400).json({ error: 'Para guardar datos de salud debe autorizar su tratamiento' });
        }

        const [existe] = await db.query('SELECT id FROM usuarios WHERE correo = ?', [correo]);
        if (existe.length > 0) {
            return res.status(400).json({ error: 'Este correo ya está registrado' });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const [result] = await db.query(
            `INSERT INTO usuarios
            (nombres, apellidos, correo, password, telefono, direccion, ciudad, documento, rol)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'cliente')`,
            [nombres.trim(), apellidos.trim(), correo, passwordHash, telefono || null, direccion || null, ciudad || null, documento || null]
        );

        console.log('✅ Usuario registrado, ID:', result.insertId);

        // Datos sensibles solo con consentimiento explícito
        if ((eps || condiciones_salud) && consentimiento_sensible) {
            await db.query(
                `INSERT INTO clientes (usuario_id, eps, condiciones_salud, consentimiento_sensible)
                VALUES (?, ?, ?, 1)`,
                [result.insertId, eps || null, condiciones_salud || null]
            );
        }

        // Solo datos básicos: los datos sensibles (salud) nunca salen hacia n8n
        notificarN8n('usuario-registrado', {
            usuario: { id: result.insertId, nombres, apellidos, correo }
        });

        res.json({
            success: true,
            message: 'Usuario registrado exitosamente',
            usuario: { id: result.insertId, nombres, apellidos, correo, rol: 'cliente' }
        });

    } catch (error) {
        console.error('❌ Error en registro:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ============================================
// 2. LOGIN (clientes y administradores)
// ============================================
async function autenticar(correo, password, soloAdmin) {
    const [usuarios] = await db.query(
        `SELECT * FROM usuarios WHERE correo = ? ${soloAdmin ? 'AND rol = "admin"' : ''}`,
        [String(correo || '').trim().toLowerCase()]
    );
    if (usuarios.length === 0 || !(await bcrypt.compare(String(password || ''), usuarios[0].password))) {
        return null;
    }
    const usuario = usuarios[0];
    delete usuario.password;
    return usuario;
}

app.post('/api/login', async (req, res) => {
    try {
        const { correo, password } = req.body;

        if (!correo || !password) {
            return res.status(400).json({ error: 'Correo y contraseña son obligatorios' });
        }

        const usuario = await autenticar(correo, password, false);
        if (!usuario) {
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }

        await db.query('UPDATE usuarios SET ultimo_login = NOW() WHERE id = ?', [usuario.id]);

        res.json({
            success: true,
            message: 'Login exitoso',
            usuario: usuario,
            token: generarToken(usuario.id, usuario.rol)
        });

    } catch (error) {
        console.error('Error en login:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.post('/api/admin/login', async (req, res) => {
    try {
        const { usuario, password } = req.body;

        if (!usuario || !password) {
            return res.status(400).json({ success: false, error: 'Usuario y contraseña son obligatorios' });
        }

        const admin = await autenticar(usuario, password, true);
        if (!admin) {
            console.log('🔐 Intento de login admin fallido:', usuario);
            return res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
        }

        console.log('🔐 Login admin exitoso:', admin.correo);

        res.json({
            success: true,
            message: 'Login exitoso',
            usuario: admin,
            token: generarToken(admin.id, 'admin')
        });

    } catch (error) {
        console.error('❌ Error en admin login:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ============================================
// 3. RESTABLECER CONTRASEÑA
// ============================================
const RESET_MINUTOS = 30;
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// 3.1 Solicitar enlace de recuperación
app.post('/api/password/olvido', async (req, res) => {
    // Siempre se responde lo mismo, exista o no el correo,
    // para no revelar qué correos están registrados.
    const respuesta = {
        success: true,
        message: 'Si el correo está registrado, te enviamos un enlace para restablecer tu contraseña.'
    };

    try {
        const correo = String(req.body.correo || '').trim().toLowerCase();
        if (!correo) {
            return res.status(400).json({ error: 'Escribe tu correo' });
        }

        const [usuarios] = await db.query('SELECT id, nombres, correo FROM usuarios WHERE correo = ?', [correo]);
        if (usuarios.length === 0) return res.json(respuesta);
        const usuario = usuarios[0];

        // Evitar spam: máximo una solicitud por minuto
        const [recientes] = await db.query(
            'SELECT id FROM password_resets WHERE usuario_id = ? AND creado > NOW() - INTERVAL 1 MINUTE',
            [usuario.id]
        );
        if (recientes.length > 0) return res.json(respuesta);

        // Invalidar enlaces anteriores y crear uno nuevo.
        // En la BD se guarda solo el HASH del token: si alguien roba la BD, no puede usar los enlaces.
        await db.query('UPDATE password_resets SET usado = 1 WHERE usuario_id = ? AND usado = 0', [usuario.id]);
        const token = crypto.randomBytes(32).toString('hex');
        await db.query(
            'INSERT INTO password_resets (usuario_id, token_hash, expira) VALUES (?, ?, NOW() + INTERVAL ? MINUTE)',
            [usuario.id, hashToken(token), RESET_MINUTOS]
        );

        notificarN8n('password-reset', {
            usuario: { nombres: usuario.nombres, correo: usuario.correo },
            enlace: `${TIENDA_URL}/restablecer.html?token=${token}`,
            minutos: RESET_MINUTOS
        });
        console.log('🔑 Enlace de recuperación generado para:', usuario.correo);

        res.json(respuesta);

    } catch (error) {
        console.error('Error en olvido de contraseña:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

async function buscarReset(token) {
    if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
    const [filas] = await db.query(
        'SELECT id, usuario_id FROM password_resets WHERE token_hash = ? AND usado = 0 AND expira > NOW()',
        [hashToken(token)]
    );
    return filas[0] || null;
}

// 3.2 Verificar que un enlace siga vigente (la página lo consulta al abrir)
app.get('/api/password/validar', async (req, res) => {
    try {
        res.json({ valido: Boolean(await buscarReset(req.query.token)) });
    } catch (error) {
        console.error('Error validando enlace:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// 3.3 Guardar la nueva contraseña
app.post('/api/password/restablecer', async (req, res) => {
    try {
        const { token, password } = req.body;

        if (!password || String(password).length < 6) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
        }

        const reset = await buscarReset(token);
        if (!reset) {
            return res.status(400).json({ error: 'El enlace no es válido o ya venció. Solicita uno nuevo.' });
        }

        await db.query('UPDATE usuarios SET password = ? WHERE id = ?', [await bcrypt.hash(password, 10), reset.usuario_id]);
        await db.query('UPDATE password_resets SET usado = 1 WHERE id = ?', [reset.id]);

        res.json({ success: true, message: 'Tu contraseña fue actualizada. Ya puedes iniciar sesión.' });

    } catch (error) {
        console.error('Error restableciendo contraseña:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ============================================
// 4. DATOS DEL USUARIO (solo el propio usuario o un admin)
// ============================================
app.get('/api/usuario/:id', requiereUsuario, async (req, res) => {
    try {
        if (!esDuenioOAdmin(req, req.params.id)) {
            return res.status(403).json({ error: 'No puedes ver los datos de otro usuario' });
        }
        const [usuarios] = await db.query(
            'SELECT id, nombres, apellidos, correo, telefono, direccion, ciudad, documento, rol, fecha_registro FROM usuarios WHERE id = ?',
            [req.params.id]
        );
        if (usuarios.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }
        res.json(usuarios[0]);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al obtener usuario' });
    }
});

// ============================================
// 5. PRODUCTOS - CRUD
// ============================================

// 5.1 Todos los productos (con precio final según el descuento)
app.get('/api/productos', async (req, res) => {
    try {
        res.json(await listarProductos());
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al cargar productos' });
    }
});

// 5.2 Productos destacados
app.get('/api/productos/destacados', async (req, res) => {
    try {
        const productos = await listarProductos();
        res.json(productos.filter(p => p.destacado).slice(0, 6));
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al cargar productos destacados' });
    }
});

// 5.3 Productos con stock bajo
app.get('/api/productos/stock-bajo', requiereAdmin, async (req, res) => {
    try {
        const [productos] = await db.query(
            `SELECT * FROM productos WHERE stock <= stock_minimo ORDER BY stock ASC`
        );
        res.json(productos.map(formatearProducto));
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al cargar productos con stock bajo' });
    }
});

// 5.4 Crear producto
app.post('/api/productos', requiereAdmin, async (req, res) => {
    try {
        const { error, datos } = validarProducto(req.body);
        if (error) return res.status(400).json({ error });

        const [result] = await db.query(
            `INSERT INTO productos
            (nombre, descripcion, precio, stock, stock_minimo, categoria_id, destacado, imagen, descuento)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            datos
        );

        res.json({ success: true, message: 'Producto creado exitosamente', id: result.insertId });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al crear producto' });
    }
});

// 5.5 Actualizar producto
app.put('/api/productos/:id', requiereAdmin, async (req, res) => {
    try {
        const { error, datos } = validarProducto(req.body);
        if (error) return res.status(400).json({ error });

        const [result] = await db.query(
            `UPDATE productos SET
                nombre = ?, descripcion = ?, precio = ?, stock = ?, stock_minimo = ?,
                categoria_id = ?, destacado = ?, imagen = ?, descuento = ?
            WHERE id = ?`,
            [...datos, req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Producto no encontrado' });
        }

        res.json({ success: true, message: 'Producto actualizado exitosamente' });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al actualizar producto' });
    }
});

// 5.6 Eliminar producto
app.delete('/api/productos/:id', requiereAdmin, async (req, res) => {
    try {
        // Un producto que ya aparece en pedidos no se puede borrar (se perdería el historial)
        const [usos] = await db.query('SELECT COUNT(*) as total FROM detalle_pedido WHERE producto_id = ?', [req.params.id]);
        if (usos[0].total > 0) {
            return res.status(409).json({
                error: 'Este producto ya tiene pedidos y no se puede eliminar. Puedes dejar su stock en 0 para que aparezca como agotado.'
            });
        }

        await db.query('DELETE FROM productos WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Producto eliminado exitosamente' });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al eliminar producto' });
    }
});

// ============================================
// 6. CATEGORÍAS - CRUD
// ============================================
app.get('/api/categorias', async (req, res) => {
    try {
        const [categorias] = await db.query(
            `SELECT c.*, COUNT(p.id) as total_productos
             FROM categorias c
             LEFT JOIN productos p ON p.categoria_id = c.id
             GROUP BY c.id
             ORDER BY c.nombre ASC`
        );
        res.json(categorias);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al cargar categorías' });
    }
});

app.post('/api/categorias', requiereAdmin, async (req, res) => {
    try {
        const nombre = String(req.body.nombre || '').trim();
        if (!nombre) {
            return res.status(400).json({ error: 'El nombre es obligatorio' });
        }

        const [result] = await db.query(
            'INSERT INTO categorias (nombre, descripcion) VALUES (?, ?)',
            [nombre, req.body.descripcion || null]
        );

        res.json({ success: true, message: 'Categoría creada exitosamente', id: result.insertId });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al crear categoría' });
    }
});

app.put('/api/categorias/:id', requiereAdmin, async (req, res) => {
    try {
        const nombre = String(req.body.nombre || '').trim();
        if (!nombre) {
            return res.status(400).json({ error: 'El nombre es obligatorio' });
        }

        await db.query(
            'UPDATE categorias SET nombre = ?, descripcion = ? WHERE id = ?',
            [nombre, req.body.descripcion || null, req.params.id]
        );

        res.json({ success: true, message: 'Categoría actualizada exitosamente' });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al actualizar categoría' });
    }
});

app.delete('/api/categorias/:id', requiereAdmin, async (req, res) => {
    try {
        // Los productos de la categoría quedan "sin categoría" en lugar de borrarse
        await db.query('UPDATE productos SET categoria_id = NULL WHERE categoria_id = ?', [req.params.id]);
        await db.query('DELETE FROM categorias WHERE id = ?', [req.params.id]);

        res.json({ success: true, message: 'Categoría eliminada exitosamente' });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al eliminar categoría' });
    }
});

// ============================================
// 7. PEDIDOS
// ============================================

// 7.1 CREAR PEDIDO (el cliente se toma de la sesión, no del formulario)
app.post('/api/pedidos', requiereUsuario, async (req, res) => {
    try {
        const { items, metodo_pago } = req.body;
        const userId = req.sesion.id;

        const [usuario] = await db.query(
            'SELECT id, nombres, apellidos, correo, telefono, direccion FROM usuarios WHERE id = ?',
            [userId]
        );
        if (usuario.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado. Inicia sesión nuevamente.' });
        }

        const direccionEnvio = String(req.body.direccion_envio || usuario[0].direccion || '').trim();
        if (!direccionEnvio) {
            return res.status(400).json({ error: 'Escribe la dirección de envío' });
        }

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'El carrito está vacío' });
        }

        // Validar formato de cada item (agrupando productos repetidos)
        const cantidades = new Map();
        for (const item of items) {
            const productoId = parseInt(item.producto_id);
            const cantidad = parseInt(item.cantidad);

            if (!(productoId > 0)) return res.status(400).json({ error: 'Producto inválido' });
            if (!(cantidad > 0)) return res.status(400).json({ error: 'Cantidad inválida' });

            cantidades.set(productoId, (cantidades.get(productoId) || 0) + cantidad);
        }

        // Transacción: validar stock, crear pedido y descontar stock como una sola operación.
        // "FOR UPDATE" bloquea los productos para que dos compras simultáneas no vendan el mismo stock.
        const conexion = await db.getConnection();
        let pedido_id;
        let subtotal = 0;
        let costoEnvio = 0;
        let total = 0;
        const detalles = [];

        try {
            await conexion.beginTransaction();

            for (const [productoId, cantidad] of cantidades) {
                const [producto] = await conexion.query(
                    'SELECT id, nombre, precio, descuento, stock, stock_minimo FROM productos WHERE id = ? FOR UPDATE',
                    [productoId]
                );
                if (producto.length === 0) {
                    throw { status: 400, mensaje: `Un producto de tu carrito ya no existe. Retíralo e intenta de nuevo.` };
                }
                const p = producto[0];
                if (p.stock < cantidad) {
                    throw {
                        status: 400,
                        mensaje: p.stock === 0
                            ? `"${p.nombre}" está agotado. Retíralo del carrito.`
                            : `Solo quedan ${p.stock} unidades de "${p.nombre}".`
                    };
                }

                // El precio SIEMPRE se calcula en el servidor (con el descuento vigente)
                const precioUnitario = precioConDescuento(p.precio, p.descuento);
                const subtotalItem = precioUnitario * cantidad;
                subtotal += subtotalItem;

                detalles.push({
                    producto_id: productoId,
                    nombre: p.nombre,
                    cantidad: cantidad,
                    precio_unitario: precioUnitario,
                    subtotal: subtotalItem,
                    stock_restante: p.stock - cantidad,
                    stock_minimo: p.stock_minimo,
                    bajo_minimo: p.stock > p.stock_minimo && p.stock - cantidad <= p.stock_minimo
                });
            }

            costoEnvio = subtotal > ENVIO.gratisDesde ? 0 : ENVIO.costo;
            total = subtotal + costoEnvio;

            const [pedido] = await conexion.query(
                `INSERT INTO pedidos
                (usuario_id, total, costo_envio, direccion_envio, metodo_pago, estado)
                VALUES (?, ?, ?, ?, ?, 'pendiente')`,
                [userId, total, costoEnvio, direccionEnvio, metodo_pago || 'Efectivo contra entrega']
            );
            pedido_id = pedido.insertId;

            for (const detalle of detalles) {
                await conexion.query(
                    `INSERT INTO detalle_pedido
                    (pedido_id, producto_id, cantidad, precio_unitario, subtotal)
                    VALUES (?, ?, ?, ?, ?)`,
                    [pedido_id, detalle.producto_id, detalle.cantidad, detalle.precio_unitario, detalle.subtotal]
                );

                await conexion.query(
                    'UPDATE productos SET stock = stock - ? WHERE id = ?',
                    [detalle.cantidad, detalle.producto_id]
                );
            }

            await conexion.commit();
        } catch (error) {
            await conexion.rollback();
            if (error.status) {
                return res.status(error.status).json({ error: error.mensaje });
            }
            throw error;
        } finally {
            conexion.release();
        }

        console.log(`✅ Pedido #${pedido_id} creado. Total: ${total}`);

        notificarN8n('pedido-creado', {
            pedido: {
                id: pedido_id,
                subtotal: subtotal,
                costo_envio: costoEnvio,
                total: total,
                estado: 'pendiente',
                direccion_envio: direccionEnvio,
                metodo_pago: metodo_pago || 'Efectivo contra entrega',
                items: detalles.map(({ nombre, cantidad, precio_unitario, subtotal }) =>
                    ({ nombre, cantidad, precio_unitario, subtotal }))
            },
            cliente: usuario[0]
        });

        // Alerta inmediata: productos que con esta compra quedaron en su stock mínimo o por debajo
        const productosBajoMinimo = detalles.filter(d => d.bajo_minimo);
        if (productosBajoMinimo.length > 0) {
            notificarN8n('stock-bajo', {
                pedido_id: pedido_id,
                productos: productosBajoMinimo.map(d => ({
                    id: d.producto_id,
                    nombre: d.nombre,
                    stock: d.stock_restante,
                    stock_minimo: d.stock_minimo
                }))
            });
        }

        res.json({
            success: true,
            message: 'Pedido creado exitosamente',
            pedido_id: pedido_id,
            subtotal: subtotal,
            costo_envio: costoEnvio,
            total: total
        });

    } catch (error) {
        console.error('❌ Error al crear pedido:', error);
        res.status(500).json({ error: 'Error al crear pedido' });
    }
});

// 7.2 PEDIDOS DE UN USUARIO (solo el propio usuario o un admin)
app.get('/api/pedidos/usuario/:usuario_id', requiereUsuario, async (req, res) => {
    try {
        if (!esDuenioOAdmin(req, req.params.usuario_id)) {
            return res.status(403).json({ error: 'No puedes ver los pedidos de otro usuario' });
        }

        const [pedidos] = await db.query(
            `SELECT p.*, e.puntuacion as encuesta_puntuacion
             FROM pedidos p
             LEFT JOIN encuestas e ON e.pedido_id = p.id
             WHERE p.usuario_id = ?
             ORDER BY p.fecha DESC`,
            [req.params.usuario_id]
        );

        for (const pedido of pedidos) {
            pedido.detalles = await obtenerItemsPedido(pedido.id);
            // Los pedidos entregados sin calificar muestran el enlace a la encuesta
            if (pedido.estado === 'entregado' && pedido.encuesta_puntuacion === null) {
                pedido.enlace_encuesta = `/encuesta.html?pedido=${pedido.id}&token=${tokenEncuesta(pedido.id)}`;
            }
        }

        res.json(pedidos);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al obtener pedidos' });
    }
});

// 7.3 TODOS LOS PEDIDOS (admin)
app.get('/api/pedidos/todos', requiereAdmin, async (req, res) => {
    try {
        const [pedidos] = await db.query(
            `SELECT p.*, u.nombres, u.apellidos, u.correo, u.telefono, e.puntuacion as encuesta_puntuacion
             FROM pedidos p
             JOIN usuarios u ON p.usuario_id = u.id
             LEFT JOIN encuestas e ON e.pedido_id = p.id
             ORDER BY p.fecha DESC`
        );

        for (const pedido of pedidos) {
            pedido.detalles = await obtenerItemsPedido(pedido.id);
        }

        res.json(pedidos);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al obtener pedidos' });
    }
});

// 7.4 ACTUALIZAR ESTADO DE PEDIDO (admin), con devolución de stock al cancelar
app.put('/api/pedidos/:id/estado', requiereAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { estado } = req.body;

        const estadosValidos = ['pendiente', 'confirmado', 'enviado', 'entregado', 'cancelado'];
        if (!estadosValidos.includes(estado)) {
            return res.status(400).json({ error: 'Estado no válido' });
        }

        const [pedidoActual] = await db.query(
            `SELECT p.id, p.estado, p.total, p.direccion_envio,
                    u.id as usuario_id, u.nombres, u.apellidos, u.correo, u.telefono
             FROM pedidos p
             JOIN usuarios u ON p.usuario_id = u.id
             WHERE p.id = ?`,
            [id]
        );

        if (pedidoActual.length === 0) {
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }

        const estadoAnterior = pedidoActual[0].estado;

        // Un pedido cancelado no puede volver a otro estado (evita duplicar stock)
        if (estadoAnterior === 'cancelado' && estado !== 'cancelado') {
            return res.status(400).json({ error: 'No se puede cambiar un pedido cancelado a otro estado' });
        }

        const conexion = await db.getConnection();
        try {
            await conexion.beginTransaction();

            if (estado === 'cancelado' && estadoAnterior !== 'cancelado') {
                const [detalles] = await conexion.query(
                    'SELECT producto_id, cantidad FROM detalle_pedido WHERE pedido_id = ?',
                    [id]
                );
                for (const detalle of detalles) {
                    await conexion.query(
                        'UPDATE productos SET stock = stock + ? WHERE id = ?',
                        [detalle.cantidad, detalle.producto_id]
                    );
                }
                console.log(`🔄 Pedido ${id} cancelado - stock devuelto`);
            }

            await conexion.query('UPDATE pedidos SET estado = ? WHERE id = ?', [estado, id]);
            await conexion.commit();
        } catch (error) {
            await conexion.rollback();
            throw error;
        } finally {
            conexion.release();
        }

        // Avisar a n8n solo si el estado realmente cambió
        if (estado !== estadoAnterior) {
            const p = pedidoActual[0];
            const items = await obtenerItemsPedido(p.id);
            const cliente = { id: p.usuario_id, nombres: p.nombres, apellidos: p.apellidos, correo: p.correo, telefono: p.telefono };

            notificarN8n('pedido-estado', {
                pedido: {
                    id: p.id,
                    total: parseFloat(p.total),
                    direccion_envio: p.direccion_envio,
                    estado_anterior: estadoAnterior,
                    estado_nuevo: estado,
                    items
                },
                cliente
            });

            // Al entregarse, n8n espera unos días y le pide al cliente que califique su compra
            if (estado === 'entregado') {
                notificarN8n('pedido-entregado', {
                    pedido: { id: p.id, total: parseFloat(p.total), items },
                    cliente,
                    enlace_encuesta: `${TIENDA_URL}/encuesta.html?pedido=${p.id}&token=${tokenEncuesta(p.id)}`,
                    esperar_minutos: ENCUESTA_ESPERA_MINUTOS
                });
            }

            // Al cancelarse, se avisa al admin (el stock ya fue devuelto arriba)
            if (estado === 'cancelado') {
                notificarN8n('pedido-cancelado', {
                    pedido: { id: p.id, total: parseFloat(p.total), estado_anterior: estadoAnterior, items },
                    cliente
                });
            }
        }

        res.json({
            success: true,
            message: `Estado del pedido actualizado a ${estado}`,
            stock_devuelto: estado === 'cancelado' && estadoAnterior !== 'cancelado'
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al actualizar estado' });
    }
});

// ============================================
// 8. ENCUESTA DE SATISFACCIÓN (después de la entrega)
// ============================================
function validarEnlaceEncuesta(pedidoId, token) {
    return pedidoId > 0 && token && compararSeguro(String(token), tokenEncuesta(pedidoId));
}

app.get('/api/encuestas/:pedidoId', async (req, res) => {
    try {
        const pedidoId = parseInt(req.params.pedidoId);
        if (!validarEnlaceEncuesta(pedidoId, req.query.token)) {
            return res.status(403).json({ error: 'El enlace de la encuesta no es válido' });
        }

        const [pedidos] = await db.query(
            `SELECT p.id, p.fecha, p.total, u.nombres, e.puntuacion, e.comentario
             FROM pedidos p
             JOIN usuarios u ON p.usuario_id = u.id
             LEFT JOIN encuestas e ON e.pedido_id = p.id
             WHERE p.id = ?`,
            [pedidoId]
        );
        if (pedidos.length === 0) {
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }

        const p = pedidos[0];
        res.json({
            pedido_id: p.id,
            fecha: p.fecha,
            total: parseFloat(p.total),
            nombres: p.nombres,
            items: await obtenerItemsPedido(p.id),
            respondida: p.puntuacion !== null,
            puntuacion: p.puntuacion
        });

    } catch (error) {
        console.error('Error al cargar encuesta:', error);
        res.status(500).json({ error: 'Error al cargar la encuesta' });
    }
});

app.post('/api/encuestas', async (req, res) => {
    try {
        const pedidoId = parseInt(req.body.pedido_id);
        const puntuacion = parseInt(req.body.puntuacion);
        const comentario = String(req.body.comentario || '').trim().slice(0, 1000) || null;

        if (!validarEnlaceEncuesta(pedidoId, req.body.token)) {
            return res.status(403).json({ error: 'El enlace de la encuesta no es válido' });
        }
        if (!(puntuacion >= 1 && puntuacion <= 5)) {
            return res.status(400).json({ error: 'Elige de 1 a 5 estrellas' });
        }

        const [existe] = await db.query('SELECT id FROM encuestas WHERE pedido_id = ?', [pedidoId]);
        if (existe.length > 0) {
            return res.status(409).json({ error: 'Ya calificaste este pedido. ¡Gracias!' });
        }

        await db.query(
            'INSERT INTO encuestas (pedido_id, puntuacion, comentario) VALUES (?, ?, ?)',
            [pedidoId, puntuacion, comentario]
        );

        // Seguimiento automático según la calificación (agradecimiento o disculpa + alerta)
        const [[pedido]] = await db.query(
            `SELECT p.id, p.total, u.nombres, u.apellidos, u.correo, u.telefono
             FROM pedidos p JOIN usuarios u ON p.usuario_id = u.id
             WHERE p.id = ?`,
            [pedidoId]
        );
        if (pedido) {
            notificarN8n('encuesta-respondida', {
                pedido: { id: pedido.id, total: parseFloat(pedido.total), items: await obtenerItemsPedido(pedido.id) },
                cliente: { nombres: pedido.nombres, apellidos: pedido.apellidos, correo: pedido.correo, telefono: pedido.telefono },
                puntuacion,
                comentario
            });
        }

        res.json({ success: true, message: '¡Gracias por calificar tu compra!' });

    } catch (error) {
        console.error('Error al guardar encuesta:', error);
        res.status(500).json({ error: 'Error al guardar la encuesta' });
    }
});

// ============================================
// 9. DASHBOARD ADMIN
// ============================================
app.get('/api/admin/dashboard', requiereAdmin, async (req, res) => {
    try {
        const [[usuarios]] = await db.query('SELECT COUNT(*) as total FROM usuarios WHERE rol = "cliente"');
        const [[productos]] = await db.query('SELECT COUNT(*) as total FROM productos');
        const [[pedidos]] = await db.query('SELECT COUNT(*) as total FROM pedidos');
        const [[ventas]] = await db.query(
            `SELECT COALESCE(SUM(total), 0) as ingresos,
                    COALESCE(SUM(CASE WHEN MONTH(fecha) = MONTH(NOW()) AND YEAR(fecha) = YEAR(NOW()) THEN total ELSE 0 END), 0) as ingresos_mes
             FROM pedidos WHERE estado <> 'cancelado'`
        );
        const [[encuestas]] = await db.query('SELECT AVG(puntuacion) as promedio, COUNT(*) as total FROM encuestas');

        const [estados] = await db.query(
            `SELECT estado, COUNT(*) as cantidad FROM pedidos GROUP BY estado`
        );

        const [ultimosPedidos] = await db.query(
            `SELECT p.*, u.nombres, u.apellidos
            FROM pedidos p
            JOIN usuarios u ON p.usuario_id = u.id
            ORDER BY p.fecha DESC
            LIMIT 5`
        );

        const [productosStockBajo] = await db.query(
            `SELECT id, nombre, imagen, stock, stock_minimo
            FROM productos
            WHERE stock <= stock_minimo
            ORDER BY stock ASC`
        );

        res.json({
            total_usuarios: usuarios.total,
            total_productos: productos.total,
            productos_stock_bajo: productosStockBajo.length,
            total_pedidos: pedidos.total,
            ingresos_totales: parseFloat(ventas.ingresos),
            ingresos_mes: parseFloat(ventas.ingresos_mes),
            satisfaccion_promedio: encuestas.promedio ? parseFloat(encuestas.promedio).toFixed(1) : null,
            satisfaccion_total: encuestas.total,
            pedidos_por_estado: estados,
            ultimos_pedidos: ultimosPedidos,
            productos_con_stock_bajo: productosStockBajo
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al obtener dashboard' });
    }
});

// ============================================
// 10. CHATBOT
// ============================================
const idiomaValido = (idioma) => (idioma === 'en' ? 'en' : 'es');

// 10.1 INICIAR CHAT (se llama solo cuando el cliente abre el chat)
app.post('/api/chat/iniciar', async (req, res) => {
    try {
        const sesion = sesionDe(req);
        const sessionId = String(req.body.session_id || crypto.randomUUID()).slice(0, 100);

        const [result] = await db.query(
            'INSERT INTO chats (session_id, usuario_id) VALUES (?, ?)',
            [sessionId, sesion ? sesion.id : null]
        );

        res.json({
            success: true,
            chat_id: result.insertId,
            mensaje_bienvenida: chatbot.mensajeBienvenida(idiomaValido(req.body.idioma))
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al iniciar chat' });
    }
});

// 10.2 PROCESAR MENSAJE: primero reglas (menú), luego IA, y si la IA falla, reglas de respaldo
app.post('/api/chat/mensaje', async (req, res) => {
    try {
        const { chat_id, mensaje } = req.body;
        const idioma = idiomaValido(req.body.idioma);

        if (!chat_id || typeof mensaje !== 'string' || !mensaje.trim()) {
            return res.status(400).json({ error: 'Mensaje inválido' });
        }
        const texto = mensaje.trim().slice(0, 500);

        const [chats] = await db.query('SELECT id FROM chats WHERE id = ?', [chat_id]);
        if (chats.length === 0) {
            return res.status(404).json({ error: 'Chat no encontrado' });
        }

        await db.query('INSERT INTO mensajes (chat_id, emisor, mensaje) VALUES (?, ?, ?)', [chat_id, 'cliente', texto]);

        const productos = await listarProductos();
        let resultado = chatbot.responderConReglas({ mensaje: texto, idioma, productos, envio: ENVIO });
        let fuente = 'reglas';

        if (!resultado.entendido) {
            const [historial] = await db.query(
                `SELECT emisor, mensaje FROM mensajes WHERE chat_id = ? ORDER BY id DESC LIMIT 9`,
                [chat_id]
            );

            const respuestaIA = await consultarIA({
                mensaje: texto,
                idioma,
                // Historial sin el mensaje actual, del más antiguo al más reciente
                historial: historial.slice(1).reverse().map(m => ({ de: m.emisor, texto: m.mensaje })),
                catalogo: productos.map(p => ({
                    nombre: p.nombre,
                    categoria: p.categoria_nombre,
                    descripcion: p.descripcion,
                    precio: p.precio,
                    descuento: p.descuento,
                    precio_final: p.precio_final,
                    stock: p.stock,
                    destacado: p.destacado
                })),
                tienda: {
                    envio_costo: ENVIO.costo,
                    envio_gratis_desde: ENVIO.gratisDesde,
                    contacto: chatbot.CONTACTO
                }
            });

            if (respuestaIA) {
                resultado = { respuesta: respuestaIA, entendido: true, solicitaAsesor: false };
                fuente = 'ia';
            } else {
                resultado = chatbot.responderConReglas({ mensaje: texto, idioma, productos, envio: ENVIO, permisivo: true });
                if (!resultado.entendido) {
                    resultado = { respuesta: chatbot.respuestaNoEntendida(idioma), entendido: false, solicitaAsesor: false };
                }
            }
        }

        await db.query('INSERT INTO mensajes (chat_id, emisor, mensaje) VALUES (?, ?, ?)', [chat_id, 'bot', resultado.respuesta]);

        // "Escalado" = el bot no pudo resolver o el cliente pidió un humano (se usa en el reporte mensual)
        const escalado = !resultado.entendido || resultado.solicitaAsesor;
        if (escalado) {
            await db.query('UPDATE chats SET escalado_humano = TRUE WHERE id = ?', [chat_id]);
        }

        // Avisar a un asesor humano solo la primera vez que el cliente lo pide en este chat
        if (resultado.solicitaAsesor) {
            const [chat] = await db.query(
                `SELECT ch.solicitud_asesor, u.nombres, u.apellidos, u.correo, u.telefono
                 FROM chats ch
                 LEFT JOIN usuarios u ON ch.usuario_id = u.id
                 WHERE ch.id = ?`,
                [chat_id]
            );
            if (chat.length > 0 && !chat[0].solicitud_asesor) {
                await db.query('UPDATE chats SET solicitud_asesor = TRUE WHERE id = ?', [chat_id]);
                const [ultimos] = await db.query(
                    `SELECT mensaje FROM mensajes
                     WHERE chat_id = ? AND emisor = 'cliente'
                     ORDER BY id DESC LIMIT 5`,
                    [chat_id]
                );
                notificarN8n('chat-asesor', {
                    chat_id: chat_id,
                    cliente: chat[0].correo
                        ? { nombres: chat[0].nombres, apellidos: chat[0].apellidos, correo: chat[0].correo, telefono: chat[0].telefono }
                        : null,
                    ultimos_mensajes: ultimos.reverse().map(m => m.mensaje)
                });
            }
        }

        res.json({ success: true, respuesta: resultado.respuesta, escalado, fuente });

    } catch (error) {
        console.error('Error en chat:', error);
        res.status(500).json({ error: 'Error al procesar mensaje' });
    }
});

// 10.3 CALIFICACIÓN DEL CHAT
app.post('/api/calificacion', async (req, res) => {
    try {
        const { chat_id, comentario } = req.body;
        const estrellas = parseInt(req.body.puntuacion);

        if (!chat_id || !(estrellas >= 1 && estrellas <= 5)) {
            return res.status(400).json({ error: 'Calificación inválida' });
        }

        await db.query(
            'INSERT INTO calificaciones (chat_id, puntuacion, comentario) VALUES (?, ?, ?)',
            [chat_id, estrellas, comentario || null]
        );

        await db.query('UPDATE chats SET fecha_fin = NOW() WHERE id = ?', [chat_id]);

        // Calificaciones de 1 o 2 estrellas se avisan al equipo para hacer seguimiento
        if (estrellas <= 2) {
            const [chat] = await db.query(
                `SELECT u.nombres, u.apellidos, u.correo, u.telefono
                 FROM chats ch
                 LEFT JOIN usuarios u ON ch.usuario_id = u.id
                 WHERE ch.id = ?`,
                [chat_id]
            );
            notificarN8n('calificacion-baja', {
                chat_id: chat_id,
                puntuacion: estrellas,
                comentario: comentario || null,
                cliente: chat.length > 0 && chat[0].correo ? chat[0] : null
            });
        }

        res.json({ success: true, message: '¡Gracias por tu calificación!' });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al guardar calificación' });
    }
});

// ============================================
// 11. REPORTE MENSUAL (Admin y n8n)
// ============================================
app.get('/api/reportes/mensual', requiereAdmin, async (req, res) => {
    try {
        const hoy = new Date();
        const mes = parseInt(req.query.mes) || hoy.getMonth() + 1;
        const anio = parseInt(req.query.anio) || hoy.getFullYear();

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

        res.json({
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
        });

    } catch (error) {
        console.error('Error en reporte:', error);
        res.status(500).json({ error: 'Error al generar reporte' });
    }
});

// ============================================
// 12. RESUMEN DIARIO (para la automatización de n8n)
// ============================================
app.get('/api/admin/resumen-diario', requiereAdmin, async (req, res) => {
    try {
        const horas = parseInt(req.query.horas) || 48;

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

        res.json({
            fecha: new Date().toISOString(),
            stock_bajo: stockBajo,
            pedidos_atrasados: pedidosAtrasados,
            horas_limite: horas
        });

    } catch (error) {
        console.error('Error en resumen diario:', error);
        res.status(500).json({ error: 'Error al generar resumen diario' });
    }
});

// ============================================
// 12.1 CIERRE DEL DÍA: ventas de hoy vs. ayer (para n8n, cada noche)
// ============================================
app.get('/api/admin/cierre-dia', requiereAdmin, async (req, res) => {
    try {
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

        res.json({
            fecha: new Date().toISOString(),
            pedidos_hoy: Number(ventas.pedidos_hoy) || 0,
            ingresos_hoy: parseFloat(ventas.ingresos_hoy) || 0,
            cancelados_hoy: Number(ventas.cancelados_hoy) || 0,
            ingresos_ayer: parseFloat(ventas.ingresos_ayer) || 0,
            top_productos: topProductos.map(p => ({ nombre: p.nombre, unidades: Number(p.unidades) })),
            pedidos_pendientes: pendientes.total,
            clientes_nuevos: nuevosClientes.total
        });

    } catch (error) {
        console.error('Error en cierre del día:', error);
        res.status(500).json({ error: 'Error al generar el cierre del día' });
    }
});

// ============================================
// 12.2 CONSULTAS PARA LAS CENTRALES DE AUTOMATIZACIÓN (n8n)
// ============================================

// Historial de compras de un cliente (para clasificarlo como nuevo, recurrente o VIP)
app.get('/api/admin/clientes/:id/historial', requiereAdmin, async (req, res) => {
    try {
        const excluir = parseInt(req.query.excluir_pedido) || 0;
        const [[historial]] = await db.query(
            `SELECT COUNT(*) as pedidos_previos,
                    COALESCE(SUM(total), 0) as total_gastado,
                    MIN(fecha) as primera_compra
             FROM pedidos
             WHERE usuario_id = ? AND estado <> 'cancelado' AND id <> ?`,
            [req.params.id, excluir]
        );
        res.json({
            usuario_id: parseInt(req.params.id),
            pedidos_previos: historial.pedidos_previos,
            total_gastado: parseFloat(historial.total_gastado),
            primera_compra: historial.primera_compra
        });
    } catch (error) {
        console.error('Error en historial de cliente:', error);
        res.status(500).json({ error: 'Error al consultar el historial' });
    }
});

// Ventas por producto en los últimos N días (devuelve una lista: n8n la recorre producto por producto)
app.get('/api/admin/ventas-productos', requiereAdmin, async (req, res) => {
    try {
        const dias = Math.min(365, parseInt(req.query.dias) || 30);
        const productoId = parseInt(req.query.producto) || null;
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
        res.json(filas.map(f => ({
            id: f.id,
            nombre: f.nombre,
            stock: f.stock,
            stock_minimo: f.stock_minimo,
            precio: parseFloat(f.precio),
            unidades: Number(f.unidades),
            ingresos: parseFloat(f.ingresos),
            dias
        })));
    } catch (error) {
        console.error('Error en ventas por producto:', error);
        res.status(500).json({ error: 'Error al consultar ventas por producto' });
    }
});

// Reabastecer: suma unidades al stock (lo usa n8n cuando el dueño aprueba la compra)
app.post('/api/admin/productos/:id/reabastecer', requiereAdmin, async (req, res) => {
    try {
        const cantidad = parseInt(req.body.cantidad);
        if (!(cantidad > 0 && cantidad <= 10000)) {
            return res.status(400).json({ error: 'Cantidad inválida' });
        }
        const [result] = await db.query('UPDATE productos SET stock = stock + ? WHERE id = ?', [cantidad, req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Producto no encontrado' });
        }
        const [[producto]] = await db.query('SELECT id, nombre, stock, stock_minimo FROM productos WHERE id = ?', [req.params.id]);
        console.log(`📦 Reabastecido: ${producto.nombre} +${cantidad} → ${producto.stock}`);
        res.json({ success: true, agregado: cantidad, ...producto });
    } catch (error) {
        console.error('Error al reabastecer:', error);
        res.status(500).json({ error: 'Error al reabastecer el producto' });
    }
});

// Indicadores del periodo actual vs. el periodo anterior (para el analista semanal)
app.get('/api/admin/indicadores', requiereAdmin, async (req, res) => {
    try {
        const dias = Math.min(90, parseInt(req.query.dias) || 7);
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
        res.json({ dias, actual: await periodo(dias, 0), anterior: await periodo(dias * 2, dias) });
    } catch (error) {
        console.error('Error en indicadores:', error);
        res.status(500).json({ error: 'Error al calcular indicadores' });
    }
});

// Red de seguridad: un error inesperado se anota en la consola, pero el servidor NO se apaga
process.on('unhandledRejection', (error) => {
    console.error('⚠️ Error no controlado (el servidor sigue funcionando):', error);
});
process.on('uncaughtException', (error) => {
    console.error('⚠️ Excepción no controlada (el servidor sigue funcionando):', error);
});

// Rutas /api que no existen → error en JSON (no la página HTML por defecto)
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada' });
});

// ============================================
// 13. INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en ${TIENDA_URL}`);
    console.log(`📊 Panel admin: ${TIENDA_URL}/admin.html`);
    console.log(`🔔 Webhooks n8n: ${process.env.N8N_WEBHOOK_URL || 'desactivados'}`);
    if (!process.env.ADMIN_TOKEN_SECRET) {
        console.warn('⚠️ ADMIN_TOKEN_SECRET no definido: las sesiones se cierran al reiniciar');
    }
});
