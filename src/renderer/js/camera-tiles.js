import { $ } from './core/dom.js'
import { iconSvg } from './core/icons.js'
import { state } from './core/state.js'
import { hideCameraOf } from './webrtc/camera.js'
import { toggleFocus, updateGridLayout, tileKey } from './stage-layout.js'

/* ═══════════════════════════════════════════════════════════════
   TILES DE CÂMERA

   Um tile por câmera ligada (a sua inclusive), dentro do MESMO grid das
   telas compartilhadas (`#stage-grid`) — os dois tipos dividem o layout e
   o mesmo tamanho, como numa chamada em grupo.

   Antes as câmeras viviam numa faixa horizontal separada no topo do palco,
   e um clique "promovia" uma delas pra um card grande próprio
   (`state.stagedCamId` + `#camera-stage`). Eram três lugares diferentes
   pra mesma coisa — faixa, palco de câmera e grid de telas —, cada um com
   sua própria regra de tamanho. Agora é um lugar só: quem quer ver algo
   grande clica no tile e ele entra em foco, exatamente como uma tela
   (ver toggleFocus em js/stage-layout.js).
═══════════════════════════════════════════════════════════════ */

export function renderCameraTiles() {
  const grid = $('stage-grid')

  // { uid: stream } de tudo que deve aparecer — a minha vem do
  // localCamStream, as dos outros das conexões de recebimento.
  const entries = []
  // A própria câmera no palco é opcional (Configurações → Vídeo) — desligar
  // só esconde o tile daqui; a câmera continua ligada e sendo enviada.
  if (state.cameraOn && state.localCamStream && state.showSelfCamera) {
    entries.push({ uid: state.myId, stream: state.localCamStream, isMe: true })
  }
  for (const [uid, stream] of Object.entries(state.camStreams)) {
    entries.push({ uid, stream, isMe: false })
  }

  // Remove tiles de quem não está mais na lista
  grid.querySelectorAll('.camera-tile').forEach(tile => {
    if (!entries.some(e => e.uid === tile.dataset.cam)) tile.remove()
  })

  entries.forEach(({ uid, stream, isMe }) => upsertTile(grid, uid, stream, isMe))

  // Quem decide contagem de colunas, foco e o estado vazio do palco é o
  // layout — e agora a conta inclui as câmeras.
  updateGridLayout()
}

function upsertTile(grid, uid, stream, isMe) {
  let tile = grid.querySelector(`[data-cam="${uid}"]`)

  if (!tile) {
    tile = document.createElement('div')
    tile.className = 'camera-tile'
    tile.dataset.cam = uid
    // Chave de foco compartilhada com as telas: quem compartilha a tela E
    // está com a câmera ligada tem DOIS tiles, então o uid sozinho não
    // identifica qual dos dois está em foco.
    tile.dataset.tile = tileKey('cam', uid)
    tile.innerHTML = `
      <video autoplay playsinline muted></video>
      <span class="camera-tile-name"></span>
      <button type="button" class="camera-tile-close" title="Fechar esta câmera">${iconSvg('close')}</button>
    `
    // A câmera nunca carrega áudio (getUserMedia com audio: false, ver
    // js/webrtc/camera.js), então `muted` aqui é só garantia — e é o que
    // permite o autoplay passar sem gesto do usuário.
    tile.addEventListener('click', () => toggleFocus(tile.dataset.tile))

    // Fechar é só pra câmera DOS OUTROS: a própria se desliga no botão da
    // sidebar, que também libera o dispositivo — fechar o tile daria a
    // impressão errada de que a câmera parou de ser transmitida.
    const closeBtn = tile.querySelector('.camera-tile-close')
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation() // senão o clique também colocaria o tile em foco
      hideCameraOf(uid)
    })

    grid.appendChild(tile)
  }

  // A própria imagem vai espelhada — convenção de videochamada: a pessoa
  // se vê como num espelho. Só a PRÓPRIA; as dos outros não, senão texto
  // na mão delas apareceria invertido.
  tile.classList.toggle('mirrored', isMe)
  tile.querySelector('.camera-tile-close').classList.toggle('hidden', isMe)

  const name = isMe ? `${state.myName} (você)` : (state.users[uid]?.username || 'Usuário')
  tile.querySelector('.camera-tile-name').textContent = name
  tile.title = state.focusedId === tile.dataset.tile
    ? `${name} — clique para sair do foco`
    : `${name} — clique para ver grande`

  attachStream(tile.querySelector('video'), stream)
  return tile
}

// Só troca o srcObject quando mudou de verdade — atribuir a mesma stream de
// novo reinicia o play() e faz a imagem piscar a cada re-render (e o
// re-render acontece toda vez que alguém entra, sai ou liga a câmera).
function attachStream(video, stream) {
  if (video.srcObject === stream) return
  video.srcObject = stream
  video.play().catch(() => {})
}

export function removeCameraTile(uid) {
  const tile = $('stage-grid').querySelector(`[data-cam="${uid}"]`)
  if (!tile) return
  if (state.focusedId === tile.dataset.tile) state.focusedId = null
  tile.remove()
  updateGridLayout()
}
