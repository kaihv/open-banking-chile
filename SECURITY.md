# Seguridad

## Principios

Este proyecto maneja credenciales bancarias. La seguridad no es negociable.

### 1. Todo corre local
- **NUNCA** se envían credenciales ni datos a servidores externos
- El scraper solo se comunica con el portal oficial del banco
- No hay analytics, telemetría, ni tracking de ningún tipo
- Chrome corre con sandbox activo salvo cuando Node corre como root; en ese caso se usan flags `--no-sandbox` porque Chrome lo exige, pero se recomienda correr como usuario no-root.

### 2. Credenciales en memoria, nunca en disco
- Las credenciales se pasan via variables de entorno o parámetros
- Nunca se escriben a archivos, logs, ni base de datos
- El proceso termina y las credenciales desaparecen

### 3. Screenshots pueden contener datos sensibles
- El flag `--screenshots` guarda imágenes de la sesión bancaria
- Estas imágenes pueden contener: saldos, movimientos, nombre del titular
- **NUNCA** subas screenshots a repositorios públicos
- La carpeta `screenshots/` está en `.gitignore` por esta razón

## Para contribuidores

### NO hacer
- Agregar envío de datos a servidores externos
- Loggear credenciales (ni siquiera en modo debug)
- Guardar cookies de sesión bancaria en disco
- Intentar bypassear mecanismos de seguridad del banco (2FA, captchas)
- Incluir credenciales reales en tests o ejemplos

### SÍ hacer
- Retornar error claro si el banco pide 2FA
- Usar `puppeteer-core` (no `puppeteer`) para que el usuario controle su propio Chrome
- Cerrar el browser siempre en el `finally` block
- Documentar claramente qué datos se extraen

## Reportar vulnerabilidades

Si encuentras una vulnerabilidad de seguridad, **no abras un issue público**.

Envía un email a: kai@makana.cl

Responderemos dentro de 48 horas.

## Limitaciones conocidas

- **2FA**: Si tu banco pide clave dinámica, el scraper no puede proceder. Esto es intencional — no intentamos bypassear seguridad bancaria.
- **Sesiones**: No persistimos sesiones. Cada ejecución hace login completo.
- **Rate limiting**: Si ejecutas el scraper muchas veces seguidas, el banco puede bloquear tu cuenta temporalmente. Recomendamos máximo 1 ejecución por hora.
- **Chrome como root**: En Docker/CI root, Chrome puede necesitar `--no-sandbox`. Es compatible, pero menos aislado que correr el proceso con un usuario no-root.
