# Automatizaciones de Raíces Andinas (n8n)

> **Tercer corte:** las automatizaciones ya corren en el motor en código (`servicios/automatizacion/`, ver el `README.md` principal). Esta carpeta se conserva como especificación de los flujos y como respaldo con `AUTOMATIZACIONES=n8n`.

## Cómo funciona

```
Tienda (server.js) ──webhook──▶ n8n ──▶ Correo (Gmail SMTP) / Telegram / IA (Gemini)
        ▲                        │
        └──── API + x-api-key ───┘  (flujos programados: resumen diario, reporte mensual)
```

- **Eventos**: cuando pasa algo en la tienda, `server.js` llama a `notificarN8n(evento, datos)`, que hace un
  POST a `N8N_WEBHOOK_URL/<evento>`. Si n8n está apagado, la tienda sigue funcionando.
- **Programados**: n8n consulta la API admin enviando el header `x-api-key` (`AUTOMATION_API_KEY` del `.env`).
- **Chatbot con IA**: el servidor llama a `/webhook/chatbot-ia` y **espera** la respuesta (`consultarIA`).
  Si la IA no responde en 25 s, el chatbot usa sus reglas (menú) como respaldo.
- **Datos sensibles** (EPS, condiciones de salud) **nunca** se envían a n8n.

## Versión actual: 5 centrales de automatización (`npm run n8n:centrales`)

Las 13 automatizaciones se agruparon en 5 flujos grandes, uno por área del negocio, y se agregaron
capacidades avanzadas: clasificación de clientes, bucles, aprobación humana, escritura en la tienda,
analista de IA y monitoreo de errores con reintentos.

| Central | Disparadores | Qué hace |
|---|---|---|
| 🛒 C01 Pedidos y Clientes (48 cajas) | 6 webhooks | Bienvenida; pedido con **clasificación nuevo/recurrente/VIP** y prioridad para pedidos grandes; correo por estado; cancelaciones (detecta tardías); encuesta solo si no ha calificado; seguimiento según la nota |
| 📦 C02 Inventario (24 cajas) | webhook `stock-bajo` | **Bucle** por producto con ventas de 30 días → cantidad sugerida → orden redactada con **IA** → correo con **[Aprobar] [Rechazar]** → **espera** la decisión (24 h) → si aprueba, **suma el stock en la tienda** y envía la orden al proveedor |
| 💬 C03 Atención al Cliente (24 cajas) | 4 webhooks | Chatbot IA con respaldo; asesor (con o sin cuenta, + correo de confirmación); calificación baja; recuperar contraseña |
| 📊 C04 Reportes e Inteligencia (30 cajas) | 4 horarios | Resumen diario (solo si hay algo); cierre del día; **analista semanal**: 3 consultas en paralelo → Merge → indicadores → IA → informe + alerta urgente; reporte mensual |
| 🛡️ C05 Monitoreo de Errores (10 cajas) | Error Trigger | Si cualquier central falla: diagnostica la causa, decide la gravedad y avisa con la solución |

Al instalar las centrales, los 13 flujos individuales quedan **apagados** (no se borran).
Para volver a ellos: despublicar las centrales en n8n y ejecutar `npm run n8n:instalar`.

## Versión anterior: 13 flujos individuales (`npm run n8n:instalar`)

| Flujo | Disparador | Acción |
|---|---|---|
| 01 Pedido creado | webhook `pedido-creado` | Correo de confirmación al cliente + Telegram al admin |
| 02 Estado del pedido | webhook `pedido-estado` | Correo al cliente (confirmado / enviado / entregado / cancelado) |
| 03 Resumen diario | todos los días 8:00 am | Telegram con stock bajo y pedidos pendientes > 48 h |
| 04 Atención al cliente | webhooks `chat-asesor`, `calificacion-baja` | Telegram cuando piden asesor o califican con 1-2 ⭐ |
| 05 Reporte mensual | día 1 de cada mes, 7:00 am | Correo al admin con ventas, chatbot y encuestas |
| 06 Bienvenida | webhook `usuario-registrado` | Correo de bienvenida al nuevo cliente |
| 07 Stock inmediato | webhook `stock-bajo` | Telegram apenas una venta deja un producto en su mínimo |
| 08 Encuesta post-entrega | webhook `pedido-entregado` → **Wait** | Espera `ENCUESTA_ESPERA_MINUTOS` y envía la encuesta por correo |
| 09 Chatbot con IA | webhook `chatbot-ia` (responde) | Gemini contesta preguntas libres con el catálogo real |
| 10 Restablecer contraseña | webhook `password-reset` | Correo con enlace seguro (vence en 30 min, un solo uso) |
| 11 Seguimiento de encuesta | webhook `encuesta-respondida` | 1-2 ⭐: correo de disculpa + Telegram al equipo · 3-5 ⭐: correo de agradecimiento |
| 12 Cierre del día | todos los días 8:00 pm | Telegram con ventas del día, comparación con ayer y lo más vendido |
| 13 Pedido cancelado | webhook `pedido-cancelado` | Telegram al admin con el stock devuelto |

## Credenciales necesarias en n8n (nombres EXACTOS)

| Tipo | Nombre | Datos |
|---|---|---|
| SMTP | `Gmail Raices Andinas` | Gmail + contraseña de aplicación, `smtp.gmail.com`, puerto 465, SSL/TLS |
| Telegram API | `Telegram Raices Andinas` | Token de @BotFather |
| Google Gemini(PaLM) Api | `Gemini Raices Andinas` | API key gratis de https://aistudio.google.com/apikey |

## Instalar / actualizar los flujos

1. Completar el `.env` (correo, chat de Telegram, etc.).
2. **Cerrar n8n** y ejecutar:
   ```
   npm run n8n:instalar
   ```
   Genera los 10 flujos, los importa, los enlaza con las credenciales (por nombre) y los publica.
   Para omitir alguno: `npm run n8n:instalar -- --omitir=09`.
3. Volver a abrir n8n (`iniciar-n8n.bat`).

## Pruebas

| Prueba | Resultado esperado |
|---|---|
| Registrarse en `/registro.html` | Correo de bienvenida |
| Comprar algo desde el carrito | Correo de confirmación + Telegram "NUEVO PEDIDO" |
| Comprar las unidades que dejan un producto en su stock mínimo | Telegram "ALERTA DE STOCK" |
| En el panel admin cambiar el pedido a *Enviado* | Correo "Tu pedido va en camino" |
| Cambiarlo a *Entregado* | Correo de estado + (tras la espera) correo con la encuesta |
| Chatbot: escribir `6` / calificar con 1 ⭐ | Telegram al equipo |
| Chatbot: una pregunta libre ("¿qué me recomiendas para regalar?") | Respuesta de la IA con "✨ Respuesta generada con IA" |
| `/olvide.html` con tu correo | Correo con el enlace para crear una nueva contraseña |
| Flujos 03 y 05: botón *Execute workflow* | Telegram / correo inmediato |

Si algo falla: en n8n, pestaña **Executions**, se ve cada ejecución nodo por nodo con el error.
En la consola de la tienda aparece `🔔 n8n [evento] → 200` (o el error) cada vez que se envía un evento.
