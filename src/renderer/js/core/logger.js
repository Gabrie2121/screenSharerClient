/* ═══════════════════════════════════════════════════════════════
   LOG BÁSICO — imprime no console e grava no arquivo de log do app
   (via processo principal, ver src/main/logger.js).
═══════════════════════════════════════════════════════════════ */
export function appLog(level, message) {
  console.log(`[${level}] ${message}`)
  window.electronAPI?.log(level, message)
}
