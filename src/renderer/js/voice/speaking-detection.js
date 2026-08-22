import { state } from '../core/state.js'
import { getVoiceAudioContext } from './audio-context.js'

/* ═══════════════════════════════════════════════════════════════
   DETECÇÃO DE "QUEM ESTÁ FALANDO" — AnalyserNode local por stream de voz
   (incluindo o próprio microfone), sem precisar de nenhuma mensagem nova
   no WebSocket.
═══════════════════════════════════════════════════════════════ */
export const voiceAnalysers = {} // uid (ou '__self__') -> { analyser, dataArray }

export function setupLocalVoiceAnalyser(stream) {
  try {
    const ctx = getVoiceAudioContext()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser) // só análise — não conecta no destino (senão ecoaria o próprio mic)
    voiceAnalysers['__self__'] = { analyser, dataArray: new Uint8Array(analyser.fftSize) }
  } catch (err) {
    console.warn('[VAD] Falha ao configurar análise do microfone local:', err)
  }
}

// Um único MediaStreamAudioSourceNode por stream remota, compartilhado entre
// o analisador de "quem está falando" (aqui) e o amplificador de voz (ver
// setupVoiceAmplifier em volume.js) — dois source nodes puxando a MESMA
// MediaStream ao mesmo tempo é instável no Chromium (o segundo fica mudo em
// vez de dar erro), e foi exatamente isso que travava o áudio ao passar de
// 100%: o amplificador criava sua própria fonte, concorrendo com a do
// analisador.
// uid -> { source, stream }
export const remoteVoiceSources = {}

export function getRemoteVoiceSource(uid, stream) {
  const ctx = getVoiceAudioContext()
  const entry = remoteVoiceSources[uid]
  if (entry && entry.stream === stream) return entry.source
  if (entry) { try { entry.source.disconnect() } catch { /* já desconectado */ } }
  const source = ctx.createMediaStreamSource(stream)
  remoteVoiceSources[uid] = { source, stream }
  return source
}

export function removeRemoteVoiceSource(uid) {
  const entry = remoteVoiceSources[uid]
  if (!entry) return
  try { entry.source.disconnect() } catch { /* já desconectado */ }
  delete remoteVoiceSources[uid]
}

export function setupRemoteVoiceAnalyser(uid, stream) {
  try {
    const source = getRemoteVoiceSource(uid, stream)
    const analyser = getVoiceAudioContext().createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    voiceAnalysers[uid] = { analyser, dataArray: new Uint8Array(analyser.fftSize) }
  } catch (err) {
    console.warn(`[VAD] Falha ao configurar análise de voz de ${uid}:`, err)
  }
}

export function removeVoiceAnalyser(uid) { delete voiceAnalysers[uid] }

// Limpa todos os analisadores remotos (mantém '__self__') — usado quando o
// WebSocket cai (ver websocket.js/onclose): as conexões de voz caem junto,
// mas o microfone local continua capturado.
export function clearRemoteVoiceAnalysers() {
  Object.keys(voiceAnalysers).forEach(key => { if (key !== '__self__') delete voiceAnalysers[key] })
}

// Limpa TODOS os analisadores, incluindo '__self__' — usado ao sair da
// sala de propósito (ver room-actions.js), quando o microfone local
// também é liberado.
export function clearAllVoiceAnalysers() {
  Object.keys(voiceAnalysers).forEach(key => delete voiceAnalysers[key])
}

const SPEAKING_THRESHOLD = 0.02 // RMS mínimo pra considerar "falando"
let speakingLoopTimer = null

export function startSpeakingLoop() {
  if (speakingLoopTimer) return
  speakingLoopTimer = setInterval(() => {
    let changed = false
    for (const [key, { analyser, dataArray }] of Object.entries(voiceAnalysers)) {
      analyser.getByteTimeDomainData(dataArray)
      let sum = 0
      for (let i = 0; i < dataArray.length; i++) {
        const v = (dataArray[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.sqrt(sum / dataArray.length)
      const uid = key === '__self__' ? state.myId : key
      const isSpeaking = rms > SPEAKING_THRESHOLD && (key === '__self__' ? !state.micMuted : true)
      const was = state.speaking.has(uid)
      if (isSpeaking && !was) { state.speaking.add(uid); changed = true }
      else if (!isSpeaking && was) { state.speaking.delete(uid); changed = true }
    }
    if (changed) updateSpeakingIndicators()
  }, 200)
}

export function stopSpeakingLoop() {
  clearInterval(speakingLoopTimer)
  speakingLoopTimer = null
}

export function updateSpeakingIndicators() {
  document.querySelectorAll('.participant-item').forEach(li => {
    const avatar = li.querySelector('.participant-avatar')
    avatar?.classList.toggle('speaking', state.speaking.has(li.dataset.uid))
  })
}
