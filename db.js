// db.js - Configuración de la base de datos
const mysql = require('mysql2');

// DB_* es lo normal; MYSQL* son los nombres que usan algunos servidores en la nube
function configuracionBD(entorno = process.env) {
    return {
        host: entorno.DB_HOST || entorno.MYSQLHOST || 'localhost',
        port: parseInt(entorno.DB_PORT || entorno.MYSQLPORT) || 3306,
        user: entorno.DB_USER || entorno.MYSQLUSER || 'root',
        password: entorno.DB_PASSWORD || entorno.MYSQLPASSWORD || '',
        database: entorno.DB_NAME || entorno.MYSQLDATABASE || 'raices_andinas',
        timezone: '-05:00',
        ...(entorno.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: entorno.DB_SSL_ESTRICTO === 'true' } } : {}),
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    };
}

const pool = mysql.createPool(configuracionBD());

// Hora de Colombia en NOW() y CURDATE(), aunque el servidor esté en otro país
pool.on('connection', (conexion) => conexion.query("SET time_zone = '-05:00'"));

const db = pool.promise();

async function probarConexion() {
    try {
        await db.query('SELECT 1');
        console.log('✅ Conexión a MySQL exitosa');
        return true;
    } catch (error) {
        console.error('❌ Error al conectar a MySQL:', error.message);
        console.log('💡 Asegúrate de que XAMPP esté corriendo (MySQL activado)');
        return false;
    }
}

module.exports = { db, probarConexion, configuracionBD };
