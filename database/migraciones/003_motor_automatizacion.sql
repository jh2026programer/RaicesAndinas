-- 003: motor de automatización en código (tercer corte)
-- El servidor aplica estos cambios solo al iniciar (ver aplicarMigraciones en server.js).

-- Bitácora: una fila por cada ejecución de un flujo
CREATE TABLE IF NOT EXISTS automatizacion_ejecuciones (
    id INT AUTO_INCREMENT PRIMARY KEY,
    central VARCHAR(40) NOT NULL,
    flujo_id VARCHAR(60) NOT NULL,
    flujo VARCHAR(100) NOT NULL,
    disparador VARCHAR(100) NOT NULL,
    entrada TEXT NULL,
    resultado TEXT NULL,
    pasos TEXT NULL,
    estado ENUM('en_curso', 'exito', 'parcial', 'error') NOT NULL DEFAULT 'en_curso',
    intentos TINYINT UNSIGNED NOT NULL DEFAULT 1,
    error TEXT NULL,
    causa VARCHAR(255) NULL,
    gravedad VARCHAR(10) NULL,
    inicio TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fin DATETIME NULL,
    duracion_ms INT UNSIGNED NULL,
    KEY idx_estado (estado),
    KEY idx_inicio (inicio)
);

-- Cola: esperas largas y reintentos tardíos (sobreviven a un reinicio del servidor)
CREATE TABLE IF NOT EXISTS automatizacion_tareas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    flujo_id VARCHAR(60) NOT NULL,
    datos MEDIUMTEXT NOT NULL,
    ejecutar_en DATETIME NOT NULL,
    estado ENUM('pendiente', 'en_curso', 'hecha', 'error') NOT NULL DEFAULT 'pendiente',
    creado TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_pendientes (estado, ejecutar_en)
);

-- Compras sugeridas que esperan la decisión del dueño
CREATE TABLE IF NOT EXISTS solicitudes_compra (
    id INT AUTO_INCREMENT PRIMARY KEY,
    productos TEXT NOT NULL,
    total_estimado DECIMAL(12,2) NOT NULL DEFAULT 0,
    orden TEXT NULL,
    estado ENUM('pendiente', 'aprobada', 'rechazada', 'vencida') NOT NULL DEFAULT 'pendiente',
    creado TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expira DATETIME NOT NULL,
    decidido_por VARCHAR(60) NULL,
    decidido_en DATETIME NULL,
    KEY idx_estado (estado)
);

-- Auditoría: cada intento de usar un modelo de IA
CREATE TABLE IF NOT EXISTS ia_auditoria (
    id INT AUTO_INCREMENT PRIMARY KEY,
    fecha TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    funcion VARCHAR(40) NOT NULL,
    usuario_id INT NULL,
    proveedor VARCHAR(20) NOT NULL,
    modelo VARCHAR(80) NOT NULL,
    entrada VARCHAR(500) NULL,
    resultado TEXT NULL,
    confianza DECIMAL(4,3) NULL,
    exito TINYINT(1) NOT NULL DEFAULT 0,
    error VARCHAR(300) NULL,
    duracion_ms INT UNSIGNED NULL,
    KEY idx_fecha (fecha)
);
