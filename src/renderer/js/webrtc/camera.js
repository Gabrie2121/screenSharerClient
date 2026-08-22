import { $ } from '../core/dom.js'
import { appLog } from '../core/logger.js'
import { toast } from '../core/toast.js'
import { playSound } from '../core/sounds.js'
import { state, CAM_DEVICE_KEY } from '../core/state.js'
import { ICE_CONFIG } from '../core/ice-config.js'
import { attachIceDebug, noteRemoteCandidate } from '../core/ice-debug.js'
import { sendWS } from '../websocket.js'
import { renderParticipants } from '../participants.js'
import { renderCameraStrip, removeCameraTile } from '../camera-strip.js'

/* ═══════════════════════════════════════════════════════════════
   CÂMERA (WEBCAM)
   Reaproveita a mesma sinalização de tela e voz (offer/answer/ice-candidate,
   ver o contrato em CLAUDE.md) — o que identifica este fluxo é
   payload.kind === 'webcam'. O backend repassa às cegas, como sempre.

   QUEM OFERTA — a diferença importante pros outros dois fluxos:

   - Tela: quem oferta é quem quer ASSISTIR (ninguém recebe sem clicar).
   - Voz:  quem oferta é quem ACABOU DE ENTRAR, pros que já estavam.
   - Câmera: quem oferta é quem LIGA a câmera, pra cada participante.

   Câmera é auto-inscrita (ligou, todo mundo vê, sem clicar em nada), então
   a ponta que oferta é sempre a que tem mídia nova. Isso é o que garante
   que nunca há duas ofertas simultâneas entre o mesmo par — a colisão
   (glare) que motivou os mapas separados em primeiro lugar.

   Consequência: state.camPeers são conexões em que EU ENVIO (sendonly) e
   state.camViewPeers são as em que EU RECEBO (recvonly). Nunca unifique
   com watchPeers/sharePeers/voicePeers.

   Só vídeo: getUserMedia é chamado com audio: false de propósito. O
   microfone já tem um caminho próprio e único (ver js/voice/mic.js);
   capturar áudio aqui criaria uma segunda captura do mesmo mic, que a
   pessoa não teria como mutar pelo botão da sidebar.
═══════════════════════════════════════════════════════════════ */

$('btn-toggle-camera').onclick = () => toggleCamera()

export async function toggleCamera() {
  if (state.cameraOn) stopCamera()
  else await startCamera()
}

export async function startCamera() {
  if (state.cameraOn) return

  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // deviceId 'exact' faria a captura falhar se a câmera escolhida tiver
      // sido desconectada; sem 'exact' o navegador cai na câmera padrão.
      video: state.camDeviceId ? { deviceId: state.camDeviceId } : true,
      audio: false, // ver o cabeçalho: o mic tem caminho próprio
    })
  } catch (err) {
    console.error('[CAM] Falha ao abrir a câmera:', err)
    appLog('ERROR', `Falha ao abrir a câmera: ${err.message}`)
    toast(err.name === 'NotAllowedError'
      ? 'Permissão de câmera negada.'
      : `Não foi possível abrir a câmera: ${err.message}`)
    return
  }

  state.localCamStream = stream
  state.cameraOn = true

  // A câmera pode ser desligada por fora do app (desconectaram o cabo, outro
  // programa tomou o dispositivo) — sem isso o app continuaria anunciando
  // uma câmera ligada que não manda frame nenhum.
  stream.getVideoTracks()[0].onended = () => stopCamera()

  $('btn-toggle-camera').classList.add('active')
  $('btn-toggle-camera').title = 'Desligar câmera'

  sendWS({ type: 'start-camera' })

  // Oferta pra todo mundo que já está na sala. Quem entrar depois recebe
  // uma oferta no 'user-joined' (ver websocket.js).
  for (const uid of Object.keys(state.users)) offerCameraTo(uid)

  renderCameraStrip()
  renderParticipants()
  playSound('camera-on')
  appLog('INFO', 'Câmera ligada')
  toast('Sua câmera está ligada.')
}

export function stopCamera() {
  if (!state.cameraOn) return

  // Desarma o onended antes de parar — parar a track dispararia o handler
  // que chama esta mesma função (mesma armadilha do compartilhamento de
  // tela, ver discardStream em capture.js).
  state.localCamStream?.getTracks().forEach(t => {
    t.onended = null
    t.stop()
  })
  state.localCamStream = null
  state.cameraOn = false

  $('btn-toggle-camera').classList.remove('active')
  $('btn-toggle-camera').title = 'Ligar câmera'

  sendWS({ type: 'stop-camera' })

  // Fecha só as conexões em que EU ENVIAVA. As camViewPeers (câmeras que
  // eu recebo dos outros) continuam de pé — desligar a minha câmera não
  // tem por que me cegar pras dos outros.
  Object.keys(state.camPeers).forEach(uid => closeCamPeer(uid))

  if (state.stagedCamId === state.myId) state.stagedCamId = null
  renderCameraStrip()
  renderParticipants()
  playSound('camera-off')
  appLog('INFO', 'Câmera desligada')
}

/* ═══════════════════════════════════════════════════════════════
   PEERS
═══════════════════════════════════════════════════════════════ */
// role: 'cam-sender' → eu envio minha câmera (offerer, sendonly)
// role: 'cam-viewer' → eu recebo a câmera dele (answerer, recvonly)
function createCamPeer(remoteId, role) {
  const map = role === 'cam-sender' ? state.camPeers : state.camViewPeers
  if (map[remoteId]) {
    map[remoteId].close()
    delete map[remoteId]
  }

  const pc = new RTCPeerConnection(ICE_CONFIG)
  map[remoteId] = pc
  attachIceDebug(pc, `camera/${role} ${remoteId.slice(0, 8)}`)

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      // Marca de qual das duas conexões o candidato veio — quem recebe
      // inverte o papel pra achar a pc local certa (ver
      // handleCamIceCandidate). Mesma ideia do payload.role da tela.
      sendWS({
        type: 'ice-candidate',
        to: remoteId,
        payload: { candidate: e.candidate, kind: 'webcam', role },
      })
    }
  }

  pc.onconnectionstatechange = () => {
    console.log(`[CAM ${role} ${remoteId}]`, pc.connectionState)
    if (pc.connectionState === 'failed') {
      appLog('WARN', `Conexão de câmera (${role}) com ${remoteId} falhou`)
      if (role === 'cam-sender') closeCamPeer(remoteId)
      else closeCamViewPeer(remoteId)
    }
  }

  if (role === 'cam-sender') {
    state.localCamStream?.getVideoTracks().forEach(track => {
      pc.addTrack(track, state.localCamStream)
    })
  } else {
    pc.ontrack = (e) => {
      const stream = e.streams[0]
      if (!stream) return
      state.camStreams[remoteId] = stream
      renderCameraStrip()
    }
  }

  return pc
}

// Chamado ao ligar a câmera (pra cada participante) e quando alguém novo
// entra na sala com a minha câmera já ligada.
export async function offerCameraTo(remoteId) {
  if (!state.cameraOn || !state.localCamStream) return
  if (remoteId === state.myId) return

  try {
    const pc = createCamPeer(remoteId, 'cam-sender')
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    sendWS({ type: 'offer', to: remoteId, payload: { ...offer, kind: 'webcam' } })
  } catch (err) {
    console.warn('[CAM] Falha ao ofertar câmera para', remoteId, err)
  }
}

/* Reconexão: o user_id é regerado a cada conexão (ver CLAUDE.md), então o
   servidor não sabe mais que eu estou com a câmera ligada, e todas as
   conexões de câmera caíram junto com o socket. A captura em si continua
   viva — como o microfone, não faz sentido pedir permissão de novo. Aqui é
   só reanunciar e reofertar pra sala inteira. */
export function reannounceCamera() {
  if (!state.cameraOn || !state.localCamStream) return
  sendWS({ type: 'start-camera' })
  for (const uid of Object.keys(state.users)) offerCameraTo(uid)
  renderCameraStrip()
  appLog('INFO', 'Câmera reanunciada após reconexão')
}

export async function handleCamOffer(fromId, payload) {
  const pc = createCamPeer(fromId, 'cam-viewer')
  await pc.setRemoteDescription(new RTCSessionDescription({ type: payload.type, sdp: payload.sdp }))
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  sendWS({ type: 'answer', to: fromId, payload: { ...answer, kind: 'webcam' } })
}

export async function handleCamAnswer(fromId, payload) {
  // Só a conexão em que EU envio fica esperando uma answer.
  const pc = state.camPeers[fromId]
  if (!pc) return
  await pc.setRemoteDescription(new RTCSessionDescription({ type: payload.type, sdp: payload.sdp }))
}

export async function handleCamIceCandidate(fromId, payload) {
  // payload.role é o papel de QUEM ENVIOU. Pra mim o candidato é da conexão
  // oposta: se ele mandou como 'cam-sender' (ele enviando a câmera dele),
  // esse candidato pertence à MINHA conexão de cam-viewer com ele.
  const pc = payload?.role === 'cam-sender'
    ? state.camViewPeers[fromId]
    : state.camPeers[fromId]
  if (!pc) {
    console.warn('[CAM ICE] Peer não encontrado para', fromId, payload?.role)
    return
  }
  try {
    noteRemoteCandidate(pc, payload.candidate)
    await pc.addIceCandidate(new RTCIceCandidate(payload.candidate))
  } catch (err) {
    console.warn('[CAM ICE ERROR]', err)
  }
}

export function closeCamPeer(uid) {
  state.camPeers[uid]?.close()
  delete state.camPeers[uid]
}

// "Fechar a câmera de alguém" — para de RECEBER a câmera daquela pessoa,
// só pra mim. Não desliga a câmera dela nem avisa ninguém: é o equivalente
// do "parar de assistir" da tela, e por isso usa o mesmo ícone.
//
// Ela continua transmitindo pros outros; se ela desligar e religar a
// câmera, a oferta nova chega e o tile volta a aparecer aqui — o que é o
// comportamento desejado, porque aí é uma transmissão nova.
export function hideCameraOf(uid) {
  closeCamViewPeer(uid)
  renderCameraStrip()
  appLog('INFO', `Câmera de ${uid.slice(0, 8)} fechada localmente`)
}

export function closeCamViewPeer(uid) {
  state.camViewPeers[uid]?.close()
  delete state.camViewPeers[uid]
  delete state.camStreams[uid]
  if (state.stagedCamId === uid) state.stagedCamId = null
  removeCameraTile(uid)
}

// Alguém desligou a câmera (ou saiu da sala): derruba os dois sentidos.
// A conexão em que EU enviava pra essa pessoa também não serve mais se ela
// saiu — quem só desligou a câmera continua recebendo a minha normalmente,
// por isso o segundo parâmetro.
export function cleanupCameraForUser(uid, alsoStopSending = false) {
  closeCamViewPeer(uid)
  if (alsoStopSending) closeCamPeer(uid)
  renderCameraStrip()
}

/* ═══════════════════════════════════════════════════════════════
   SELEÇÃO DE DISPOSITIVO — Configurações → Vídeo
   Trocar de câmera com ela já ligada refaz a captura e reoferta pra todo
   mundo: como cada espectador tem sua própria conexão só de recebimento,
   é mais simples (e igualmente rápido) do que costurar replaceTrack em
   cada uma delas.
═══════════════════════════════════════════════════════════════ */
export async function populateCameraSelect() {
  const select = $('select-camera')
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const cams = devices.filter(d => d.kind === 'videoinput')

    select.innerHTML = '<option value="">Padrão do sistema</option>'
    cams.forEach((cam, i) => {
      const opt = document.createElement('option')
      opt.value = cam.deviceId
      // O label só vem preenchido depois de a permissão de câmera ter sido
      // concedida uma vez — antes disso o navegador devolve string vazia.
      opt.textContent = cam.label || `Câmera ${i + 1}`
      select.appendChild(opt)
    })
    select.value = state.camDeviceId
  } catch (err) {
    console.warn('[CAM] Falha ao listar câmeras:', err)
  }
}

$('select-camera').onchange = async () => {
  state.camDeviceId = $('select-camera').value
  localStorage.setItem(CAM_DEVICE_KEY, state.camDeviceId)
  if (!state.cameraOn) return

  // Reinicia a captura na câmera nova. stopCamera avisa a sala, startCamera
  // avisa de novo e reoferta — um piscar curto pra quem está vendo, mas sem
  // nenhum estado inconsistente.
  stopCamera()
  await startCamera()
}

// Aviso sonoro quando alguém liga a câmera (placeholder, ver core/sounds.js)
export function playCameraSound() {
  playSound('camera-on')
}
