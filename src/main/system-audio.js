const { ipcMain, webContents } = require('electron')
const { log } = require('./logger.js')
const processAudio = require('../../native/process-audio')

/* ═══════════════════════════════════════════════════════════════
   ÁUDIO DO SISTEMA SEM O PRÓPRIO APP

   O addon nativo (ver native/process-audio) captura tudo o que toca na
   máquina MENOS a árvore de processos do ShareSync. Isso resolve dois
   problemas de uma vez:

   1. O ECO. Com o loopback do sistema inteiro, o app da pessoa que
      compartilha estava reproduzindo a voz de todo mundo, e essa voz
      voltava dentro do áudio da tela — quem falava se ouvia, atrasado.
      Excluindo o próprio processo, a voz sai da captura na origem.

   2. MÁQUINAS ONDE O LOOPBACK COMUM NEM ABRE. O `audio: 'loopback'` do
      Chromium herda o mix format do endpoint de saída, e falha com
      "Could not start audio source" quando esse endpoint está em
      multicanal (7.1). O process loopback escolhe o próprio formato
      (48kHz estéreo float), então passa por cima disso.

   O áudio chega aqui em blocos de 20ms e é repassado ao renderer, que o
   remonta numa MediaStreamTrack (ver renderer/js/webrtc/system-audio.js).
   Fica no processo principal porque é onde o módulo nativo pode ser
   carregado — o renderer roda com nodeIntegration: false.
═══════════════════════════════════════════════════════════════ */

// Registrado no boot: é a forma de saber, olhando o log de alguém, se
// aquela máquina está usando a captura por aplicativo ou caiu no loopback
// antigo — o que muda completamente o diagnóstico de "o áudio da tela está
// com eco" ou "não sai som nenhum".
log('INFO', processAudio.disponivel()
  ? '[audio-sistema] captura por aplicativo disponível (sem o áudio do próprio app)'
  : `[audio-sistema] indisponível, usando o loopback do sistema — ${processAudio.motivoIndisponivel()}`)

// Quem pediu a captura. Só um por vez: a captura é global da máquina, não
// faz sentido abrir duas.
let ouvinteId = null

function pararCaptura() {
  if (ouvinteId === null) return
  processAudio.stop()
  ouvinteId = null
  log('INFO', '[audio-sistema] captura encerrada')
}

ipcMain.handle('system-audio-supported', () => ({
  disponivel: processAudio.disponivel(),
  motivo: processAudio.motivoIndisponivel(),
}))

// Lista de aplicativos com som, pro seletor do modal de compartilhamento.
ipcMain.handle('system-audio-apps', () => processAudio.listarApps())

// Qual processo é dono da janela escolhida — deixa o áudio daquele app já
// vir marcado quando a pessoa compartilha uma janela específica.
ipcMain.handle('system-audio-window-pid', (_e, sourceId) => processAudio.pidDaJanela(sourceId))

ipcMain.handle('system-audio-start', (event, opcoes = {}) => {
  // Um pedido novo substitui o anterior — trocar de tela em transmissão
  // passa por aqui, e deixar as duas capturas abertas duplicaria o áudio.
  pararCaptura()

  const wcId = event.sender.id
  try {
    const { pid, modo, excluir } = opcoes
    const entregar = (chunk) => {
      const alvo = webContents.fromId(wcId)
      // A janela pode ter sido fechada entre um bloco e outro.
      if (!alvo || alvo.isDestroyed()) return pararCaptura()
      alvo.send('system-audio-chunk', chunk)
    }
    const formato = modo === 'multi'
      ? processAudio.startExcluindo(entregar, excluir)
      : processAudio.start(entregar, pid, modo)
    ouvinteId = wcId
    log('INFO', `[audio-sistema] captura iniciada — ${formato.sampleRate}Hz `
      + `${formato.channels}ch, blocos de ${formato.framesPerChunk} quadros`
      + ` — ${modo === 'include' ? `só o processo ${pid}`
          : modo === 'multi' ? `sistema menos [${(excluir || []).join(', ')}] em ${formato.fontes} fonte(s)`
          : 'sistema menos este app'}`)
    return { ok: true, ...formato }
  } catch (err) {
    log('WARN', `[audio-sistema] não foi possível iniciar: ${err.message}`)
    return { ok: false, erro: err.message }
  }
})

ipcMain.on('system-audio-stop', () => pararCaptura())

module.exports = { pararCaptura }
