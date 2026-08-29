import { appLog } from '../core/logger.js'
import { toast } from '../core/toast.js'
import { playSound } from '../core/sounds.js'
import { state } from '../core/state.js'
import { ICE_CONFIG } from '../core/ice-config.js'
import { attachIceDebug, noteRemoteCandidate } from '../core/ice-debug.js'
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

    // Se createOffer/setLocalDescription estourar, o timeout abaixo nunca
    // chegaria a ser armado e o botão ficaria em "Conectando…" pra sempre —
    // o mesmo sintoma que o timeout existe justamente pra evitar.
    try {
      await startPeerConnection(uid)
    } catch (err) {
      appLog('ERROR', `Falha ao iniciar conexão com ${uid}: ${err.message}`)
      state.watching.delete(uid)
      state.connecting.delete(uid)
      closeWatchPeer(uid)
      renderParticipants()
      toast('Não foi possível iniciar a conexão. Tente assistir de novo.')
      return
    }

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
  appLog('INFO', `[SHARE] offer enviada para ${remoteId.slice(0, 8)} — ${sdpDirections(offer.sdp)}`)

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
  attachIceDebug(pc, `tela/${role} ${remoteId.slice(0, 8)}`)

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
      // Sem adivinhar a causa: 'failed' cobre ICE que não fechou, DTLS que
      // não subiu e o outro lado que sumiu. A mensagem antiga afirmava que
      // era "ICE nem via TURN", o que mandou uma investigação inteira pro
      // lado errado enquanto o bug real estava no msid do SDP. Quem diz o
      // que aconteceu de fato é o [ICE ...] de core/ice-debug.js, logo acima
      // desta linha no log.
      appLog('WARN', `Conexão (${role}) com ${remoteId} entrou em 'failed'`
        + ' — ver a linha [ICE ...] acima para a causa')

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

      // e.streams[0] só vem preenchido quando o SDP do outro lado traz
      // `a=msid`, e msid só existe quando o track foi anexado com
      // addTrack(track, stream). Um sender montado apenas com
      // replaceTrack() (transceiver criado pelo setRemoteDescription) não
      // gera msid nenhum, e aqui chegava e.streams VAZIO.
      //
      // Antes isso caía num `return` mudo: o track chegava, o ICE estava
      // conectado, e mesmo assim o botão ficava "Conectando…" até o
      // timeout de 25s, sem nada no log explicando. Agora, na falta de
      // msid, a stream é montada aqui — e tracks que chegam depois
      // (áudio depois do vídeo) entram na MESMA stream, senão o card
      // trocaria de srcObject no meio e perderia a imagem.
      let stream = e.streams[0]
      if (!stream) {
        stream = state.remoteStreams[remoteId] || new MediaStream()
        if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track)
        appLog('INFO', `[SHARE] track de ${e.track.kind} sem msid de ${remoteId.slice(0, 8)}`
          + ' — stream remontada localmente')
      }

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

  // Obs.: quem compartilha faz o addTrack em handleOffer, não aqui — precisa
  // ser com a state.localStream junto (pelo msid, ver o comentário lá) e
  // antes do setRemoteDescription.
  return pc
}

/* ═══════════════════════════════════════════════════════════════
   FORMA FIXA DA CONEXÃO DE QUEM COMPARTILHA
   Toda conexão de sharer nasce com um sender de vídeo E um de áudio, mesmo
   quando a captura escolhida é "Sem som" — nesse caso o sender de áudio fica
   com track nula.

   Por que: trocar de tela em transmissão (switchSource em capture.js) é feito
   com sender.replaceTrack(), que não exige renegociação. Só que replaceTrack
   precisa de um sender JÁ existente daquele kind; se a captura antiga não
   tinha áudio e a nova tem, não haveria sender de áudio pra substituir, e
   criar um exigiria uma renegociação que este protocolo não tem — quem
   compartilha é o answerer, não tem como ofertar (ver o contrato em
   CLAUDE.md: quem inicia a oferta de tela é sempre quem assiste).

   Isso funciona porque quem assiste sempre oferta com offerToReceiveAudio:
   true (ver startPeerConnection), então a m-line de áudio existe na offer e
   vira um transceiver aqui do lado. Só falta virá-lo pra 'sendonly' ANTES do
   createAnswer — os transceivers criados pelo setRemoteDescription nascem
   'recvonly', e uma answer recvonly contra uma offer recvonly negocia a
   m-line como inativa: o replaceTrack posterior não faria som nenhum sair.

   Reaproveitada na troca de tela: pôr a mesma direction que já está valendo
   é no-op e não dispara negotiationneeded, então dá pra chamar de novo com
   a conexão já estabelecida.
═══════════════════════════════════════════════════════════════ */
export async function applySharedStreamToPeer(pc, stream) {
  const wanted = {
    video: stream?.getVideoTracks()[0] || null,
    audio: stream?.getAudioTracks()[0] || null,
  }

  // Diagnóstico via appLog (que grava em disco), NÃO console.warn: uma falha
  // aqui aparece pro usuário só como "Conectando…" pra sempre, e um warn de
  // console não sobrevive pra contar a história depois.
  appLog('INFO', `[SHARE] montando conexão — transceivers: `
    + (pc.getTransceivers().map(t =>
        `${t.receiver?.track?.kind ?? '?'}/${t.direction}`).join(' ') || 'NENHUM'))

  for (const kind of ['video', 'audio']) {
    // O kind do transceiver vem do receiver: o sender pode estar sem track
    // nenhuma (justamente o caso do áudio numa captura "Sem som").
    const tr = pc.getTransceivers().find(t => t.receiver?.track?.kind === kind)
    if (!tr) {
      // Se isso acontecer com o VÍDEO, a conexão nasce morta: a answer sai
      // sem m-line de envio, o ontrack do outro lado nunca dispara e o
      // botão fica "Conectando…" até o timeout de 25s.
      appLog(wanted[kind] ? 'ERROR' : 'INFO',
        `[SHARE] sem transceiver de ${kind} nesta conexão`
        + (wanted[kind] ? ' — a tela NÃO será enviada' : ''))
      continue
    }

    tr.direction = 'sendonly'
    try {
      // Pula quando o addTrack de handleOffer já pôs exatamente este track:
      // substituir por ele mesmo é desperdício, e mexer à toa num sender já
      // negociado é justamente o tipo de coisa que quebra em silêncio.
      if (tr.sender.track !== wanted[kind]) await tr.sender.replaceTrack(wanted[kind])
      appLog('INFO', `[SHARE] ${kind}: direction=${tr.direction} `
        + `track=${tr.sender.track?.kind ?? 'null'} msid=${tr.sender.track ? 'sim' : 'n/a'}`)
    } catch (err) {
      appLog('ERROR', `[SHARE] replaceTrack de ${kind} falhou: ${err.name} ${err.message}`)
    }
  }
}

// Direções das m-lines de um SDP — é o que prova se a answer realmente
// oferece vídeo em envio. Sem isso a depuração vira adivinhação.
export function sdpDirections(sdp) {
  const res = []
  for (const line of (sdp || '').split(/\r?\n/)) {
    if (line.startsWith('m=')) res.push([line.slice(2).split(' ')[0], '?'])
    else if (/^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line) && res.length) {
      res[res.length - 1][1] = line.slice(2)
    }
  }
  return res.map(([k, d]) => `${k}:${d}`).join(' ') || '(sem m-lines)'
}

// Troca a tela transmitida em TODAS as conexões de quem me assiste, sem
// derrubar nenhuma delas (ver switchSource em capture.js). Como é só
// replaceTrack, quem assiste nem percebe a renegociação — a imagem troca no
// lugar, sem precisar clicar em "Assistir" de novo.
export async function replaceSharedStream(stream) {
  await Promise.all(
    Object.values(state.sharePeers).map(pc => applySharedStreamToPeer(pc, stream))
  )
  // A altura nativa mudou, então o scaleResolutionDownBy de cada espectador
  // foi calculado contra uma base que não vale mais.
  await reapplyAllViewerQuality()
}

/* ═══════════════════════════════════════════════════════════════
   AVISO DE "ALGUÉM ESTÁ TE ASSISTINDO"
   Toca alguns segundos DEPOIS da oferta chegar, não na hora: no instante
   da offer a conexão ainda está negociando ICE e pode nem completar (ver o
   timeout de 25s). Esperando, o som só sai quando a pessoa de fato já está
   te vendo — que é a informação que importa pra quem está compartilhando.

   Um timer por espectador, cancelado se a conexão morrer antes da hora
   (closeSharePeer) — senão o aviso tocaria pra alguém que desistiu.
═══════════════════════════════════════════════════════════════ */
const VIEWER_SOUND_DELAY_MS = 3000
const viewerSoundTimers = {}

function scheduleViewerSound(uid) {
  clearTimeout(viewerSoundTimers[uid])
  viewerSoundTimers[uid] = setTimeout(() => {
    delete viewerSoundTimers[uid]
    // Só avisa se a conexão sobreviveu até aqui.
    if (!state.sharePeers[uid]) return
    playSound('viewer-joined')
    const name = state.users[uid]?.username || 'Alguém'
    toast(`${name} está assistindo sua tela.`)
  }, VIEWER_SOUND_DELAY_MS)
}

function cancelViewerSound(uid) {
  clearTimeout(viewerSoundTimers[uid])
  delete viewerSoundTimers[uid]
}

// Recebe offer (alguém quer assistir minha tela) — eu respondo como sharer
export async function handleOffer(fromId, offer) {
  console.log('[OFFER recebida de]', fromId, '| sharing:', state.sharing)

  if (!state.sharing || !state.localStream) {
    console.warn('Recebi offer mas não estou compartilhando, ignorando.')
    return
  }

  const pc = createPeer(fromId, 'sharer')

  // addTrack COM a stream, antes do setRemoteDescription. Os dois detalhes
  // importam: é o addTrack (e não o replaceTrack) que escreve `a=msid` no
  // SDP, e é o msid que faz o e.streams[0] chegar preenchido no ontrack do
  // outro lado. Montar o sender só com replaceTrack depois do SRD gerava
  // uma answer sem msid — o ICE conectava, o vídeo chegava, e o ontrack de
  // quem assistia descartava tudo por não ter stream, deixando o botão em
  // "Conectando…" pra sempre. É o mesmo caminho que câmera e voz já usam.
  state.localStream.getTracks().forEach(track => pc.addTrack(track, state.localStream))

  await pc.setRemoteDescription(new RTCSessionDescription(offer))

  // Depois do SRD, completa a forma da conexão: garante o sender de áudio
  // mesmo quando a captura é "Sem som" (ver applySharedStreamToPeer), que é
  // o que permite trocar de tela depois sem renegociar.
  await applySharedStreamToPeer(pc, state.localStream)

  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)

  // A linha que responde tudo: se o vídeo aqui não estiver "sendonly", a
  // tela não vai sair, por mais que o ICE conecte.
  appLog('INFO', `[SHARE] answer para ${fromId.slice(0, 8)} — ${sdpDirections(answer.sdp)}`)
  sendWS({ type: 'answer', to: fromId, payload: answer })
  scheduleViewerSound(fromId)
}

export async function handleAnswer(fromId, answer) {
  console.log('[ANSWER recebido de]', fromId)
  // Só a minha conexão de watcher fica esperando uma answer.
  const pc = state.watchPeers[fromId]
  if (!pc) return
  appLog('INFO', `[SHARE] answer recebida de ${fromId.slice(0, 8)} — ${sdpDirections(answer?.sdp)}`)
  await pc.setRemoteDescription(new RTCSessionDescription(answer))
  // ontrack já deveria ter disparado neste ponto (em Unified Plan ele vem do
  // setRemoteDescription, antes de qualquer mídia fluir).
  appLog('INFO', `[SHARE] após aplicar answer de ${fromId.slice(0, 8)}: `
    + `stream recebida=${!!state.remoteStreams[fromId]}`)
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
    noteRemoteCandidate(pc, payload.candidate)
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
// Teto de banda por espectador. Os saltos acompanham a área da imagem:
// 1440p tem ~1,8x os pixels de 1080p, daí os 7 Mbps.
const QUALITY_BITRATE_KBPS = { 360: 600, 480: 1000, 720: 2500, 1080: 4000, 1440: 7000 }

export async function applyViewerQuality(viewerId, requestedHeight) {
  // Guarda o pedido ANTES de qualquer early return: ao trocar de tela em
  // transmissão a altura nativa muda e todos os pedidos precisam ser
  // recalculados contra a nova base (ver reapplyAllViewerQuality).
  state.viewerQuality[viewerId] = requestedHeight || null

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

// Reaplica o que cada espectador já tinha pedido, recalculado contra a
// altura nativa da captura atual (ver replaceSharedStream).
export async function reapplyAllViewerQuality() {
  await Promise.all(
    Object.keys(state.sharePeers).map(uid =>
      applyViewerQuality(uid, state.viewerQuality[uid] || null)
    )
  )
}

export function closeSharePeer(uid) {
  state.sharePeers[uid]?.close()
  delete state.sharePeers[uid]
  delete state.viewerQuality[uid]
  cancelViewerSound(uid)
}
