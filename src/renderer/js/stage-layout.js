import { $ } from './core/dom.js'
import { state } from './core/state.js'

/* ═══════════════════════════════════════════════════════════════
   FOCO — uma stream em destaque, as demais minimizadas
═══════════════════════════════════════════════════════════════ */
export function toggleFocus(uid) {
  state.focusedId = state.focusedId === uid ? null : uid
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
      btn.textContent = isFs ? '⤬' : '⛶'
      btn.title = isFs ? 'Sair da tela cheia' : 'Tela cheia'
    }
  })
  clearTimeout(hideControlsTimer)
  clearTimeout(hideHeadersTimer)
  $('streams-grid').classList.remove('headers-hidden')
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
  const grid = $('streams-grid')
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

export function updateGridLayout() {
  const grid = $('streams-grid')
  const cards = Array.from(grid.querySelectorAll('.stream-card'))

  if (cards.length === 0) {
    grid.className = 'streams-grid hidden'
    $('stage-empty').classList.remove('hidden')
    return
  }

  $('stage-empty').classList.add('hidden')
  grid.classList.remove('hidden')

  // Se a stream em foco não existe mais, limpa o foco
  if (state.focusedId && !cards.some(c => c.dataset.stream === state.focusedId)) {
    state.focusedId = null
  }

  if (state.focusedId) {
    grid.className = 'streams-grid has-focus'
    cards.forEach(c => {
      const isFocused = c.dataset.stream === state.focusedId
      c.classList.toggle('focused', isFocused)
      c.classList.toggle('minimized', !isFocused)
    })
  } else {
    grid.className = `streams-grid count-${Math.min(cards.length, 4)}`
    cards.forEach(c => c.classList.remove('focused', 'minimized'))
  }
}
