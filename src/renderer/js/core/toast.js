import { $ } from './dom.js'

/* ═══════════════════════════════════════════════════════════════
   TOASTS
   Os avisos sonoros que moravam aqui viraram um registro por nome em
   core/sounds.js (som ao começar E ao parar, ao entrar/sair gente, com
   liga/desliga e volume nas configurações).
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

export { showError, hideError, toast, toastTop }
