import { appLog } from '../core/logger.js'
import { toast } from '../core/toast.js'
import { state } from '../core/state.js'
import { ICE_CONFIG } from '../core/ice-config.js'
import { sendWS } from '../websocket.js'
import { renderParticipants } from '../participants.js'
import { upsertStreamCard, removeStreamCard } from '../stream-cards.js'

/* ═══════════════════════════════════════════════════════════════
   ASSISTIR / PARAR DE ASSISTIR
═══════════════════════════════════════════════════════════════ */
// Precisa ser folgado o bastante pra não cancelar uma conexão que ainda
// está negociando o fallback TURN via TCP/443 (ver ICE_CONFIG) — em redes
// restritivas essa negociação sozinha pode levar vários segundos.
const WATCH_TIMEOUT_MS = 25000

export async function toggleWatch(uid) {
  if (state.watching.has(uid)) {
    // Para de assistir (ou cancela uma conexão ainda "Conectando…") —
    // fecha só a MINHA conexão de assistir. Se essa pessoa também estiver
    // me assistindo, a conexão dela continua de pé.
    stopWatchTimeout(uid)
    state.watching.delete(uid)
    state.connecting.delete(uid)
    closeWatchPeer(uid)
    removeStreamCard(uid)
    renderParticipants()
  } else {
    // Começa a assistir — inicia negociação WebRTC. Fica em "connecting"
    // até o primeiro track chegar (ver ontrack em createPeer), pra não
    // mostrar "Assistindo" antes da hora.
    state.watching.add(uid)
    state.connecting.add(uid)
    renderParticipants()
    await startPeerConnection(uid)

    // Corrige o "carregando infinito": se em N segundos nenhum track
    // chegar (offer perdida, pessoa parou de compartilhar, ICE travado),
    // desiste, avisa e libera o botão para tentar de novo.
    stopWatchTimeout(uid)
    state.watchTimeouts[uid] = setTimeout(() => {
      delete state.watchTimeouts[uid]
      if (!state.watching.has(uid) || state.remoteStreams[uid]) return
      appLog('WARN', `Timeout esperando stream de ${uid} — cancelando`)
      state.watching.delete(uid)
      state.connecting.delete(uid)
      closeWatchPeer(uid)
      removeStreamCard(uid)
      renderParticipants()
      toast('Não foi possível carregar essa tela. Tente assistir de novo.')
    }, WATCH_TIMEOUT_MS)
  }
}

export function stopWatchTimeout(uid) {
  clearTimeout(state.watchTimeouts[uid])
  delete state.watchTimeouts[uid]
}

/* ═══════════════════════════════════════════════════════════════
   WEBRTC — QUEM ASSISTE INICIA A OFERTA
═══════════════════════════════════════════════════════════════ */
async function startPeerConnection(remoteId) {
  const pc = createPeer(remoteId, 'watcher')

  const offer = await pc.createOffer({
    offerToReceiveVideo: true,
    offerToReceiveAudio: true,
  })
  await pc.setLocalDescription(offer)

  sendWS({ type: 'offer', to: remoteId, payload: offer })
}

// role: 'watcher' → eu inicio a oferta pra RECEBER a tela de remoteId.
// role: 'sharer'  → eu respondo a uma oferta ENVIANDO minha tela pra remoteId.
// As duas conexões são independentes (mapas separados) porque "eu assisto
// ele" e "ele me assiste" podem estar ativos ao mesmo tempo; antes disso
// havia uma única RTCPeerConnection por usuário e a offer de um lado
// derrubava a conexão do outro lado no meio da negociação (glare),
// deixando a tela preta pra quem estava assistindo mutuamente.
function createPeer(remoteId, role) {
  const map = role === 'watcher' ? state.watchPeers : state.sharePeers
  if (map[remoteId]) {
    map[remoteId].close()
    delete map[remoteId]
  }

  const pc = new RTCPeerConnection(ICE_CONFIG)
  map[remoteId] = pc

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      // Marca de qual das duas conexões esse candidato veio, pra quem
      // recebe saber em qual pc local aplicar (ver handleIceCandidate).
      sendWS({ type: 'ice-candidate', to: remoteId, payload: { candidate: e.candidate, role } })
    }
  }

  pc.oniceconnectionstatechange = () => {
    console.log(`[ICE ${role} ${remoteId}]`, pc.iceConnectionState)
  }

  pc.onconnectionstatechange = () => {
    console.log(`[CONN ${role} ${remoteId}]`, pc.connectionState)

    if (pc.connectionState === 'failed') {
      appLog('WARN', `Conexão (${role}) com ${remoteId} falhou (ICE não conseguiu conectar nem via TURN)`)

      if (role === 'watcher') {
        // Se eu estava assistindo essa pessoa, limpa o card e deixa
        // tentar de novo — sem isso o card ficava "conectado" mas preto/parado.
        if (state.watching.has(remoteId)) {
          state.watching.delete(remoteId)
          state.connecting.delete(remoteId)
          removeStreamCard(remoteId)
          renderParticipants()
          toast('A conexão com essa tela falhou. Tente assistir de novo.')
        }
        closeWatchPeer(remoteId)
      } else {
        closeSharePeer(remoteId)
      }
    }
  }

  // Só a conexão em que EU assisto (watcher) recebe stream aqui.
  if (role === 'watcher') {
    pc.ontrack = (e) => {
      console.log(`[TRACK de ${remoteId}]`, e.track.kind, e.streams)
      const stream = e.streams[0]
      if (!stream) return
      stopWatchTimeout(remoteId)
      // Só agora o botão vira "Assistindo" — antes disso ficava
      // "Conectando…" (ver makeParticipantItem) pra ninguém clicar de
      // novo achando que travou e cancelar bem na hora em que o vídeo
      // ia carregar. Um stream chega em tracks separados (vídeo + áudio),
      // então só re-renderiza a lista na primeira vez que isso muda.
      if (state.connecting.delete(remoteId)) renderParticipants()
      state.remoteStreams[remoteId] = stream
      upsertStreamCard(remoteId, stream)
    }
  }

  // Se é a conexão em que eu COMPARTILHO (sharer), adiciona tracks agora
  if (role === 'sharer' && state.sharing && state.localStream) {
    state.localStream.getTracks().forEach(track => {
      console.log('[ADD TRACK]', track.kind)
      pc.addTrack(track, state.localStream)
    })
  }

  return pc
}

// Recebe offer (alguém quer assistir minha tela) — eu respondo como sharer
export async function handleOffer(fromId, offer) {
  console.log('[OFFER recebida de]', fromId, '| sharing:', state.sharing)

  if (!state.sharing || !state.localStream) {
    console.warn('Recebi offer mas não estou compartilhando, ignorando.')
    return
  }

  // Cria peer JÁ com os tracks antes de responder
  const pc = createPeer(fromId, 'sharer')

  await pc.setRemoteDescription(new RTCSessionDescription(offer))

  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)

  console.log('[ANSWER enviado para]', fromId)
  sendWS({ type: 'answer', to: fromId, payload: answer })
}

export async function handleAnswer(fromId, answer) {
  console.log('[ANSWER recebido de]', fromId)
  // Só a minha conexão de watcher fica esperando uma answer.
  const pc = state.watchPeers[fromId]
  if (!pc) return
  await pc.setRemoteDescription(new RTCSessionDescription(answer))
}

export async function handleIceCandidate(fromId, payload) {
  // payload.role é o papel de QUEM ENVIOU nessa conexão específica — pra
  // mim, o candidato é da conexão oposta: se ele mandou como 'watcher'
  // (ele assistindo a mim), esse candidato é da MINHA conexão de sharer
  // com ele, e vice-versa.
  const role = payload?.role === 'watcher' ? 'sharer' : 'watcher'
  const pc = role === 'watcher' ? state.watchPeers[fromId] : state.sharePeers[fromId]
  if (!pc) {
    console.warn('[ICE] Peer não encontrado para', fromId, role)
    return
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(payload.candidate))
  } catch (e) {
    console.warn('[ICE ERROR]', e)
  }
}

/* ═══════════════════════════════════════════════════════════════
   QUALIDADE POR ESPECTADOR — quem assiste escolhe 360p/480p/720p/1080p ou
   automática pra economizar banda (ver seletor em upsertStreamCard). Como
   cada par usuário↔usuário tem sua própria RTCPeerConnection
   (state.sharePeers), dá pra ajustar o encoder por espectador sem afetar
   quem está assistindo em qualidade automática/alta — não é simulcast, é
   só o mesmo vídeo sendo reescalado/recomprimido nessa conexão específica.
═══════════════════════════════════════════════════════════════ */
const QUALITY_BITRATE_KBPS = { 360: 600, 480: 1000, 720: 2500, 1080: 4000 }

export async function applyViewerQuality(viewerId, requestedHeight) {
  const pc = state.sharePeers[viewerId]
  if (!pc) return
  const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video')
  if (!sender) return

  const nativeHeight = state.localStream?.getVideoTracks()[0]?.getSettings()?.height

  try {
    const params = sender.getParameters()
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]

    if (!requestedHeight || !nativeHeight) {
      // "Automática" — volta a mandar na resolução nativa capturada
      delete params.encodings[0].scaleResolutionDownBy
      delete params.encodings[0].maxBitrate
    } else {
      params.encodings[0].scaleResolutionDownBy = Math.max(1, nativeHeight / requestedHeight)
      params.encodings[0].maxBitrate = (QUALITY_BITRATE_KBPS[requestedHeight] || 2000) * 1000
    }

    await sender.setParameters(params)
    appLog('INFO', `Qualidade ajustada para ${viewerId}: ${requestedHeight ? requestedHeight + 'p' : 'automática'}`)
  } catch (err) {
    console.warn('[QUALITY] Falha ao ajustar parâmetros do encoder:', err)
  }
}

export function closeWatchPeer(uid) {
  state.watchPeers[uid]?.close()
  delete state.watchPeers[uid]
  delete state.remoteStreams[uid]
}

export function closeSharePeer(uid) {
  state.sharePeers[uid]?.close()
  delete state.sharePeers[uid]
}
