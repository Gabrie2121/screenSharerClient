/* Carregador do addon nativo de captura de áudio por processo.

   O addon é opcional de propósito: se ele não estiver compilado, se a ABI
   não bater ou se o Windows for antigo demais, o app continua funcionando
   pelo caminho antigo (loopback do sistema inteiro, ver webrtc/capture.js).
   Nada aqui pode derrubar o app. */
const path = require('path')

let addon = null
let motivo = 'ainda não carregado'

function caminhoDoBinario() {
  const relativo = path.join('build', 'Release', 'process_audio.node')
  // Empacotado, o .node fica fora do asar (ver asarUnpack em package.json):
  // binário nativo não pode ser carregado de dentro do arquivo.
  return __dirname.includes('app.asar')
    ? path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), relativo)
    : path.join(__dirname, relativo)
}

try {
  if (process.platform !== 'win32') {
    motivo = 'captura por processo só existe no Windows'
  } else {
    addon = require(caminhoDoBinario())
    if (!addon.isSupported()) {
      addon = null
      motivo = 'requer Windows 10 versão 2004 (build 19041) ou superior'
    }
  }
} catch (err) {
  addon = null
  motivo = `binário nativo indisponível: ${err.message}`
}

module.exports = {
  disponivel: () => addon !== null,
  motivoIndisponivel: () => motivo,
  /* Começa a capturar TUDO que toca na máquina MENOS a árvore de processos
     deste app. `onChunk` recebe Float32Array intercalado (L,R,L,R…).
     Devolve { sampleRate, channels, framesPerChunk }. Lança se não abrir. */
  start: (onChunk) => {
    if (!addon) throw new Error(motivo)
    return addon.start(onChunk)
  },
  stop: () => { if (addon) addon.stop() },
}
