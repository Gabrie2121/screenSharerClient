import { appLog } from '../core/logger.js'

/* ═══════════════════════════════════════════════════════════════
   ÁUDIO DO SISTEMA COMO MediaStreamTrack

   Pega os blocos que o processo principal manda (ver main/system-audio.js,
   que por sua vez lê do módulo nativo) e remonta uma track de áudio comum,
   do tipo que o WebRTC sabe enviar.

   O que essa track TEM de diferente do `audio: 'loopback'` do Chromium:
   ela não contém o som do próprio ShareSync. É o que acaba com a voz do
   chat voltando dentro do áudio da tela.

   A cadeia é: IPC → AudioWorklet (ring buffer, ver worklets/pcm-player.js)
   → MediaStreamDestination → track.
═══════════════════════════════════════════════════════════════ */

const WORKLET_URL = new URL('../../worklets/pcm-player.js', import.meta.url).href

let ctx = null
let node = null
let destino = null
let removerOuvinte = null

/* Devolve uma track NOVA a cada chamada. O contexto e o worklet são
   reaproveitados (criar AudioContext à toa esbarra no limite por
   documento), mas o MediaStreamDestination não: a track dele acaba parada
   pelo discardStream quando a transmissão termina, e uma track parada não
   volta a viver. Quem troca de tela em transmissão passa por replaceTrack
   (ver applySharedStreamToPeer), então uma track nova não custa
   renegociação nenhuma. */
export async function startSystemAudioTrack(alvo = {}) {
  const suporte = await window.electronAPI?.systemAudioSupported?.()
  if (!suporte?.disponivel) {
    appLog('INFO', `[audio-sistema] indisponível — ${suporte?.motivo || 'sem ponte com o processo principal'}`)
    return null
  }

  if (!ctx) {
    // 48kHz fixo: é o formato que o módulo nativo entrega, e deixar o
    // contexto nesse mesmo valor evita um reamostrador no caminho.
    ctx = new AudioContext({ sampleRate: 48000 })
    await ctx.audioWorklet.addModule(WORKLET_URL)
    node = new AudioWorkletNode(ctx, 'pcm-player', { outputChannelCount: [2] })
  }
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {})

  try { node.disconnect() } catch { /* ainda não estava conectado */ }
  destino = ctx.createMediaStreamDestination()
  node.connect(destino)

  const resultado = await window.electronAPI.systemAudioStart(alvo)
  if (!resultado?.ok) {
    appLog('WARN', `[audio-sistema] falhou ao iniciar: ${resultado?.erro || 'motivo desconhecido'}`)
    return null
  }

  // Um ouvinte por captura — sem remover o anterior, dois blocos entrariam
  // no mesmo anel e o áudio sairia dobrado.
  removerOuvinte?.()
  removerOuvinte = window.electronAPI.onSystemAudioChunk((chunk) => {
    node.port.postMessage(chunk, [chunk.buffer])
  })

  appLog('INFO', alvo.modo === 'include'
    ? `[audio-sistema] transmitindo só o áudio de ${alvo.nome || 'um aplicativo'}`
    : alvo.modo === 'multi'
      ? `[audio-sistema] sistema menos [${(alvo.excluir || []).join(', ')}]`
        + ` — ${resultado.fontes} aplicativo(s) no ar`
      : '[audio-sistema] captura por processo ativa (sem o áudio do próprio app)')
  return destino.stream.getAudioTracks()[0] || null
}

export function stopSystemAudioTrack() {
  removerOuvinte?.()
  removerOuvinte = null
  window.electronAPI?.systemAudioStop?.()
}

// Se a captura por processo está disponível nesta máquina — usado pra
// decidir entre ela e o loopback antigo (ver acquireStream em capture.js).
// Aplicativos com som agora, pro seletor do modal de compartilhamento.
export async function listSystemAudioApps() {
  try {
    return await window.electronAPI?.systemAudioApps?.() || []
  } catch {
    return []
  }
}

// Processo dono da janela escolhida (0 quando a fonte é uma tela inteira).
export async function windowAudioPid(sourceId) {
  try {
    return await window.electronAPI?.systemAudioWindowPid?.(sourceId) || 0
  } catch {
    return 0
  }
}

export async function isSystemAudioAvailable() {
  const suporte = await window.electronAPI?.systemAudioSupported?.()
  return !!suporte?.disponivel
}
