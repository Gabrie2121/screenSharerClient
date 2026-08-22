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

/* ── QUEM VÊ QUAIS VERSÕES ──
   Todo mundo lê o MESMO arquivo, o latest.yml. O que muda entre uma build
   estável e uma de teste é só aceitar ou não versões prerelease:

     build estável  (0.2.2)        → allowPrerelease = false → só estáveis
     build de teste (0.2.2-dev.1)  → allowPrerelease = true  → prerelease E estáveis

   Antes daqui, uma build "-dev" fazia `autoUpdater.channel = 'dev'`, o que
   a mandava procurar um dev.yml no GitHub Releases. Esse arquivo NUNCA foi
   publicado: o electron-builder só gera o nome do canal quando existe
   `channel` em build.publish (package.json), e não existe — as releases
   todas têm apenas latest.yml. Resultado: quem instalou qualquer build
   "-dev" ficava permanentemente sem atualização, procurando um arquivo
   inexistente, sem nenhum erro visível.

   Como semver coloca 0.2.2 acima de 0.2.2-dev.1 e de 0.1.13-dev.5, esses
   presos passam a enxergar a estável mais recente e conseguem sair do
   buraco sem reinstalar na mão.

   O custo consciente: builds de teste deixam de ser invisíveis para quem
   está no estável — elas só não são OFERECIDAS a ele, por serem prerelease.
   Reativar a separação de verdade exigiria acrescentar `channel` em
   build.publish e publicar nos dois canais. */
const isPrereleaseBuild = app.getVersion().includes('-')
autoUpdater.allowPrerelease = isPrereleaseBuild
log('INFO', `Build ${app.getVersion()} — prereleases: ${isPrereleaseBuild ? 'sim' : 'não'}`)

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
