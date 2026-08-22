const { app, BrowserWindow } = require('electron')
const { log } = require('./main/logger.js')
const { createWindow, getMainWindow, setQuitting } = require('./main/window.js')
const { createTray } = require('./main/tray.js')
require('./main/updater.js')
require('./main/ipc.js')

/* ═══════════════════════════════════════════════════════════════
   ShareSync — processo principal (entry point)
   Composition root: liga o ciclo de vida do app aos módulos de src/main/
   (logger, updater, window, tray, ipc — cada um documentado no próprio
   arquivo). Ver src/renderer/js/main.js pro equivalente do lado do renderer.
═══════════════════════════════════════════════════════════════ */
app.whenReady().then(() => {
  log('INFO', '🚀 App iniciado')
  createWindow()
  createTray()
})

// Fecha a janela (X) só esconde pra bandeja agora (ver window.on('close')
// em src/main/window.js) — window-all-closed só dispara mesmo num "Sair" de verdade.
app.on('window-all-closed', () => {
  log('INFO', '🛑 Todas as janelas fechadas')
  if (process.platform !== 'darwin') app.quit()
})

// Cobre outros jeitos de sair (Cmd+Q no mac, app.quit() chamado de fora do
// menu da bandeja) — sem isso, esses caminhos cairiam no close handler e
// só esconderiam a janela em vez de encerrar de verdade.
app.on('before-quit', () => setQuitting(true))

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
  else getMainWindow()?.show()
})
