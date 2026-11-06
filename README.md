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

`servicios/ia/` usa Gemini; si falla o se agota la cuota pasa a Groq, luego a Ollama si está configurado, y por último a las reglas de la tienda. Cada intento queda en la auditoría (`ia_auditoria`). El chatbot tiene memoria (la conversación guardada) y herramientas de solo lectura: buscar productos y consultar los pedidos del propio cliente.

## Pruebas

```bash
npm test
```

## Volver a n8n

Mientras dura la migración, `AUTOMATIZACIONES=n8n` en el `.env` vuelve a los flujos de n8n (ver `automatizaciones/README.md`).
