-- 004: módulo de visión, lectura de facturas de proveedor (tercer corte)
-- El servidor aplica estos cambios solo al iniciar (ver aplicarMigraciones en server.js).

CREATE TABLE IF NOT EXISTS facturas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    -- Archivos dentro de uploads/facturas: quién subió qué y cuándo
    archivo VARCHAR(80) NOT NULL,
    archivo_anonimizado VARCHAR(100) NULL,
    nombre_original VARCHAR(200) NULL,
    tipo_mime VARCHAR(40) NOT NULL,
    tamano INT UNSIGNED NOT NULL,
    hash_sha256 CHAR(64) NOT NULL,
    origen ENUM('web', 'celular', 'chatbot') NOT NULL DEFAULT 'web',
    subido_por INT NULL,
    subido_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Lectura de la IA
    estado ENUM('procesando', 'reintentando', 'lista', 'por_revisar', 'confirmada', 'rechazada', 'no_legible', 'error') NOT NULL DEFAULT 'procesando',
    motivo VARCHAR(255) NULL,
    datos_ia MEDIUMTEXT NULL,
    confianza DECIMAL(4,3) NULL,
    modelo VARCHAR(100) NULL,
    zonas_tapadas SMALLINT UNSIGNED NULL,
    -- Datos confirmados por una persona
    datos_finales MEDIUMTEXT NULL,
    proveedor VARCHAR(200) NULL,
    nit VARCHAR(30) NULL,
    numero_factura VARCHAR(60) NULL,
    fecha_factura DATE NULL,
    total DECIMAL(14,2) NULL,
    corregida TINYINT(1) NOT NULL DEFAULT 0,
    revisado_por INT NULL,
    revisado_en DATETIME NULL,
    KEY idx_estado (estado),
    KEY idx_hash (hash_sha256),
    KEY idx_numero (numero_factura),
    FOREIGN KEY (subido_por) REFERENCES usuarios(id) ON DELETE SET NULL,
    FOREIGN KEY (revisado_por) REFERENCES usuarios(id) ON DELETE SET NULL
);
