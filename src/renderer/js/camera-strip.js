import { $ } from './core/dom.js'
import { state } from './core/state.js'
import { hideCameraOf } from './webrtc/camera.js'

/* ═══════════════════════════════════════════════════════════════
   FAIXA DE CÂMERAS
   Tiles pequenos no topo do palco, um por câmera ligada (a sua inclusive).

   Por que uma faixa própria e não cards no #streams-grid: o grid é
   calibrado pra telas compartilhadas — tem foco/minimizado (state.focusedId),
   contagem count-1..4, zoom, seletor de qualidade por espectador. Câmera é
   uma imagenzinha 4:3 que fica ligada o tempo todo; jogá-la lá dentro faria
   uma webcam competir com uma tela pelo foco do palco e bagunçar a contagem
   do layout.

   Clicar num tile "promove" aquela câmera pro palco (state.stagedCamId),
   grande, pra quando alguém está mostrando algo pela câmera. Clicar de novo
   devolve pra faixa.
═══════════════════════════════════════════════════════════════ */

export function renderCameraStrip() {
  const strip = $('camera-strip')
  const stage = $('camera-stage')

  // { uid: stream } de tudo que deve aparecer — a minha vem do
  // localCamStream, as dos outros das conexões de recebimento.
  const entries = []
  if (state.cameraOn && state.localCamStream) {
    entries.push({ uid: state.myId, stream: state.localCamStream, isMe: true })
  }
  for (const [uid, stream] of Object.entries(state.camStreams)) {
    entries.push({ uid, stream, isMe: false })
  }

  strip.classList.toggle('hidden', entries.length === 0)

  // Se a câmera promovida ao palco sumiu (pessoa desligou ou saiu), devolve
  // o palco em vez de deixar um card preto pendurado.
  if (state.stagedCamId && !entries.some(e => e.uid === state.stagedCamId)) {
    state.stagedCamId = null
  }

  // Remove tiles de quem não está mais na lista
  strip.querySelectorAll('.camera-tile').forEach(tile => {
    if (!entries.some(e => e.uid === tile.dataset.cam)) tile.remove()
  })

  entries.forEach(({ uid, stream, isMe }) => {
    const tile = upsertTile(strip, uid, stream, isMe)
    // O tile da câmera promovida fica esmaecido na faixa, pra ficar claro
    // que ela está em outro lugar e o clique ali devolve.
    tile.classList.toggle('staged', state.stagedCamId === uid)
  })

  renderStagedCamera(stage, entries)
}

function upsertTile(strip, uid, stream, isMe) {
  let tile = strip.querySelector(`[data-cam="${uid}"]`)

  if (!tile) {
    tile = document.createElement('div')
    tile.className = 'camera-tile'
    tile.dataset.cam = uid
    tile.innerHTML = `
      <video autoplay playsinline muted></video>
      <span class="camera-tile-name"></span>
      <button type="button" class="camera-tile-close" title="Fechar esta câmera">✕</button>
    `
    // A câmera nunca carrega áudio (getUserMedia com audio: false, ver
    // js/webrtc/camera.js), então `muted` aqui é só garantia — e é o que
    // permite o autoplay passar sem gesto do usuário.
    tile.addEventListener('click', () => {
      state.stagedCamId = state.stagedCamId === uid ? null : uid
      renderCameraStrip()
    })

    // Fechar é só pra câmera DOS OUTROS: a própria se desliga no botão da
    // sidebar, que também libera o dispositivo — fechar o tile daria a
    // impressão errada de que a câmera parou de ser transmitida.
    const closeBtn = tile.querySelector('.camera-tile-close')
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation() // senão o clique também promoveria o tile ao palco
      hideCameraOf(uid)
    })

    strip.appendChild(tile)
  }

  // A própria imagem vai espelhada — convenção de videochamada: a pessoa
  // se vê como num espelho. Só a PRÓPRIA; as dos outros não.
  tile.classList.toggle('mirrored', isMe)
  tile.querySelector('.camera-tile-close').classList.toggle('hidden', isMe)

  const name = isMe ? `${state.myName} (você)` : (state.users[uid]?.username || 'Usuário')
  tile.querySelector('.camera-tile-name').textContent = name
  tile.title = state.stagedCamId === uid
    ? `${name} — clique para devolver à faixa`
    : `${name} — clique para ver grande`

  attachStream(tile.querySelector('video'), stream)
  return tile
}

// Card grande da câmera promovida ao palco.
function renderStagedCamera(stage, entries) {
  const entry = entries.find(e => e.uid === state.stagedCamId)
  stage.classList.toggle('hidden', !entry)
  if (!entry) {
    stage.querySelector('video').srcObject = null
    return
  }

  stage.classList.toggle('mirrored', entry.isMe)
  stage.querySelector('.camera-stage-name').textContent = entry.isMe
    ? `${state.myName} (você)`
    : (state.users[entry.uid]?.username || 'Usuário')
  attachStream(stage.querySelector('video'), entry.stream)
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
  $('camera-strip').querySelector(`[data-cam="${uid}"]`)?.remove()
}

// O palco de câmera divide espaço com o grid de telas — o botão fecha só a
// câmera grande, sem desligar câmera nenhuma.
$('camera-stage-close').onclick = (e) => {
  e.stopPropagation()
  state.stagedCamId = null
  renderCameraStrip()
}
