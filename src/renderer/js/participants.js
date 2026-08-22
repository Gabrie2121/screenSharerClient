import { $ } from './core/dom.js'
import { state } from './core/state.js'
import { toggleWatch, closeWatchPeer, closeSharePeer } from './webrtc/screen-share-peers.js'
import { closeVoicePeer } from './voice/peers.js'
import { toggleParticipantVolumePopover, closeParticipantVolumePopoverIfOpenFor, getParticipantVolume } from './voice/volume.js'
import { removeStreamCard } from './stream-cards.js'

/* ═══════════════════════════════════════════════════════════════
   PARTICIPANTES — RENDER
═══════════════════════════════════════════════════════════════ */
export function renderParticipants() {
  const list = $('participants-list')
  // Se a lista for reconstruída com a prévia de alguém aberta (ex.: outra
  // pessoa entrou/saiu bem nesse momento), o <li> antigo some do DOM sem
  // disparar mouseleave — sem isso, o intervalo do preview ficava rodando
  // pra sempre. hideParticipantPreview() limpa antes de reconstruir tudo.
  hideParticipantPreview()
  list.innerHTML = ''

  // Eu mesmo
  const meLi = makeParticipantItem(state.myId, state.myName, state.sharing, true)
  list.appendChild(meLi)

  // Outros
  for (const [uid, u] of Object.entries(state.users)) {
    const li = makeParticipantItem(uid, u.username, u.sharing, false)
    list.appendChild(li)
  }
}

function makeParticipantItem(uid, name, sharing, isMe) {
  const li = document.createElement('li')
  li.className = 'participant-item'
  li.dataset.uid = uid

  const initial = name[0]?.toUpperCase() || '?'
  const statusText = sharing
    ? (isMe ? '● Live' : '● Live')
    : (isMe ? 'Você' : '● Online')

  const watching   = state.watching.has(uid)
  const connecting = state.connecting.has(uid)
  const watchLabel = connecting ? 'Conectando…' : (watching ? 'Parar de assistir' : 'Assistir')

  const vol = getParticipantVolume(uid)

  li.innerHTML = `
    <div class="participant-avatar">${initial}</div>
    <div class="participant-info">
      <div class="participant-name">${name}${isMe ? ' (você)' : ''}</div>
      <div class="participant-status ${sharing ? 'sharing' : ''}">${statusText}</div>
    </div>
    ${!isMe
      ? `<span class="participant-vol-indicator" title="Volume: ${vol}% — clique para ajustar">${vol === 0 ? '🔇' : (vol > 100 ? '📢' : '🔊')}</span>`
      : ''}
    ${(!isMe && sharing)
      ? `<button class="btn-watch ${watching ? 'watching' : ''} ${connecting ? 'connecting' : ''}" data-uid="${uid}">
           ${watchLabel}
         </button>`
      : ''}
  `

  const watchBtn = li.querySelector('.btn-watch')
  if (watchBtn) {
    watchBtn.onclick = (e) => {
      e.stopPropagation() // não deixa isso também abrir o popover de volume (ver abaixo)
      toggleWatch(uid)
    }
  }

  // Clicar em qualquer parte do participante (menos o botão de assistir)
  // abre/fecha o popover de volume do chat de voz (ver
  // openParticipantVolumePopover — mesmo slider usado nos cards de stream).
  if (!isMe) {
    li.addEventListener('click', () => toggleParticipantVolumePopover(uid, li))
  }

  // Prévia ao passar o mouse — só funciona pra quem você já está
  // assistindo (reaproveita o frame que já está decodificando, sem custo
  // de rede nenhum). Pra quem você ainda não assiste, mostra uma dica em
  // vez de tentar simular uma prévia de verdade (exigiria abrir uma
  // conexão WebRTC só pra isso, que não seria "leve").
  if (!isMe && sharing) {
    li.addEventListener('mouseenter', () => showParticipantPreview(uid, li))
    li.addEventListener('mouseleave', hideParticipantPreview)
  }

  return li
}

let participantPreviewTimer = null

function showParticipantPreview(uid, li) {
  const preview = $('participant-preview')
  const rect = li.getBoundingClientRect()
  preview.style.left = `${rect.right + 8}px`
  preview.style.top = `${rect.top}px`
  preview.classList.remove('hidden')

  const canvas = $('participant-preview-canvas')
  const emptyMsg = $('participant-preview-empty')
  const ctx = canvas.getContext('2d')
  clearInterval(participantPreviewTimer)

  // Já assistindo — usa o frame ao vivo, mais fiel e atualiza rápido.
  const video = document.querySelector(`.stream-card[data-stream="${uid}"] video`)
  if (video && state.remoteStreams[uid]) {
    canvas.classList.remove('hidden')
    emptyMsg.classList.add('hidden')
    const draw = () => {
      try { ctx.drawImage(video, 0, 0, canvas.width, canvas.height) } catch { /* frame ainda não pronto */ }
    }
    draw()
    participantPreviewTimer = setInterval(draw, 1500) // só uma prévia, não precisa ser fluida
    return
  }

  // Não assistindo — cai pro último snapshot que essa pessoa mandou pra
  // sala (atualiza ao começar a compartilhar e a cada 3min, ver
  // captureAndSendSnapshot). É uma imagem estática, sem intervalo.
  const snapshot = state.screenSnapshots[uid]
  if (snapshot) {
    canvas.classList.remove('hidden')
    emptyMsg.classList.add('hidden')
    const img = new Image()
    img.onload = () => { try { ctx.drawImage(img, 0, 0, canvas.width, canvas.height) } catch {} }
    img.src = snapshot
    return
  }

  canvas.classList.add('hidden')
  emptyMsg.classList.remove('hidden')
}

function hideParticipantPreview() {
  clearInterval(participantPreviewTimer)
  participantPreviewTimer = null
  $('participant-preview')?.classList.add('hidden')
}

export function removeUser(uid) {
  delete state.users[uid]
  state.watching.delete(uid)
  state.connecting.delete(uid)
  delete state.screenSnapshots[uid]
  closeWatchPeer(uid)
  closeSharePeer(uid)
  closeVoicePeer(uid)
  delete state.participantVolumes[uid]
  delete state.participantLastVolume[uid]
  closeParticipantVolumePopoverIfOpenFor(uid)
  removeStreamCard(uid)
  renderParticipants()
}
