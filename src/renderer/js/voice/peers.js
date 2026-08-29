import { $ } from '../core/dom.js'
import { state } from '../core/state.js'
import { ICE_CONFIG } from '../core/ice-config.js'
import { attachIceDebug, noteRemoteCandidate } from '../core/ice-debug.js'
import { sendWS } from '../websocket.js'
import { ensureLocalMicStream, applyMicMuteState } from './mic.js'
import {
  startSpeakingLoop, setupRemoteVoiceAnalyser, removeVoiceAnalyser,
  removeRemoteVoiceSource, updateSpeakingIndicators,
} from './speaking-detection.js'
import { applyOutputDevice } from './audio-context.js'
import { startShareAudioDuck } from '../share-audio-duck.js'
import { removeVoiceAmplifier, applyVoiceVolume } from './volume.js'

/* ══════════════════════════════════════════════════════════════
   CHAT DE VOZ
   Reaproveita a mesma sinalização WebRTC do compartilhamento de tela
   (offer/answer/ice-candidate, ver context.MD → Fluxo WebSocket e o
   dispatcher em websocket.js) — o que muda é payload.kind: 'voice' e o
   fato de a conexão ser bidirecional (cada RTCPeerConnection já manda E
   recebe áudio, ao contrário de watchPeers/sharePeers que são unidirecionais).

   Quem inicia a oferta: só quem ACABA de entrar na sala, pra cada membro
   já existente (ver initVoiceChat, chamado no 'room-info'). Quem já
   estava na sala nunca oferta pro recém-chegado — só responde a oferta
   dele. Isso evita duas ofertas simultâneas (glare) entre o mesmo par.
═══════════════════════════════════════════════════════════════ */

export async function initVoiceChat() {
  await ensureLocalMicStream()
  applyMicMuteState()
  startSpeakingLoop()
  // O ducking depende de quem está falando, então acompanha esse mesmo loop.
  startShareAudioDuck()
  for (const uid of Object.keys(state.users)) {
    if (!state.voicePeers[uid]) startVoicePeerConnection(uid)
  }
}

function createVoicePeer(remoteId) {
  if (state.voicePeers[remoteId]) {
    state.voicePeers[remoteId].close()
    delete state.voicePeers[remoteId]
  }

  const pc = new RTCPeerConnection(ICE_CONFIG)
  state.voicePeers[remoteId] = pc
  // A voz é o grupo de controle do diagnóstico: se ela conecta e tela/câmera
  // não, o problema é do código delas; se nenhuma conecta, é ICE/rede.
  attachIceDebug(pc, `voz ${remoteId.slice(0, 8)}`)

  if (state.localMicStream) {
    state.localMicStream.getAudioTracks().forEach(track => pc.addTrack(track, state.localMicStream))
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendWS({ type: 'ice-candidate', to: remoteId, payload: { candidate: e.candidate, kind: 'voice' } })
    }
  }

  pc.onconnectionstatechange = () => {
    console.log(`[VOICE CONN ${remoteId}]`, pc.connectionState)
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      closeVoicePeer(remoteId)
    }
  }

  // Bidirecional: a mesma conexão recebe o áudio de quem está do outro lado.
  pc.ontrack = (e) => {
    const stream = e.streams[0]
    if (!stream) return

    let audioEl = state.voiceAudioEls[remoteId]
    if (!audioEl) {
      audioEl = document.createElement('audio')
      audioEl.autoplay = true
      $('voice-audio-container').appendChild(audioEl)
      state.voiceAudioEls[remoteId] = audioEl
      applyOutputDevice(audioEl)
    }

    // Reconexão manda uma stream nova — descarta a cadeia de ganho antiga
    // (ela lia da stream velha, que já era pra ter parado de existir).
    removeVoiceAmplifier(remoteId)

    // O <audio> toca a stream crua do WebRTC direto, sempre, e nunca troca
    // de srcObject depois disso — é o caminho comprovadamente confiável,
    // sem nenhuma dependência do Web Audio (já tentei rotear o áudio
    // recebido por um AudioContext antes de chegar aqui, em mais de uma
    // versão, e isso deixou a saída de áudio inteira muda). Quem amplifica
    // acima de 100% é applyVoiceVolume, e faz isso à parte: muta este
    // elemento e manda o som, já com ganho de verdade, direto pro
    // AudioContext.destination (ver setupVoiceAmplifier em volume.js).
    if (audioEl.srcObject !== stream) {
      audioEl.srcObject = stream
      audioEl.play().catch((err) => {
        console.warn(`[VOICE] Autoplay bloqueado para ${remoteId}:`, err)
      })
    }

    // Precisa rodar antes de applyVoiceVolume — é quem cria a fonte
    // compartilhada (ver getRemoteVoiceSource) que o amplificador reusa.
    setupRemoteVoiceAnalyser(remoteId, stream)
    applyVoiceVolume(remoteId)
  }

  return pc
}

async function startVoicePeerConnection(remoteId) {
  await ensureLocalMicStream()
  const pc = createVoicePeer(remoteId)
  const offer = await pc.createOffer({ offerToReceiveAudio: true })
  await pc.setLocalDescription(offer)
  sendWS({ type: 'offer', to: remoteId, payload: { ...offer, kind: 'voice' } })
}

export async function handleVoiceOffer(fromId, payload) {
  await ensureLocalMicStream()
  const pc = createVoicePeer(fromId)
  await pc.setRemoteDescription(new RTCSessionDescription({ type: payload.type, sdp: payload.sdp }))
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  sendWS({ type: 'answer', to: fromId, payload: { ...answer, kind: 'voice' } })
}

export async function handleVoiceAnswer(fromId, payload) {
  const pc = state.voicePeers[fromId]
  if (!pc) return
  await pc.setRemoteDescription(new RTCSessionDescription({ type: payload.type, sdp: payload.sdp }))
}

export async function handleVoiceIceCandidate(fromId, payload) {
  const pc = state.voicePeers[fromId]
  if (!pc) return
  try {
    noteRemoteCandidate(pc, payload.candidate)
    await pc.addIceCandidate(new RTCIceCandidate(payload.candidate))
  } catch (e) {
    console.warn('[VOICE ICE ERROR]', e)
  }
}

export function closeVoicePeer(uid) {
  state.voicePeers[uid]?.close()
  delete state.voicePeers[uid]
  const audioEl = state.voiceAudioEls[uid]
  if (audioEl) {
    audioEl.srcObject = null
    audioEl.remove()
    delete state.voiceAudioEls[uid]
  }
  removeVoiceAmplifier(uid)
  removeVoiceAnalyser(uid)
  removeRemoteVoiceSource(uid)
  state.speaking.delete(uid)
  updateSpeakingIndicators()
}
