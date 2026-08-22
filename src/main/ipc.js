const { app, ipcMain, desktopCapturer } = require('electron')
const { log } = require('./logger.js')

/* ═══════════════════════════════════════════════════════════════
   IPC diverso — log do renderer, versão do app e lista de fontes de
   captura. Controles de janela (minimizar/maximizar/fechar) ficam em
   window.js, junto da criação da BrowserWindow; atualização em updater.js.
═══════════════════════════════════════════════════════════════ */

// Permite que o renderer também grave eventos no log básico do app
// (entrar em sala, iniciar/parar compartilhamento, erros, etc.)
ipcMain.on('renderer-log', (_e, level, message) => log(level, `[renderer] ${message}`))

// Versão exibida no canto inferior esquerdo (ver js/titlebar.js)
ipcMain.handle('get-app-version', () => app.getVersion())

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
  })
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }))
})
