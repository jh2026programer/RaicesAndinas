-- 005: registro de compras a proveedores, alimentado por las facturas confirmadas (tercer corte)
-- El servidor aplica estos cambios solo al iniciar (ver aplicarMigraciones en server.js).

CREATE TABLE IF NOT EXISTS compras (
    id INT AUTO_INCREMENT PRIMARY KEY,
    factura_id INT NOT NULL UNIQUE,
    proveedor VARCHAR(200) NOT NULL,
    nit VARCHAR(30) NULL,
    numero_factura VARCHAR(60) NOT NULL,
    fecha_factura DATE NOT NULL,
    subtotal DECIMAL(14,2) NULL,
    iva DECIMAL(14,2) NOT NULL DEFAULT 0,
    total DECIMAL(14,2) NOT NULL,
    registrada_por INT NULL,
    registrada_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (factura_id) REFERENCES facturas(id),
    FOREIGN KEY (registrada_por) REFERENCES usuarios(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS compras_detalle (
    id INT AUTO_INCREMENT PRIMARY KEY,
    compra_id INT NOT NULL,
    producto_id INT NULL,
    descripcion VARCHAR(255) NOT NULL,
    cantidad INT NOT NULL,
    valor_unitario DECIMAL(14,2) NULL,
    subtotal DECIMAL(14,2) NULL,
    FOREIGN KEY (compra_id) REFERENCES compras(id) ON DELETE CASCADE,
    FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL
);

-- "cumplida": llegó la factura sin esperar la aprobación. "facturada": se aprobó y luego llegó su factura.
ALTER TABLE solicitudes_compra MODIFY estado ENUM('pendiente', 'aprobada', 'rechazada', 'vencida', 'cumplida', 'facturada') NOT NULL DEFAULT 'pendiente';
