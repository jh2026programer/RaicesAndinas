// scripts/preparar-bd.js
// Deja lista una base de datos vacía en el servidor: tablas, catálogo y administrador inicial.
// Uso: ADMIN_CORREO_INICIAL=... ADMIN_PASSWORD_INICIAL=... npm run bd:preparar
// Es seguro repetirlo: no borra nada y no toca lo que ya existe.

try {
    process.loadEnvFile();
} catch {
    // En el servidor las variables vienen del entorno
}

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { configuracionBD } = require('../db');

const CONTRASENAS_DEBILES = /^(admin|password|contrase|123|raices)/i;

(async () => {
    const correo = String(process.env.ADMIN_CORREO_INICIAL || '').trim().toLowerCase();
    const clave = process.env.ADMIN_PASSWORD_INICIAL || '';
    if (correo && (clave.length < 10 || CONTRASENAS_DEBILES.test(clave))) {
        console.error('❌ ADMIN_PASSWORD_INICIAL debe tener al menos 10 caracteres y no ser una contraseña común.');
        process.exit(1);
    }

    const { waitForConnections, connectionLimit, queueLimit, ...config } = configuracionBD();
    const db = await mysql.createConnection({ ...config, multipleStatements: true, charset: 'utf8mb4' });

    const [tablas] = await db.query(`SHOW TABLES LIKE 'usuarios'`);
    if (tablas.length === 0) {
        await db.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'raices_andinas.sql'), 'utf8'));
        console.log('✅ Tablas creadas');
    } else {
        console.log('ℹ️ Las tablas ya existían');
    }

    const [[{ productos }]] = await db.query('SELECT COUNT(*) as productos FROM productos');
    if (productos === 0) {
        await db.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'semilla_productos.sql'), 'utf8'));
        console.log('✅ Catálogo cargado');
    } else {
        console.log(`ℹ️ El catálogo ya tiene ${productos} productos`);
    }

    if (correo) {
        const [existe] = await db.query('SELECT id FROM usuarios WHERE correo = ?', [correo]);
        if (existe.length) {
            console.log('ℹ️ Ese administrador ya existe: no se cambió');
        } else {
            await db.query(
                `INSERT INTO usuarios (nombres, apellidos, correo, password, rol) VALUES ('Administrador', 'Sistema', ?, ?, 'admin')`,
                [correo, await bcrypt.hash(clave, 10)]
            );
            console.log('✅ Administrador creado');
        }
    }
    await db.end();
    process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
