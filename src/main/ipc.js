const { app, ipcMain, desktopCapturer, shell } = require('electron')
const { log, LOG_DIR, LOG_FILE } = require('./logger.js')

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

/* ═══════════════════════════════════════════════════════════════
   ACESSO AO LOG PELA PRÓPRIA APLICAÇÃO
   Em build empacotada o caminho do log muda (app.getName() passa a ser
   "ShareSync", não o name do package.json), então não adianta decorar um
   caminho — quem sabe onde está é o app. Estes dois handlers são o que
   torna possível investigar um problema de usuário sem pedir pra ele
   caçar pasta escondida no AppData.
═══════════════════════════════════════════════════════════════ */
ipcMain.handle('get-log-path', () => LOG_FILE)

ipcMain.handle('open-logs', async () => {
  // showItemInFolder abre a pasta JÁ com o arquivo selecionado — melhor que
  // openPath(LOG_FILE), que tentaria abrir o .log no programa associado (às
  // vezes nenhum) em vez de mostrar onde ele está.
  try {
    shell.showItemInFolder(LOG_FILE)
    return true
  } catch (err) {
    log('WARN', `Falha ao abrir a pasta de logs: ${err.message}`)
    // Reserva: abre a pasta, mesmo sem selecionar o arquivo.
    await shell.openPath(LOG_DIR)
    return false
  }
})

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
