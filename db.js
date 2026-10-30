// db.js - Configuración de la base de datos
const mysql = require('mysql2');

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'raices_andinas',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

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

module.exports = { db, probarConexion };
