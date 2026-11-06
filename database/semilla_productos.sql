-- Catálogo inicial de la tienda (datos públicos). Lo carga: npm run bd:preparar
SET NAMES utf8mb4;
INSERT INTO categorias (id, nombre, descripcion) VALUES
(2, 'Dulces', 'Dulces y postres artesanales'),
(3, 'Granos', 'Granos y cereales andinos'),
(4, 'Gourmet', 'Productos gourmet de la región'),
(5, 'Lácteos', 'Leche de los Andes.'),
(11, 'Bb', '1');
INSERT INTO productos (id, nombre, descripcion, precio, stock, stock_minimo, categoria_id, destacado, imagen) VALUES
(1, 'Café Orgánico', 'Café 100% orgánico de la región andina, tueste medio, notas de chocolate y caramelo.', '45000.00', 49, 5, NULL, 1, 'https://images.unsplash.com/photo-1447933601403-0c6688de566e?w=800&q=80'),
(2, 'Miel de Abeja', 'Miel pura de abejas, recolectada en los páramos andinos. 100% natural.', '40000.00', 27, 5, 2, 1, 'https://images.unsplash.com/photo-1471943311424-646960669fbc?w=800&q=80'),
(3, 'Quinua Real', 'Quinua orgánica de los Andes, rica en proteínas y aminoácidos esenciales.', '28000.00', 40, 5, 3, 0, 'https://images.unsplash.com/photo-1586201375761-83865001e31c?w=800&q=80'),
(4, 'Panela Artesanal', 'Panela tradicional elaborada en trapiches artesanales, sin químicos.', '15000.00', 55, 5, 2, 0, NULL),
(5, 'Aguardiente Andino', 'Aguardiente tradicional con sabor a anís, destilado en alambiques de cobre.', '59000.00', 0, 3, NULL, 1, NULL),
(6, 'Mermelada de Mora', 'Mermelada artesanal de mora andina, sin conservantes ni colorantes.', '18000.00', 13, 5, 2, 0, 'https://www.recetasnestle.cl/sites/default/files/styles/recipe_detail_desktop_new/public/srh_recipes/9da270ea1199250ff7bf9d1919d3d5d5.jpg?itok=lWv3jm8m'),
(7, 'Chocolate Artesanal', 'Chocolate con cacao andino, 70% cacao, sabor intenso y frutal.', '38000.00', 15, 3, 2, 1, 'https://images.unsplash.com/photo-1511381939415-e44015466834?w=800&q=80'),
(8, 'Aceite de Oliva', 'Aceite de oliva extra virgen producido en los valles andinos.', '42000.00', 23, 3, 4, 0, 'https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?w=800&q=80'),
(9, 'Sal de Maras', 'Sal artesanal de las salineras de Maras, rica en minerales.', '22000.00', 0, 5, 4, 0, 'https://images.unsplash.com/photo-1518110925495-5fe2fda0442c?w=800&q=80'),
(10, 'Té de Hierbas', 'Mezcla de hierbas andinas: muña, manzanilla, cedrón, y menta.', '16000.00', 38, 5, NULL, 1, NULL),
(11, 'Cañihua', 'Un grano muy resistente a climas fríos, lleno de antioxidantes y proteínas.', '66000.00', 20, 5, 3, 1, 'https://images.unsplash.com/photo-1610725664285-7c57e6eeac3f?w=800&q=80');
