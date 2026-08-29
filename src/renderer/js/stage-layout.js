import { $ } from './core/dom.js'
import { setIcon } from './core/icons.js'
import { state } from './core/state.js'

/* ═══════════════════════════════════════════════════════════════
   PALCO — o grid único onde telas e câmeras convivem

   `#stage-grid` guarda os dois tipos de tile: `.stream-card` (tela
   compartilhada) e `.camera-tile` (webcam). Quem cria cada um é o seu
   próprio módulo (stream-cards.js / camera-tiles.js); aqui só se decide
   quantas colunas cabem e quem está em foco.

   FOCO: um tile grande, os demais numa tira menor embaixo. A chave do foco
   NÃO é o user id — quem compartilha a tela e está com a câmera ligada tem
   dois tiles ao mesmo tempo, e o uid sozinho não diria qual dos dois está
   em foco. Por isso `tileKey('screen'|'cam', uid)`.
═══════════════════════════════════════════════════════════════ */

export function tileKey(kind, uid) {
  return `${kind}:${uid}`
}

// Todos os tiles do palco, na ordem em que estão no DOM.
function allTiles(grid = $('stage-grid')) {
  return Array.from(grid.querySelectorAll('.stream-card, .camera-tile'))
}

export function toggleFocus(key) {
  state.focusedId = state.focusedId === key ? null : key
  updateGridLayout()
}

/* ═══════════════════════════════════════════════════════════════
   TELA CHEIA — sincroniza o botão de cada card e corrige o grid ao sair.
   Um card em :fullscreen sai do fluxo normal de layout enquanto ativo; sem
   recalcular o grid ao voltar, ele ficava com o layout desatualizado
   (bugado) até alguém entrar/sair da sala de novo.
═══════════════════════════════════════════════════════════════ */
document.addEventListener('fullscreenchange', () => {
  const fsCard = document.fullscreenElement
  document.querySelectorAll('.stream-card').forEach(c => {
    const isFs = c === fsCard
    c.classList.toggle('is-fullscreen', isFs)
    c.classList.remove('controls-hidden')
    const btn = c.querySelector('.fullscreen-btn')
    if (btn) {
      setIcon(btn, isFs ? 'fullscreen-exit' : 'fullscreen')
      btn.title = isFs ? 'Sair da tela cheia' : 'Tela cheia'
    }
  })
  clearTimeout(hideControlsTimer)
  clearTimeout(hideHeadersTimer)
  $('stage-grid').classList.remove('headers-hidden')
  if (fsCard) {
    resetControlsHideTimer()
  } else {
    resetHeadersHideTimer()
  }
  updateGridLayout()
})

// Some com o cabeçalho/controles da tela cheia depois de 3s sem o mouse se
// mexer (padrão de player de vídeo em fullscreen) — volta a aparecer no
// primeiro movimento.
let hideControlsTimer = null
function resetControlsHideTimer() {
  const fsCard = document.fullscreenElement
  if (!fsCard || !fsCard.classList.contains('stream-card')) return
  fsCard.classList.remove('controls-hidden')
  clearTimeout(hideControlsTimer)
  hideControlsTimer = setTimeout(() => {
    fsCard.classList.add('controls-hidden')
  }, 3000)
}
// Mesma ideia fora da tela cheia, só que 5s (não está tampando o vídeo,
// então não precisa sumir tão rápido) e escondendo só o cabeçalho (os
// controles de volume/qualidade fora do fullscreen já ficam junto do card
// normalmente, sem precisar desse tratamento).
let hideHeadersTimer = null
function resetHeadersHideTimer() {
  const grid = $('stage-grid')
  grid.classList.remove('headers-hidden')
  clearTimeout(hideHeadersTimer)
  hideHeadersTimer = setTimeout(() => {
    grid.classList.add('headers-hidden')
  }, 5000)
}

document.addEventListener('mousemove', () => {
  if (document.fullscreenElement) {
    resetControlsHideTimer()
  } else {
    resetHeadersHideTimer()
  }
})

/* ═══════════════════════════════════════════════════════════════
   QUANTAS COLUNAS
   A contagem inclui telas E câmeras, porque agora dividem o mesmo grid.
   As faixas (1, 2, 3-4, 5-6, resto) existem pra um tile nunca ficar
   pequeno à toa: com duas pessoas no ar, meia tela pra cada é melhor do
   que um quarto pra cada só porque o layout é fixo em 2x2.
═══════════════════════════════════════════════════════════════ */
function countClass(total) {
  if (total <= 1) return 'count-1'
  if (total === 2) return 'count-2'
  if (total <= 4) return 'count-4'
  if (total <= 6) return 'count-6'
  return 'count-many'
}

export function updateGridLayout() {
  const grid = $('stage-grid')
  const tiles = allTiles(grid)

  if (tiles.length === 0) {
    grid.className = 'stage-grid hidden'
    $('stage-empty').classList.remove('hidden')
    return
  }

  $('stage-empty').classList.add('hidden')
  grid.classList.remove('hidden')

  // Se o tile em foco não existe mais (a pessoa parou de compartilhar,
  // desligou a câmera ou saiu), limpa o foco em vez de deixar o grid
  // inteiro minimizado atrás de um destaque que não está lá.
  if (state.focusedId && !tiles.some(t => t.dataset.tile === state.focusedId)) {
    state.focusedId = null
  }

  if (state.focusedId) {
    grid.className = 'stage-grid has-focus'
    tiles.forEach(t => {
      const isFocused = t.dataset.tile === state.focusedId
      t.classList.toggle('focused', isFocused)
      t.classList.toggle('minimized', !isFocused)
    })
  } else {
    grid.className = `stage-grid ${countClass(tiles.length)}`
    tiles.forEach(t => t.classList.remove('focused', 'minimized'))
  }
}
