// public/js/main.js
// Traducción en tiempo real (español / inglés) con i18next.
// Los textos fijos usan atributos en el HTML:
//   data-i18n="clave"              → reemplaza el texto
//   data-i18n-html="clave"         → reemplaza el HTML (solo textos propios, nunca de usuarios)
//   data-i18n-placeholder="clave"  → reemplaza el placeholder de un campo
//   data-i18n-attr="atributo:clave"→ reemplaza un atributo (ej. aria-label:clave)

window.i18nListo = new Promise(resolve => {
    document.addEventListener('DOMContentLoaded', () => {
        if (typeof i18next === 'undefined') {
            console.warn('⚠️ i18next no cargó (¿sin internet?). Se muestran los textos en español.');
            resolve();
            return;
        }

        i18next
            .use(i18nextHttpBackend)
            .use(i18nextBrowserLanguageDetector)
            .init({
                fallbackLng: 'es',
                supportedLngs: ['es', 'en'],
                load: 'languageOnly',
                backend: { loadPath: '/locales/{{lng}}/translation.json' },
                detection: { order: ['localStorage', 'navigator'], caches: ['localStorage'] },
                interpolation: { escapeValue: false }
            }, (err) => {
                if (err) console.error('Error i18next:', err);
                actualizarTraducciones();
                resolve();
            });
    });
});

function idiomaActual() {
    return (typeof i18next !== 'undefined' && i18next.resolvedLanguage) || 'es';
}

function actualizarTraducciones(raiz = document) {
    if (typeof i18next === 'undefined' || !i18next.isInitialized) return;

    raiz.querySelectorAll('[data-i18n]').forEach(el => {
        const opciones = el.dataset.i18nOptions ? JSON.parse(el.dataset.i18nOptions) : {};
        el.textContent = i18next.t(el.dataset.i18n, opciones);
    });
    raiz.querySelectorAll('[data-i18n-html]').forEach(el => {
        el.innerHTML = i18next.t(el.dataset.i18nHtml);
    });
    raiz.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.placeholder = i18next.t(el.dataset.i18nPlaceholder);
    });
    raiz.querySelectorAll('[data-i18n-attr]').forEach(el => {
        const [atributo, clave] = el.dataset.i18nAttr.split(':');
        el.setAttribute(atributo, i18next.t(clave));
    });

    document.documentElement.lang = idiomaActual();
    const btn = document.getElementById('btnIdioma');
    if (btn) btn.textContent = idiomaActual() === 'es' ? 'EN' : 'ES';

    // Avisar a las páginas para que vuelvan a dibujar su contenido dinámico
    document.dispatchEvent(new CustomEvent('idiomaCambiado', { detail: { idioma: idiomaActual() } }));
}

function cambiarIdioma(idioma) {
    if (typeof i18next === 'undefined') return;
    i18next.changeLanguage(idioma, () => actualizarTraducciones());
}

function toggleIdioma() {
    cambiarIdioma(idiomaActual() === 'es' ? 'en' : 'es');
}

window.idiomaActual = idiomaActual;
window.actualizarTraducciones = actualizarTraducciones;
window.cambiarIdioma = cambiarIdioma;
window.toggleIdioma = toggleIdioma;
