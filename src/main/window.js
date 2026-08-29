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
    backgroundColor: '#1a1b1e',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Com a janela escondida (bandeja) ou minimizada, o Chromium
      // estrangula timers e requestAnimationFrame do renderer até quase
      // parar. Isso justamente quando o app mais precisa continuar
      // desenhando: o mini player do PiP compõe as streams num <canvas>
      // por timer (ver js/auto-pip.js), e sob throttling ele congelava no
      // último quadro — o vídeo parecia travado ou preto exatamente
      // enquanto minimizado. Também mantém a captura de tela e as
      // conexões WebRTC com ritmo normal em segundo plano.
      backgroundThrottling: false,
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

  /* DevTools também na build empacotada. A janela é frameless e sem menu,
     então o atalho padrão do Electron não existe aqui — sem isto não há
     como ver console nem rede numa instalação de verdade, que é justamente
     onde os problemas aparecem. F12 ou Ctrl+Shift+I. */
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const isF12 = input.key === 'F12'
    const isInspect = input.control && input.shift && input.key.toLowerCase() === 'i'
    if (!isF12 && !isInspect) return
    event.preventDefault()
    win.webContents.toggleDevTools()
  })

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
// Mesmo alvo do atalho F12 registrado em createWindow — o botão existe
// porque numa build empacotada ninguém adivinha que o atalho está lá.
ipcMain.on('toggle-devtools', (e) => e.sender.toggleDevTools())

module.exports = { createWindow, getMainWindow, setQuitting }
