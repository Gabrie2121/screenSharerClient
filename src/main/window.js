const { BrowserWindow, ipcMain, desktopCapturer, session } = require('electron')
const path = require('path')
const { log } = require('./logger.js')
const { checkForUpdates } = require('./updater.js')

let mainWindow = null
// Fechar a janela (X, ou o botão de fechar do titlebar custom) minimiza pra
// bandeja em vez de encerrar o app — só sai de verdade pelo "Sair" do menu
// da bandeja (ver tray.js, e app.on('before-quit') em src/main.js), que
// chamam setQuitting(true) antes.
let isQuitting = false

function getMainWindow() {
  return mainWindow
}

function setQuitting(value) {
  isQuitting = value
}

// Fonte escolhida no modal de compartilhar (ver captureSource em
// js/webrtc/capture.js) — usada pelo setDisplayMediaRequestHandler abaixo.
let pendingSourceId = null
ipcMain.on('set-capture-source-id', (_e, id) => { pendingSourceId = id })

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Deixa o Electron mostrar o seletor nativo de tela.
  // `audio: 'loopback'` captura o áudio de saída do Windows inteiro (tela toda),
  // que é exatamente o que o getDisplayMedia({ audio: true }) do renderer pede.
  // Só tenta o loopback quando o renderer realmente pediu áudio
  // (`request.audioRequested`) — o renderer cai pra um retry só de vídeo
  // quando a captura de áudio falha (ver captureSource em js/webrtc/capture.js),
  // e se aqui a gente forçasse 'loopback' sempre, esse retry falharia igual.
  //
  // A fonte a usar é a que a pessoa escolheu no modal "Escolher o que
  // compartilhar" (ver pendingSourceId, setado via IPC pouco antes do
  // getDisplayMedia() em captureSource/js/webrtc/capture.js) — `getDisplayMedia()`
  // não carrega esse id no `request`, por isso o vínculo é feito por fora.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      const match = sources.find((s) => s.id === pendingSourceId) || sources[0]
      callback({ video: match, audio: request.audioRequested ? 'loopback' : undefined })
    })
  })

  // Só checa atualizações depois que o renderer termina de carregar —
  // do contrário 'update-available' pode ser enviado antes do listener
  // IPC ser registrado no renderer, e o Electron não bufferiza a mensagem.
  win.webContents.once('did-finish-load', () => checkForUpdates())

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  mainWindow = win
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })

  // Minimiza pra bandeja em vez de fechar — assim uma live em andamento
  // não é derrubada só porque a pessoa clicou no X. "Sair" de verdade só
  // pelo menu da bandeja (ver tray.js).
  win.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    win.hide()
  })

  attachAutoPip(win)

  return win
}

/* ═══════════════════════════════════════════════════════════════
   PICTURE-IN-PICTURE AUTOMÁTICO
   Some com a janela (minimizar, ou o X que esconde pra bandeja) e a tela
   que você estava assistindo continua numa janelinha flutuante do SO. Ao
   voltar, o PiP fecha sozinho e o vídeo volta pro card.

   Por que passa por executeJavaScript e não por um ipc comum: o Chromium
   exige *transient user activation* pra permitir requestPictureInPicture().
   Minimizar pela barra de tarefas ou pelo Win+D é um gesto no SO, não no
   renderer — um ipcRenderer.on() rodaria sem activation nenhuma e o pedido
   seria rejeitado com NotAllowedError. O segundo argumento `true` do
   executeJavaScript simula esse gesto, que é o único caminho daqui.

   (Os botões de minimizar/fechar do titlebar custom também disparam o PiP
   direto do próprio handler de clique — ali o gesto é legítimo. As duas
   pontas são idempotentes, ver js/auto-pip.js.)
═══════════════════════════════════════════════════════════════ */
function runInRenderer(win, code) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  // userGesture = true — ver o bloco acima.
  win.webContents.executeJavaScript(code, true).catch((err) => {
    log('WARN', `Falha ao acionar PiP automático: ${err.message}`)
  })
}

function attachAutoPip(win) {
  const enter = () => runInRenderer(win, 'window.__sharesyncAutoPip?.()')
  const exit  = () => runInRenderer(win, 'window.__sharesyncExitPip?.()')

  win.on('minimize', enter)
  win.on('hide', enter)      // o X indo pra bandeja passa por aqui
  win.on('restore', exit)
  win.on('show', exit)
}

ipcMain.on('window-minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
ipcMain.on('window-maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  win?.isMaximized() ? win.unmaximize() : win.maximize()
})
ipcMain.on('window-close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())

module.exports = { createWindow, getMainWindow, setQuitting }
