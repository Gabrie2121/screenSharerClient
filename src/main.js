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

// Agrupa o app na barra de tarefas do Windows sob a MESMA identidade do
// instalador (build.appId no package.json). Sem isso, o atalho fixado e a
// janela em execução podem ser tratados como coisas diferentes, e clicar no
// atalho tende a lançar um processo novo em vez de trazer o que já roda.
if (process.platform === 'win32') app.setAppUserModelId('com.sharesync.app')

/* ═══════════════════════════════════════════════════════════════
   NÃO ESTRANGULAR O APP EM SEGUNDO PLANO
   Fechar no X esconde pra bandeja e minimizar deixa a janela ocluída — nos
   dois casos o Chromium rebaixa o renderer: timers viram ~1/s e o
   compositor para de produzir quadros. Isso quebra justamente o que
   precisa continuar rodando escondido: o mini player do PiP, que compõe as
   streams num canvas por timer (ver js/auto-pip.js), e a captura de tela
   que segue sendo transmitida.

   webPreferences.backgroundThrottling: false (ver src/main/window.js) não
   cobre sozinho o caso de janela OCLUÍDA — daí as três flags abaixo, que
   precisam ser aplicadas antes do app ficar pronto.
═══════════════════════════════════════════════════════════════ */
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

/* ═══════════════════════════════════════════════════════════════
   INSTÂNCIA ÚNICA
   Fechar no X esconde o app na bandeja (ver window.on('close') em
   src/main/window.js) — o processo continua vivo, só invisível. Sem o lock
   abaixo, abrir o executável de novo nesse estado subia um segundo processo
   Electron inteiro: duas bandejas, duas janelas, dois WebSockets na mesma
   sala. A pessoa via "um app novo" em vez do que já estava aberto.

   Agora a segunda instância não cria janela nenhuma: ela avisa a primeira
   (evento 'second-instance') e morre. Quem já estava rodando reaparece.
═══════════════════════════════════════════════════════════════ */
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  // app.exit() em vez de app.quit(): quit dispara 'before-quit', que chama
  // setQuitting(true). Aqui isso é inofensivo (é outro processo), mas exit
  // encerra na hora, sem rodar o ciclo de encerramento de um app que nunca
  // chegou a abrir janela.
  app.exit(0)
} else {
  app.on('second-instance', () => {
    log('INFO', '🔁 Segunda instância bloqueada — trazendo a janela existente')
    const win = getMainWindow()
    // Se a janela já foi destruída mas o processo segue vivo (só a bandeja),
    // recria em vez de não fazer nada.
    if (!win || win.isDestroyed()) {
      createWindow()
      return
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  app.whenReady().then(() => {
    log('INFO', '🚀 App iniciado')
    createWindow()
    createTray()
  })
}

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
