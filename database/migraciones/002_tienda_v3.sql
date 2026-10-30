-- Migración 002: rediseño de la tienda y nuevas automatizaciones
-- El servidor la aplica automáticamente al iniciar (server.js → aplicarMigraciones), este archivo es de referencia.

-- Ofertas reales: porcentaje de descuento por producto (0 = sin oferta)
ALTER TABLE productos ADD COLUMN IF NOT EXISTS descuento TINYINT UNSIGNED NOT NULL DEFAULT 0;
-- Las imágenes se guardan como enlace (URL), que puede ser largo
ALTER TABLE productos MODIFY imagen VARCHAR(1000) NULL;
-- Costo de envío cobrado en cada pedido (el total ya lo incluye)
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS costo_envio DECIMAL(10,2) NOT NULL DEFAULT 0;

-- Enlaces para restablecer la contraseña (se guarda solo el hash del token)
CREATE TABLE IF NOT EXISTS password_resets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    usuario_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    expira DATETIME NOT NULL,
    usado TINYINT(1) NOT NULL DEFAULT 0,
    creado TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY (token_hash),
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

-- Encuestas de satisfacción después de la entrega (una por pedido)
CREATE TABLE IF NOT EXISTS encuestas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pedido_id INT NOT NULL UNIQUE,
    puntuacion TINYINT NOT NULL CHECK (puntuacion BETWEEN 1 AND 5),
    comentario TEXT NULL,
    fecha TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE
);
