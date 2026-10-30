// servicios/chatbot.js
// Respuestas del asistente virtual basadas en reglas (menú numérico y palabras clave).
// Los productos y precios se leen de la base de datos, nunca se escriben a mano.
// Si el mensaje no coincide con ninguna regla, server.js intenta responder con IA (n8n + Gemini).

const CONTACTO = {
    correo: 'soporte@raicesandinas.com',
    whatsapp: '+57 300 123 4567',
    telefono: '+57 (1) 234 5678'
};

const pesos = (valor) => '$' + Math.round(Number(valor) || 0).toLocaleString('es-CO');

// Quita tildes y pasa a minúsculas para comparar textos ("Café" === "cafe")
const normalizar = (texto) => String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

const TEXTOS = {
    es: {
        menu: '🌿 *Menú principal*\n\nEscribe el número de una opción o pregúntame lo que quieras:\n\n' +
              '1️⃣ Productos y precios\n2️⃣ Envíos y entregas\n3️⃣ Devoluciones y garantías\n' +
              '4️⃣ Ofertas y promociones\n5️⃣ Cómo comprar\n6️⃣ Hablar con un asesor\n7️⃣ Salir',
        bienvenida: '¡Hola! 👋 Soy el asistente virtual de *Raíces Andinas*.',
        productosTitulo: '📦 *Nuestros productos*',
        sinProductos: 'En este momento no tenemos productos disponibles.',
        agotado: 'agotado',
        detalleProducto: 'Escribe el nombre de un producto para ver más detalles.',
        envios: (costo, gratis) => '🚚 *Envíos y entregas*\n\n' +
              '• Enviamos a toda Colombia\n' +
              `• Envío estándar (3 a 5 días hábiles): ${pesos(costo)}\n` +
              `• 🎁 *Envío GRATIS* en compras mayores a ${pesos(gratis)}\n` +
              '• Te avisamos por correo cada cambio de estado de tu pedido',
        devoluciones: '🔄 *Devoluciones y garantías*\n\n' +
              '• Tienes 30 días después de recibir tu pedido\n' +
              '• El producto debe estar en su empaque original\n' +
              '• El reembolso se hace en 5 a 7 días hábiles\n\n' +
              `Para iniciar una devolución escribe a ${CONTACTO.correo}`,
        ofertasTitulo: '🎉 *Ofertas vigentes*',
        sinOfertas: 'Hoy no tenemos ofertas activas, pero mira nuestros productos destacados ⭐',
        comoComprar: '🛒 *Cómo comprar*\n\n' +
              '1️⃣ Crea tu cuenta o inicia sesión\n2️⃣ Agrega productos al carrito\n' +
              '3️⃣ Revisa tu carrito y tu dirección\n4️⃣ Pulsa "Finalizar compra"\n' +
              '5️⃣ Recibirás un correo de confirmación 📧',
        contacto: '📞 *Hablar con un asesor*\n\n' +
              `• 📧 ${CONTACTO.correo}\n• 📱 WhatsApp: ${CONTACTO.whatsapp}\n• ☎️ ${CONTACTO.telefono}\n\n` +
              'Horario: lunes a viernes 8 a. m. – 6 p. m., sábados 9 a. m. – 1 p. m.\n\n' +
              '✅ Ya avisamos a nuestro equipo: un asesor se comunicará contigo pronto.',
        salir: '👋 ¡Gracias por visitar Raíces Andinas! Vuelve pronto 💚\n\nEscribe "hola" si necesitas ayuda de nuevo.',
        gracias: '¡Con mucho gusto! 😊 ¿Te ayudo con algo más? Escribe "menú" para ver las opciones.',
        noEntendi: '🤔 No entendí tu mensaje.',
        volverMenu: 'Escribe "menú" para volver a las opciones.',
        precio: 'Precio',
        antes: 'antes',
        disponibles: 'disponibles'
    },
    en: {
        menu: '🌿 *Main menu*\n\nType an option number or ask me anything:\n\n' +
              '1️⃣ Products and prices\n2️⃣ Shipping and delivery\n3️⃣ Returns and warranty\n' +
              '4️⃣ Offers and promotions\n5️⃣ How to buy\n6️⃣ Talk to an advisor\n7️⃣ Exit',
        bienvenida: 'Hi! 👋 I am the virtual assistant of *Raíces Andinas*.',
        productosTitulo: '📦 *Our products*',
        sinProductos: 'We have no products available right now.',
        agotado: 'sold out',
        detalleProducto: 'Type a product name to see more details.',
        envios: (costo, gratis) => '🚚 *Shipping and delivery*\n\n' +
              '• We ship all over Colombia\n' +
              `• Standard shipping (3 to 5 business days): ${pesos(costo)}\n` +
              `• 🎁 *FREE shipping* on orders over ${pesos(gratis)}\n` +
              '• We email you every time your order status changes',
        devoluciones: '🔄 *Returns and warranty*\n\n' +
              '• You have 30 days after receiving your order\n' +
              '• The product must be in its original packaging\n' +
              '• Refunds take 5 to 7 business days\n\n' +
              `To start a return write to ${CONTACTO.correo}`,
        ofertasTitulo: '🎉 *Current offers*',
        sinOfertas: 'No active offers today, but check our featured products ⭐',
        comoComprar: '🛒 *How to buy*\n\n' +
              '1️⃣ Create an account or log in\n2️⃣ Add products to the cart\n' +
              '3️⃣ Review your cart and address\n4️⃣ Click "Checkout"\n' +
              '5️⃣ You will receive a confirmation email 📧',
        contacto: '📞 *Talk to an advisor*\n\n' +
              `• 📧 ${CONTACTO.correo}\n• 📱 WhatsApp: ${CONTACTO.whatsapp}\n• ☎️ ${CONTACTO.telefono}\n\n` +
              'Hours: Monday to Friday 8 a.m. – 6 p.m., Saturday 9 a.m. – 1 p.m.\n\n' +
              '✅ We already notified our team: an advisor will contact you soon.',
        salir: '👋 Thanks for visiting Raíces Andinas! Come back soon 💚\n\nType "hello" if you need help again.',
        gracias: 'You are welcome! 😊 Anything else? Type "menu" to see the options.',
        noEntendi: '🤔 I did not understand your message.',
        volverMenu: 'Type "menu" to go back to the options.',
        precio: 'Price',
        antes: 'was',
        disponibles: 'available'
    }
};

const PATRONES = {
    asesor: /\b(asesor|humano|persona real|agente|advisor|human|agent|hablar con alguien|talk to someone)\b/,
    menu: /^(menu|menú|opciones|options|volver|back|inicio|start)$/,
    saludo: /^(hola|hello|hi|hey|buenas|buenos dias|buenas tardes|buenas noches|good morning|good afternoon|que tal)\b/,
    gracias: /^(gracias|muchas gracias|thanks|thank you|ok|okay|vale|listo|perfecto|genial|great)\b/,
    salir: /^(salir|chao|adios|bye|goodbye|exit)\b/
};

function lineaProducto(p, t) {
    const sinStock = p.stock <= 0 ? ` (${t.agotado})` : '';
    if (p.descuento > 0) {
        return `• ${p.nombre}: *${pesos(p.precio_final)}* (-${p.descuento}%, ${t.antes} ${pesos(p.precio)})${sinStock}`;
    }
    return `• ${p.nombre}: ${pesos(p.precio)}${sinStock}`;
}

function detalleProducto(p, t) {
    const precio = p.descuento > 0
        ? `${pesos(p.precio_final)} (-${p.descuento}%, ${t.antes} ${pesos(p.precio)})`
        : pesos(p.precio);
    return `📦 *${p.nombre}*\n\n${p.descripcion || ''}\n\n` +
           `💰 ${t.precio}: ${precio}\n` +
           (p.stock > 0 ? `✅ ${p.stock} ${t.disponibles}` : `❌ ${t.agotado}`);
}

/**
 * Intenta responder con reglas.
 * @returns {{ respuesta: string|null, entendido: boolean, solicitaAsesor: boolean }}
 */
function responderConReglas({ mensaje, idioma, productos, envio, permisivo = false }) {
    const t = TEXTOS[idioma] || TEXTOS.es;
    const msg = normalizar(mensaje);
    const respuesta = (texto, extra = {}) => ({ respuesta: texto, entendido: true, solicitaAsesor: false, ...extra });

    switch (msg) {
        case '1': {
            if (productos.length === 0) return respuesta(t.sinProductos);
            return respuesta(`${t.productosTitulo}\n\n${productos.map(p => lineaProducto(p, t)).join('\n')}\n\n${t.detalleProducto}`);
        }
        case '2': return respuesta(`${t.envios(envio.costo, envio.gratisDesde)}\n\n${t.volverMenu}`);
        case '3': return respuesta(`${t.devoluciones}\n\n${t.volverMenu}`);
        case '4': {
            const ofertas = productos.filter(p => p.descuento > 0);
            if (ofertas.length === 0) {
                const destacados = productos.filter(p => p.destacado);
                return respuesta(`${t.sinOfertas}\n\n${destacados.map(p => lineaProducto(p, t)).join('\n')}`);
            }
            return respuesta(`${t.ofertasTitulo}\n\n${ofertas.map(p => lineaProducto(p, t)).join('\n')}`);
        }
        case '5': return respuesta(`${t.comoComprar}\n\n${t.volverMenu}`);
        case '6': return respuesta(t.contacto, { solicitaAsesor: true });
        case '7': return respuesta(t.salir);
    }

    if (PATRONES.asesor.test(msg)) return respuesta(t.contacto, { solicitaAsesor: true });
    if (PATRONES.menu.test(msg) || PATRONES.saludo.test(msg)) return respuesta(t.menu);
    if (PATRONES.gracias.test(msg)) return respuesta(t.gracias);
    if (PATRONES.salir.test(msg)) return respuesta(t.salir);

    // ¿Menciona un producto? (compara cada palabra significativa del nombre)
    const producto = productos.find(p => normalizar(p.nombre).split(/\s+/)
        .filter(palabra => palabra.length > 3)
        .some(palabra => msg.includes(palabra)));
    // Los mensajes largos se dejan a la IA, salvo en modo permisivo (cuando la IA no está disponible)
    if (producto && (permisivo || msg.split(/\s+/).length <= 4)) return respuesta(detalleProducto(producto, t));

    return { respuesta: null, entendido: false, solicitaAsesor: false };
}

function respuestaNoEntendida(idioma) {
    const t = TEXTOS[idioma] || TEXTOS.es;
    return `${t.noEntendi}\n\n${t.menu}`;
}

function mensajeBienvenida(idioma) {
    const t = TEXTOS[idioma] || TEXTOS.es;
    return `${t.bienvenida}\n\n${t.menu}`;
}

module.exports = { responderConReglas, respuestaNoEntendida, mensajeBienvenida, CONTACTO };
