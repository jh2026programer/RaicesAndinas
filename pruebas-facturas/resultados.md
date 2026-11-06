# Resultados del módulo de visión

Fotos evaluadas: **20** (carpeta de fotos). Fecha: 2026-11-06.

**Cómo se tomaron las imágenes:** fotos tomadas con celular a la pantalla del computador donde se mostraba cada factura (no a una hoja impresa).

## Aciertos por campo

| Campo | Aciertos | Porcentaje |
| --- | --- | --- |
| proveedor | 20/20 | 100.0 % |
| nit | 11/20 | 55.0 % |
| numero | 19/20 | 95.0 % |
| fecha | 18/20 | 90.0 % |
| subtotal | 20/20 | 100.0 % |
| iva | 20/20 | 100.0 % |
| total | 20/20 | 100.0 % |
| productos (línea completa) | 69/70 | 98.6 % |
| **Total de campos** | **197/210** | **93.8 %** |

## Decisión del sistema

- Listas para confirmar: 4
- Enviadas a revisión humana: 16
- Rechazadas por ilegibles: 0
- Con error: 0
- Marcadas "lista" que tenían algún error: 0 de 4

## Protección de datos personales

Datos personales impresos: 74. El OCR todavía los lee en la imagen enviada a la IA: 0.

> Este conteo es solo un límite inferior: en fotos malas el OCR no lee datos que una persona sí puede leer. La medida válida es revisar a ojo las imágenes tapadas.

### Revisión a ojo de las imágenes tapadas

Revisión manual de las 20 imágenes tal como salen hacia la IA, porque el OCR no puede medirse a sí mismo:

- De las 4 cédulas impresas (facturas de persona natural), 1 quedó completa a la vista (F20, letra clara sobre fondo oscuro) y 2 parcialmente (F10 y F15). Teléfonos, correos, direcciones y vendedores quedaron tapados.
- Exceso de protección: en varias facturas también se tapó el NIT, lo que explica su porcentaje bajo. En esos casos la factura pasa a revisión y una persona lo escribe.
- Límite conocido: el OCR local no puede garantizar tapar todo en fotos de pantalla. La única garantía total es usar un modelo de visión local (Ollama). Todos los datos de esta prueba son ficticios.

## Detalle

| Factura | Decisión | Confianza | Modelo | Tiempo | Fallos |
| --- | --- | --- | --- | --- | --- |
| F01 | por_revisar | 1 | gemini-3.5-flash-lite (imagen) | 17.6 s | nit |
| F02 | por_revisar | 0.95 | gemini-3.5-flash-lite (imagen) | 13.8 s | nit |
| F03 | lista | 1 | gemini-3.5-flash-lite (imagen) | 19.0 s | todo correcto |
| F04 | lista | 1 | gemini-3.5-flash-lite (imagen) | 21.1 s | todo correcto |
| F05 | por_revisar | 0.95 | gemini-3.5-flash-lite (imagen) | 16.9 s | todo correcto |
| F06 | por_revisar | 1 | gemini-3.5-flash-lite (imagen) | 16.8 s | nit |
| F07 | por_revisar | 0.95 | gemini-3.5-flash-lite (imagen) | 14.3 s | nit |
| F08 | lista | 0.99 | gemini-3.5-flash-lite (imagen) | 11.6 s | todo correcto |
| F09 | por_revisar | 0.95 | gemini-3.5-flash-lite (imagen) | 14.3 s | nit |
| F10 | por_revisar | 0 | gemini-3.5-flash-lite (imagen) | 13.4 s | numero, fecha |
| F11 | por_revisar | 0.95 | gemini-3.5-flash-lite (imagen) | 17.7 s | nit |
| F12 | lista | 1 | gemini-3.5-flash-lite (imagen) | 13.1 s | todo correcto |
| F13 | por_revisar | 0.4 | gemini-3.5-flash-lite (imagen) | 16.1 s | nit |
| F14 | por_revisar | 1 | gemini-3.1-flash-lite (imagen) | 37.7 s | todo correcto |
| F15 | por_revisar | 0.95 | gemini-3.5-flash-lite (imagen) | 20.8 s | todo correcto |
| F16 | por_revisar | 0 | gemini-3.5-flash-lite (imagen) | 20.2 s | productos 4/5 |
| F17 | por_revisar | 0.95 | gemini-3.5-flash-lite (imagen) | 16.6 s | nit |
| F18 | por_revisar | 0.9 | gemini-3.5-flash-lite (imagen) | 13.4 s | nit |
| F19 | por_revisar | 0 | gemini-3.5-flash-lite (imagen) | 23.5 s | fecha |
| F20 | por_revisar | 0.95 | gemini-3.5-flash-lite (imagen) | 22.2 s | todo correcto |
