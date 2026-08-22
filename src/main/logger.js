const { app } = require('electron')
const path = require('path')
const fs = require('fs')

/* ═══════════════════════════════════════════════════════════════
   LOG BÁSICO (processo principal)
   Grava eventos do app em disco para facilitar suporte/depuração.
═══════════════════════════════════════════════════════════════ */
const LOG_DIR = path.join(app.getPath('userData'), 'logs')
const LOG_FILE = path.join(LOG_DIR, 'main.log')

function log(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}`
  console.log(line)
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch (err) {
    console.error('Falha ao gravar log:', err)
  }
}

module.exports = { log }
