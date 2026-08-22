const { app, ipcMain } = require('electron')
const { autoUpdater } = require('electron-updater')
const { log } = require('./logger.js')

/* ═══════════════════════════════════════════════════════════════
   AUTO-UPDATE
   Verifica o GitHub Releases (config em package.json → build.publish) e
   avisa o renderer, que mostra o botão de atualização no canto inferior
   esquerdo da sidebar (ver js/titlebar.js). O download/instalação só
   rodam quando a pessoa clica.

   `getMainWindow` é importado sob demanda (dentro de cada callback, não
   no topo do arquivo) de propósito: window.js importa este módulo pra
   disparar checkForUpdates() ao carregar a janela, e se este arquivo
   importasse window.js no topo também, teríamos um require circular —
   nesse ponto o require() de um dos dois ainda estaria no meio da
   execução do outro e devolveria um module.exports incompleto. Adiando o
   require pra dentro dos callbacks (que só rodam bem depois de todo o app
   já ter carregado) evita isso.
═══════════════════════════════════════════════════════════════ */
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false
autoUpdater.logger = {
  info:  (msg) => log('INFO', `[updater] ${msg}`),
  warn:  (msg) => log('WARN', `[updater] ${msg}`),
  error: (msg) => log('ERROR', `[updater] ${msg}`),
}

// Canal de atualização — normal (latest.yml) por padrão. Se a versão desse
// build for um prerelease semver (ex.: "0.2.0-dev.3"), essa instância entra
// no canal "dev" (dev.yml): só recebe futuras builds também "-dev", nunca
// aparece pra quem instalou uma versão estável normal, e vice-versa — os
// dois canais não se enxergam. É assim que dá pra ter builds de teste sem
// afetar quem já está usando o app (ver context.MD).
const versionChannel = app.getVersion().split('-')[1]?.split('.')[0]
if (versionChannel) {
  autoUpdater.channel = versionChannel
  autoUpdater.allowPrerelease = true
  log('INFO', `Canal de atualização: "${versionChannel}" (build ${app.getVersion()})`)
}

autoUpdater.on('update-available', (info) => {
  pendingManualCheck = false
  log('INFO', `Atualização disponível: v${info.version}`)
  require('./window.js').getMainWindow()?.webContents.send('update-available', { version: info.version })
})

// Verificação automática no início fica silenciosa se não achar nada (senão
// toda abertura do app mostraria um aviso à toa); já uma checagem manual
// (clique no badge de versão) precisa de retorno pra pessoa saber que
// rodou e não achou nada — ver `pendingManualCheck`.
let pendingManualCheck = false

autoUpdater.on('update-not-available', () => {
  log('INFO', 'Nenhuma atualização disponível')
  if (pendingManualCheck) {
    pendingManualCheck = false
    require('./window.js').getMainWindow()?.webContents.send('update-not-available')
  }
})

autoUpdater.on('download-progress', (progress) => {
  require('./window.js').getMainWindow()?.webContents.send('update-download-progress', {
    percent: Math.round(progress.percent),
  })
})

autoUpdater.on('update-downloaded', () => {
  log('INFO', 'Atualização baixada — aguardando confirmação do usuário para reiniciar')
  require('./window.js').getMainWindow()?.webContents.send('update-ready')
})

autoUpdater.on('error', (err) => {
  pendingManualCheck = false
  log('ERROR', `Falha no auto-update: ${err.message}`)
  require('./window.js').getMainWindow()?.webContents.send('update-error', { message: err.message })
})

ipcMain.on('update-start', () => {
  log('INFO', 'Usuário iniciou o download da atualização')
  autoUpdater.downloadUpdate()
})

// Só instala e reinicia quando a pessoa confirma — evita derrubar uma
// sessão de compartilhamento em andamento sem aviso (ver 'update-ready' acima).
// quitAndInstall(isSilent, isForceRunAfter): sem os argumentos, o Windows
// abre o instalador NSIS completo (escolher pasta, Next, Instalar, Concluir)
// toda vez que atualiza — exatamente o assistente que só faz sentido na
// primeira instalação. Com isSilent=true ele roda com a flag /S do NSIS
// (sem nenhuma UI, só substitui os arquivos) e isForceRunAfter=true garante
// que o app reabre sozinho depois — no modo silencioso isso não é automático.
ipcMain.on('update-install', () => {
  log('INFO', 'Usuário confirmou — instalando atualização (silenciosa) e reiniciando')
  autoUpdater.quitAndInstall(true, true)
})

function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    log('INFO', 'Auto-update ignorado (app rodando em modo dev, não empacotado)')
    if (manual) {
      require('./window.js').getMainWindow()?.webContents.send('update-error', {
        message: 'Checagem de atualização não disponível em modo de desenvolvimento.',
      })
    }
    return
  }
  if (manual) pendingManualCheck = true
  autoUpdater.checkForUpdates().catch((err) => {
    log('ERROR', `Falha ao verificar atualizações: ${err.message}`)
  })
}

// Verificação manual disparada pelo clique no badge de versão (ver js/titlebar.js)
ipcMain.on('check-for-updates', () => {
  log('INFO', 'Usuário pediu verificação manual de atualização')
  checkForUpdates(true)
})

module.exports = { checkForUpdates }
