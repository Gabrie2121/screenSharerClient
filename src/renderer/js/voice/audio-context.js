import { state } from '../core/state.js'

/* ═══════════════════════════════════════════════════════════════
   AUDIOCONTEXT COMPARTILHADO DO CHAT DE VOZ — usado pelos analisadores de
   "quem está falando" (speaking-detection.js), pelo amplificador de volume
   por participante (volume.js) e pelo teste de microfone (device-settings.js).
   Separado do AudioContext da supressão de ruído (noise-suppression.js),
   que processa só a captura local antes de sair pela rede.
═══════════════════════════════════════════════════════════════ */
let voiceAudioCtx = null

export function getVoiceAudioContext() {
  if (!voiceAudioCtx) {
    voiceAudioCtx = new AudioContext()
    applyVoiceContextOutputDevice()
  }
  if (voiceAudioCtx.state === 'suspended') voiceAudioCtx.resume().catch(() => {})
  return voiceAudioCtx
}

// Espelha o dispositivo de saída escolhido (ver applyOutputDevice, usado
// nos <audio>) também no AudioContext — necessário porque o áudio
// amplificado (ver setupVoiceAmplifier em volume.js) sai direto por
// ctx.destination, não por um <audio>, então setSinkId precisa ser chamado
// aqui também pra não tocar num dispositivo diferente do resto do chat de voz.
export async function applyVoiceContextOutputDevice() {
  if (!voiceAudioCtx || !state.speakerDeviceId || typeof voiceAudioCtx.setSinkId !== 'function') return
  try {
    await voiceAudioCtx.setSinkId(state.speakerDeviceId)
  } catch (err) {
    console.warn('[SINK] Falha ao aplicar dispositivo de saída no áudio amplificado:', err)
  }
}

export async function applyOutputDevice(audioEl) {
  if (!state.speakerDeviceId || typeof audioEl.setSinkId !== 'function') return
  try {
    await audioEl.setSinkId(state.speakerDeviceId)
  } catch (err) {
    console.warn('[SINK] Falha ao aplicar dispositivo de saída:', err)
  }
}
