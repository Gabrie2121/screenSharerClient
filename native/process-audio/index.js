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

/* Nome amigável a partir do executável: "Discord.exe" → "Discord". Alguns
   nomes não ganham nada com isso (msedgewebview2), mas a alternativa era o
   DisplayName da sessão, que vem vazio na maioria dos apps de desktop. */
function nomeAmigavel(exe) {
  return exe.replace(/\.exe$/i, '')
}

module.exports = {
  disponivel: () => addon !== null,
  motivoIndisponivel: () => motivo,

  /* Aplicativos com sessão de áudio no dispositivo de saída padrão.

     Agrupado por EXECUTÁVEL, não por processo: apps como o Discord e os
     navegadores abrem várias sessões (uma por processo filho) e apareceriam
     repetidos numa lista de escolha. Fica o PID de uma sessão que está
     tocando quando existe uma — é a que tem mais chance de ser a árvore
     certa quando o modo é "capturar só este app". */
  listarApps: () => {
    if (!addon) return []
    const porExe = new Map()
    for (const s of addon.listAudioApps()) {
      const atual = porExe.get(s.nome)
      if (!atual) porExe.set(s.nome, { ...s })
      else if (s.tocando && !atual.tocando) porExe.set(s.nome, { ...s })
    }
    return [...porExe.values()]
      .map(s => ({ pid: s.pid, exe: s.nome, nome: nomeAmigavel(s.nome), tocando: s.tocando }))
      // Quem está tocando agora primeiro: é quase sempre o que a pessoa quer.
      .sort((a, b) => (b.tocando - a.tocando) || a.nome.localeCompare(b.nome))
  },

  /* Processo dono de uma janela, a partir do id do desktopCapturer
     ("window:<HWND>:0"). Serve pra já vir marcado o áudio do aplicativo
     que a pessoa escolheu compartilhar. Devolve 0 quando não dá. */
  pidDaJanela: (sourceId) => {
    if (!addon || typeof sourceId !== 'string') return 0
    const m = /^window:(\d+):/.exec(sourceId)
    if (!m) return 0
    return addon.windowProcessId(Number(m[1]))
  },

  /* Começa a capturar. Sem `pid`, o alvo é o próprio processo em modo
     EXCLUDE: "tudo o que toca na máquina menos este app". Com `pid` e
     modo 'include', captura SÓ a árvore daquele processo.
     Devolve { sampleRate, channels, framesPerChunk }. Lança se não abrir. */
  start: (onChunk, pid, modo) => {
    if (!addon) throw new Error(motivo)
    return addon.start(onChunk, pid || process.pid, modo === 'include' ? 'include' : 'exclude')
  },
  stop: () => { if (addon) addon.stop() },
}
