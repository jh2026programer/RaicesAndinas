// public/js/comun.js
// Funciones compartidas por todas las páginas de la tienda:
// encabezado, pie de página, sesión, carrito, peticiones a la API, notificaciones e imágenes.
// Todo queda dentro del objeto global "RA" (Raíces Andinas) para no chocar con otros scripts.

(function () {
    const ICONOS = {
        logo: '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M3 26 12 11l5 8 4-6 8 13H3Z" fill="#d4a853"/><path d="M12 11 9.2 15.7l2.3-1 1.5 1.6 1.4-1.9L12 11Z" fill="#fff"/><path d="M21 13l-2 3 1.6-.4L22 17l.7-1.4L21 13Z" fill="#fff"/><circle cx="24" cy="7" r="3" fill="#d4a853"/></svg>',
        carrito: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/></svg>',
        menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
        cerrar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
        mas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
        ojo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
        instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor"/></svg>',
        facebook: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14 8h3V4h-3a5 5 0 0 0-5 5v2H7v4h2v7h4v-7h3l1-4h-4V9a1 1 0 0 1 1-1Z"/></svg>',
        whatsapp: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15l-1.4 5 5.1-1.3A10 10 0 1 0 12 2Zm5.4 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.5-3.9-4.7-4.1-.1-.2-1.1-1.5-1.1-2.9 0-1.4.7-2 1-2.3.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.4.6-.4.4c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1c.2-.3.4-.2.7-.1l1.9.9c.3.1.5.2.5.3.1.2.1.7-.1 1.3Z"/></svg>'
    };

    // Imagen de respaldo cuando un producto no tiene foto o el enlace está roto
    const IMAGEN_RESPALDO = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">' +
        '<rect width="400" height="300" fill="#fbf6ea"/>' +
        '<path d="M60 250 160 110l55 80 40-55 85 115Z" fill="#f4e7c8"/>' +
        '<path d="M160 110 135 146l20-8 15 16 14-18Z" fill="#fff"/>' +
        '<circle cx="290" cy="80" r="26" fill="#d4a853" opacity=".55"/>' +
        '<path d="M200 168c-14-20-8-42 14-54 4 24-2 42-14 54Z" fill="#2d6b4a" opacity=".55"/>' +
        '</svg>'
    );

    // ============================================
    // UTILIDADES
    // ============================================
    const esc = (texto) => String(texto ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const pesos = (valor) => '$' + Math.round(Number(valor) || 0).toLocaleString('es-CO');

    function t(clave, opciones) {
        if (typeof i18next !== 'undefined' && i18next.isInitialized && i18next.exists(clave, opciones)) {
            return i18next.t(clave, opciones);
        }
        return (opciones && opciones.defaultValue) || clave;
    }

    const idioma = () => (window.idiomaActual ? window.idiomaActual() : 'es');

    const fecha = (valor, conHora = false) => new Date(valor).toLocaleDateString(
        idioma() === 'en' ? 'en-US' : 'es-CO',
        conHora
            ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
            : { day: '2-digit', month: 'long', year: 'numeric' }
    );

    function imagen(url) {
        return url && /^https?:\/\//i.test(url) ? url : IMAGEN_RESPALDO;
    }

    function imagenRespaldo(img) {
        img.onerror = null;
        img.src = IMAGEN_RESPALDO;
    }

    // ============================================
    // SESIÓN DEL CLIENTE
    // ============================================
    function sesion() {
        try {
            const usuario = JSON.parse(localStorage.getItem('usuario') || 'null');
            const token = localStorage.getItem('token');
            if (usuario && token) return { usuario, token };
            // Sesiones antiguas (sin token) ya no son válidas
            if (usuario && !token) localStorage.removeItem('usuario');
        } catch { /* datos corruptos: se ignoran */ }
        return null;
    }

    function guardarSesion(usuario, token) {
        localStorage.setItem('usuario', JSON.stringify(usuario));
        localStorage.setItem('token', token);
    }

    function cerrarSesion(redirigir = '/') {
        localStorage.removeItem('usuario');
        localStorage.removeItem('token');
        if (redirigir) window.location.href = redirigir;
    }

    // ============================================
    // PETICIONES A LA API
    // ============================================
    // Devuelve { ok, status, data }. Agrega el token de sesión automáticamente.
    async function api(url, { method = 'GET', body } = {}) {
        const s = sesion();
        const headers = { 'Content-Type': 'application/json' };
        if (s) headers.Authorization = `Bearer ${s.token}`;

        try {
            const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
            const data = await res.json().catch(() => ({}));

            if (res.status === 401 && s) {
                cerrarSesion(null);
                toast(t('comun.sesion_expirada', { defaultValue: 'Tu sesión expiró. Inicia sesión de nuevo.' }), 'error');
            }
            return { ok: res.ok, status: res.status, data };
        } catch (error) {
            console.error('Error de conexión:', error);
            return { ok: false, status: 0, data: { error: t('comun.error_conexion', { defaultValue: 'No hay conexión con el servidor.' }) } };
        }
    }

    // ============================================
    // CARRITO (se guarda en el navegador)
    // ============================================
    // Cada item: { id, nombre, precio, imagen, stock, cantidad }
    // El precio aquí es solo para mostrar: el servidor siempre recalcula el valor real al comprar.
    const carrito = {
        obtener() {
            try {
                const items = JSON.parse(localStorage.getItem('carrito') || '[]');
                return Array.isArray(items) ? items.filter(i => i && i.id && i.cantidad > 0) : [];
            } catch {
                return [];
            }
        },
        guardar(items) {
            localStorage.setItem('carrito', JSON.stringify(items));
            actualizarContador(true);
        },
        agregar(producto, cantidad = 1) {
            const items = carrito.obtener();
            const existente = items.find(i => i.id === producto.id);
            const enCarrito = existente ? existente.cantidad : 0;

            if (enCarrito + cantidad > producto.stock) {
                toast(t('toast.sin_mas_stock', { defaultValue: 'No hay más unidades disponibles', stock: producto.stock }), 'error');
                return false;
            }

            if (existente) {
                existente.cantidad += cantidad;
                Object.assign(existente, { precio: producto.precio_final, stock: producto.stock, imagen: producto.imagen, nombre: producto.nombre });
            } else {
                items.push({
                    id: producto.id, nombre: producto.nombre, precio: producto.precio_final,
                    imagen: producto.imagen, stock: producto.stock, cantidad
                });
            }
            carrito.guardar(items);
            toast(t('toast.agregado', { producto: producto.nombre, defaultValue: `${producto.nombre} agregado al carrito` }));
            return true;
        },
        totalUnidades() {
            return carrito.obtener().reduce((suma, i) => suma + i.cantidad, 0);
        }
    };

    function actualizarContador(animar = false) {
        const contador = document.getElementById('contadorCarrito');
        if (!contador) return;
        const total = carrito.totalUnidades();
        contador.textContent = total > 99 ? '99+' : total;
        contador.classList.toggle('oculto', total === 0);
        if (animar) {
            contador.classList.remove('salto');
            void contador.offsetWidth; // reinicia la animación
            contador.classList.add('salto');
        }
    }

    // ============================================
    // NOTIFICACIONES (toast)
    // ============================================
    function toast(mensaje, tipo = 'exito') {
        let contenedor = document.querySelector('.contenedor-toast');
        if (!contenedor) {
            contenedor = document.createElement('div');
            contenedor.className = 'contenedor-toast';
            contenedor.setAttribute('role', 'status');
            contenedor.setAttribute('aria-live', 'polite');
            document.body.appendChild(contenedor);
        }
        const el = document.createElement('div');
        el.className = `toast ${tipo === 'error' ? 'error' : ''}`;
        el.textContent = (tipo === 'error' ? '⚠️ ' : '✅ ') + mensaje;
        contenedor.appendChild(el);
        setTimeout(() => {
            el.classList.add('saliendo');
            setTimeout(() => el.remove(), 250);
        }, 3200);
    }

    // ============================================
    // ENCABEZADO Y PIE DE PÁGINA
    // ============================================
    function dibujarEncabezado() {
        const lugar = document.getElementById('encabezado');
        if (!lugar) return;

        const pagina = document.body.dataset.pagina || '';
        const s = sesion();
        const enlace = (href, clave, texto, id) =>
            `<a href="${href}" class="nav-enlace ${pagina === id ? 'activo' : ''}" data-i18n="${clave}">${texto}</a>`;

        const zonaUsuario = s
            ? `<div class="menu-usuario">
                   <button class="btn-usuario" id="btnUsuario" aria-haspopup="true" aria-expanded="false">
                       <span class="avatar">${esc(s.usuario.nombres.charAt(0))}</span>
                       <span>${esc(s.usuario.nombres.split(' ')[0])}</span>
                   </button>
                   <div class="desplegable" id="menuUsuario">
                       <a href="/cuenta.html" data-i18n="header.mi_cuenta">👤 Mi cuenta</a>
                       <a href="/cuenta.html#pedidos" data-i18n="header.mis_pedidos">📦 Mis pedidos</a>
                       <div class="separador"></div>
                       <button type="button" id="btnCerrarSesion" data-i18n="header.cerrar">🚪 Cerrar sesión</button>
                   </div>
               </div>`
            : `<a href="/login.html" class="nav-enlace ${pagina === 'login' ? 'activo' : ''}" data-i18n="header.login">Ingresar</a>`;

        lugar.outerHTML = `
            <header class="encabezado">
                <div class="contenedor">
                    <a href="/" class="logo" aria-label="Raíces Andinas">${ICONOS.logo}<b style="font-weight:600">Raíces <span>Andinas</span></b></a>
                    <nav class="nav" id="nav" aria-label="Principal">
                        ${enlace('/', 'header.inicio', 'Inicio', 'inicio')}
                        ${enlace('/#catalogo', 'header.productos', 'Productos', 'catalogo')}
                        ${enlace('/#ofertas', 'header.ofertas', 'Ofertas', 'ofertas')}
                        ${enlace('/#nosotros', 'header.nosotros', 'Nosotros', 'nosotros')}
                        <div class="nav-acciones">
                            <button class="btn-idioma" id="btnIdioma" type="button" aria-label="Cambiar idioma">EN</button>
                            ${zonaUsuario}
                            <a href="/carrito.html" class="btn-carrito" aria-label="Carrito">
                                ${ICONOS.carrito}<span data-i18n="header.carrito">Carrito</span>
                                <span class="contador-carrito oculto" id="contadorCarrito">0</span>
                            </a>
                        </div>
                    </nav>
                    <button class="btn-icono btn-menu-movil" id="btnMenuMovil" aria-label="Abrir menú" aria-expanded="false">${ICONOS.menu}</button>
                </div>
            </header>`;

        document.getElementById('btnIdioma').addEventListener('click', () => window.toggleIdioma && window.toggleIdioma());

        // Menú del celular
        const nav = document.getElementById('nav');
        const btnMenu = document.getElementById('btnMenuMovil');
        btnMenu.addEventListener('click', () => {
            const abierto = nav.classList.toggle('abierto');
            document.body.classList.toggle('menu-abierto', abierto);
            btnMenu.innerHTML = abierto ? ICONOS.cerrar : ICONOS.menu;
            btnMenu.setAttribute('aria-expanded', abierto);
        });
        nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
            nav.classList.remove('abierto');
            document.body.classList.remove('menu-abierto');
            btnMenu.innerHTML = ICONOS.menu;
        }));

        // Menú desplegable del usuario
        if (s) {
            const btnUsuario = document.getElementById('btnUsuario');
            const menu = document.getElementById('menuUsuario');
            btnUsuario.addEventListener('click', (e) => {
                e.stopPropagation();
                const abierto = menu.classList.toggle('abierto');
                btnUsuario.setAttribute('aria-expanded', abierto);
            });
            document.addEventListener('click', () => menu.classList.remove('abierto'));
            document.getElementById('btnCerrarSesion').addEventListener('click', () => {
                if (confirm(t('header.cerrar_confirmacion', { defaultValue: '¿Cerrar sesión?' }))) cerrarSesion('/');
            });
        }

        actualizarContador();
    }

    function dibujarPie() {
        const lugar = document.getElementById('pie');
        if (!lugar) return;

        lugar.outerHTML = `
            <footer class="pie">
                <div class="contenedor">
                    <div class="pie-grid">
                        <div>
                            <a href="/" class="logo">${ICONOS.logo}<b style="font-weight:600">Raíces <span>Andinas</span></b></a>
                            <p data-i18n="footer.descripcion">Productos auténticos de los Andes colombianos, cultivados por comunidades campesinas y llevados hasta tu puerta.</p>
                            <div class="redes">
                                <a href="#" aria-label="Instagram">${ICONOS.instagram}</a>
                                <a href="#" aria-label="Facebook">${ICONOS.facebook}</a>
                                <a href="https://wa.me/573001234567" target="_blank" rel="noopener" aria-label="WhatsApp">${ICONOS.whatsapp}</a>
                            </div>
                        </div>
                        <div>
                            <h4 data-i18n="footer.tienda">Tienda</h4>
                            <ul>
                                <li><a href="/#catalogo" data-i18n="footer.catalogo">Catálogo</a></li>
                                <li><a href="/#ofertas" data-i18n="footer.ofertas">Ofertas</a></li>
                                <li><a href="/carrito.html" data-i18n="footer.carrito">Mi carrito</a></li>
                                <li><a href="/cuenta.html" data-i18n="footer.cuenta">Mi cuenta</a></li>
                            </ul>
                        </div>
                        <div>
                            <h4 data-i18n="footer.ayuda">Ayuda</h4>
                            <ul>
                                <li><span data-i18n="footer.envios">Envío gratis desde $80.000</span></li>
                                <li><span data-i18n="footer.devoluciones">Devoluciones hasta 30 días</span></li>
                                <li><a href="#" id="pieAbrirChat" data-i18n="footer.asistente">Habla con el asistente</a></li>
                                <li><a href="/olvide.html" data-i18n="footer.recuperar">Recuperar contraseña</a></li>
                            </ul>
                        </div>
                        <div>
                            <h4 data-i18n="footer.contacto">Contacto</h4>
                            <ul class="pie-contacto">
                                <li>📧 <a href="mailto:soporte@raicesandinas.com">soporte@raicesandinas.com</a></li>
                                <li>📱 +57 300 123 4567</li>
                                <li>🕗 <span data-i18n="footer.horario">Lun a Vie 8 a. m. – 6 p. m. · Sáb 9 a. m. – 1 p. m.</span></li>
                                <li>📍 Bucaramanga, Colombia</li>
                            </ul>
                        </div>
                    </div>
                    <div class="pie-inferior">
                        <span data-i18n="footer.derechos">© 2026 Raíces Andinas. Todos los derechos reservados.</span>
                        <a href="/admin.html" data-i18n="footer.admin">Acceso administradores</a>
                    </div>
                </div>
            </footer>`;

        document.getElementById('pieAbrirChat').addEventListener('click', (e) => {
            e.preventDefault();
            document.dispatchEvent(new CustomEvent('abrirChat'));
        });
    }

    // Botón "ojo" para ver/ocultar contraseñas (campos dentro de .campo-password)
    function activarVerPassword(raiz = document) {
        raiz.querySelectorAll('.campo-password').forEach(campo => {
            if (campo.querySelector('.ver-password')) return;
            const input = campo.querySelector('input');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ver-password';
            btn.setAttribute('aria-label', 'Mostrar contraseña');
            btn.innerHTML = ICONOS.ojo;
            btn.addEventListener('click', () => {
                input.type = input.type === 'password' ? 'text' : 'password';
            });
            campo.appendChild(btn);
        });
    }

    // Ejecuta "dibujar" cuando las traducciones están listas y cada vez que cambia el idioma
    function alListo(dibujar) {
        window.i18nListo.then(() => {
            dibujar();
            document.addEventListener('idiomaCambiado', dibujar);
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        dibujarEncabezado();
        dibujarPie();
        activarVerPassword();
        // El carrito puede cambiar en otra pestaña
        window.addEventListener('storage', (e) => { if (e.key === 'carrito') actualizarContador(); });
    });

    window.RA = {
        ICONOS, esc, pesos, t, idioma, fecha, imagen, imagenRespaldo,
        sesion, guardarSesion, cerrarSesion, api, carrito, toast, alListo, activarVerPassword
    };
})();
