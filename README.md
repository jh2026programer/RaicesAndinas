# RaicesAndinas
Sistema de información empresarial para la comercialización de productos andinos

Tienda en Node.js + Express + MySQL con panel de administración, chatbot con IA y un **motor de automatización propio en código** (tercer corte: ya no depende de n8n).

## Instalación

1. Instala [Node.js 24](https://nodejs.org) y enciende MySQL (por ejemplo, con XAMPP).
2. Crea la base de datos `raices_andinas` e importa `database/raices_andinas.sql`.
3. Copia `.env.example` como `.env` y completa los valores.
4. Instala y arranca:

```bash
npm install
```

```bash
npm start
```

La tienda queda en http://localhost:3000 y el panel en http://localhost:3000/admin.html. Las tablas nuevas se crean solas al iniciar.

## Claves de los servicios

Todas van en el `.env`, nunca en el código. Sin ellas la tienda funciona igual: el envío queda como "omitido" en la bitácora y el chatbot responde con sus reglas.

| Variable | Para qué | Dónde se obtiene (gratis) |
| --- | --- | --- |
| `GMAIL_APP_PASSWORD` | Enviar correos | myaccount.google.com/apppasswords |
| `TELEGRAM_BOT_TOKEN` | Alertas al equipo | @BotFather en Telegram |
| `GEMINI_API_KEY` | IA principal | aistudio.google.com/apikey |
| `GROQ_API_KEY` | Plan B de la IA | console.groq.com/keys |
| `OLLAMA_URL` | Plan B sin internet (opcional) | ollama.com |

## Motor de automatización

```
La tienda emite un evento ─▶ Motor ─▶ Flujo de la central ─▶ Gmail / Telegram / IA
Hora programada (cron)   ─▶   │
Cola en la base de datos ─▶   └─▶ Bitácora de cada ejecución (panel admin → Automatizaciones)
```

| Central | Archivo | Qué hace |
| --- | --- | --- |
| C01 Pedidos y Clientes | `servicios/automatizacion/pedidos.js` | Bienvenida, pedido con clasificación del cliente, estados, cancelación, encuesta y seguimiento |
| C02 Inventario | `servicios/automatizacion/inventario.js` | Stock bajo, cantidad sugerida, orden con IA y aprobación del dueño por enlace firmado |
| C03 Atención al Cliente | `servicios/automatizacion/atencion.js` | Chatbot con IA, asesor humano, calificación baja y recuperación de contraseña |
| C04 Reportes | `servicios/automatizacion/reportes.js` | Resumen diario, cierre del día, analista semanal con IA y reporte mensual |
| C05 Monitoreo | `servicios/automatizacion/monitoreo.js` | Diagnóstico de errores, gravedad y aviso con la solución |

- **Reintentos:** cada paso externo se intenta hasta 3 veces (1 s, 2 s). Si el problema es temporal, el flujo vuelve a la cola a los 5, 15 y 45 minutos, sin repetir lo que ya se hizo.
- **Esperas largas:** la encuesta y el vencimiento de compras viven en la base de datos y sobreviven a un reinicio.
- **Datos personales (Ley 1581):** la bitácora enmascara correos, teléfonos y nombres y oculta direcciones y enlaces. Lo que sale hacia la IA se anonimiza. Los registros técnicos se borran a los 90 días y la auditoría de IA a los 180.

## IA (LangChain)

`servicios/ia/` prueba varios modelos de Gemini; si fallan o se agota la cuota pasa a los de Groq, luego a Ollama si está configurado, y por último a las reglas de la tienda. Cada modelo tiene 12 s para responder, el total nunca pasa de 25 s, y un modelo saturado descansa unos segundos para no hacer esperar al siguiente cliente. Cada intento queda en la auditoría (`ia_auditoria`). Los modelos gratuitos cambian con el tiempo: `npm run ia:probar` muestra cuáles responden hoy y `GEMINI_MODELOS` / `GROQ_MODELOS` en el `.env` permiten cambiarlos sin tocar el código. El chatbot tiene memoria (la conversación guardada) y herramientas de solo lectura: buscar productos y consultar los pedidos del propio cliente.

## Módulo de visión: facturas de proveedor

En el panel admin, **Facturas** permite tomar una foto con el celular o subir JPG, PNG, WEBP o PDF.

```
Foto ─▶ OCR local (Tesseract) tapa datos personales ─▶ Gemini Vision devuelve JSON con confianza
     ─▶ Reglas: cuentas, NIT, fecha y catálogo ─▶ Revisión de una persona ─▶ Confirmada
```

- **Quién decide:** la IA propone. Si la confianza es alta y no hay ninguna alerta, la factura se confirma sola y actualiza el inventario (se puede desactivar con `FACTURAS_AUTOCONFIRMAR=false`); si no, una persona la revisa. Las reglas no confían en la IA: si las cuentas no dan, si el NIT no valida o si un dato tiene confianza menor a 85 %, la factura queda "Por revisar" con los campos dudosos resaltados.
- **Datos personales:** cédulas, teléfonos, correos, direcciones y nombres de empleados se tapan antes de salir del servidor; la pestaña "Lo que vio la IA" lo muestra. Si la foto es tan mala que el OCR no puede leerla, no se envía a nadie.
- **Limitación conocida:** el nombre del proveedor y su NIT sí se envían porque son el dato que el proceso necesita, incluso si el proveedor es una persona natural. Para no enviar nada a internet se puede configurar visión local con `OLLAMA_VISION_MODELO`.
- **Almacenamiento:** las imágenes quedan en `uploads/facturas/`, fuera de la carpeta pública, y solo se entregan con sesión de administrador. Se registra quién subió cada una y cuándo. Rechazar una factura borra su imagen.
- **Plan B:** varios modelos de visión → Ollama local (opcional) → texto del OCR con un modelo de lenguaje (confianza limitada a 70 %, siempre con revisión) → reintento automático desde la cola.

### De la factura al inventario

Al confirmar una factura se emite el evento `factura.confirmada` y el motor ejecuta el flujo **C06**, todo o nada: registra la compra (`compras`), ajusta el stock, concilia las solicitudes de compra y avisa por Telegram.

- **Sin duplicar stock:** aprobar una solicitud ya suma el stock, así que cuando llega su factura solo se ajusta la diferencia. Una misma factura nunca se registra dos veces.
- **Productos:** cada línea se enlaza al catálogo y el administrador puede cambiarla. Lo que "no es del catálogo" queda en la compra, pero no mueve stock.
- **Canales de captura:** cámara del celular, archivos o el botón 📷 del chatbot, visible solo con sesión de administrador.

### Medir la precisión

```bash
npm run facturas:generar
```

Imprime `pruebas-facturas/facturas-para-imprimir.pdf`, fotografía cada hoja y guarda las fotos en `pruebas-facturas/fotos/` como `F01.jpg`, `F02.jpg`, etc. Luego:

```bash
npm run facturas:evaluar
```

El resultado queda en `pruebas-facturas/resultados.md`.

## Seguridad

Roles y sesiones firmadas, límites de intentos por IP en inicio de sesión, registro y chat, encabezados de seguridad, API cerrada a otros sitios y claves solo en variables de entorno. Para publicar en internet, ver [DESPLIEGUE.md](DESPLIEGUE.md).

## Pruebas

```bash
npm test
```

## Volver a n8n

Mientras dura la migración, `AUTOMATIZACIONES=n8n` en el `.env` vuelve a los flujos de n8n (ver `automatizaciones/README.md`).
