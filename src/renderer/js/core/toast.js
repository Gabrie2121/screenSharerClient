import { $ } from './dom.js'

/* ═══════════════════════════════════════════════════════════════
   TOASTS + AVISO SONORO
═══════════════════════════════════════════════════════════════ */
function showError(msg) {
  const el = $('login-error')
  el.textContent = msg
  el.classList.remove('hidden')
}

function hideError() { $('login-error').classList.add('hidden') }

let toastTimer = null
function toast(msg) {
  const t = $('toast')
  t.textContent = msg
  t.classList.add('show')
  t.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500)
}

// Toast de cima, com borda verde — separado do de baixo (que fica pra
// "alguém entrou"/erros/etc.) pra avisos de "alguém compartilhou a tela"
// não brigarem pelo mesmo espaço.
let toastTopTimer = null
function toastTop(msg) {
  const t = $('toast-top')
  t.textContent = msg
  t.classList.add('show')
  t.classList.remove('hidden')
  clearTimeout(toastTopTimer)
  toastTopTimer = setTimeout(() => t.classList.remove('show'), 3000)
}

// Aviso sonoro quando alguém começa a compartilhar — src/assets/holy.mp3
// (caminho relativo a este arquivo, src/renderer/js/core/toast.js). Fica em
// 40% do volume o tempo todo e corta em 1s — o arquivo original dura mais
// que isso, mas só precisamos do começo como aviso rápido.
const shareSound = new Audio('../../../assets/holy.mp3')
shareSound.volume = 0.4
let shareSoundCutTimer = null

function playShareSound() {
  try {
    shareSound.currentTime = 0
    shareSound.play().catch((err) => {
      console.warn('[SOM] Falha ao tocar aviso de compartilhamento:', err)
    })
    clearTimeout(shareSoundCutTimer)
    shareSoundCutTimer = setTimeout(() => {
      shareSound.pause()
      shareSound.currentTime = 0
    }, 1000)
  } catch (err) {
    console.warn('[SOM] Falha ao tocar aviso de compartilhamento:', err)
  }
}

export { showError, hideError, toast, toastTop, playShareSound }
