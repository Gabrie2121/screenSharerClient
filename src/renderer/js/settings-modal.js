import { $ } from './core/dom.js'
import { state, SELF_PREVIEW_KEY, DEFAULT_WATCH_QUALITY_KEY } from './core/state.js'
import { populateAudioDeviceSelects, stopMicTest } from './voice/device-settings.js'

/* ═══════════════════════════════════════════════════════════════
   CONFIGURAÇÕES — modal com opções por seção (Áudio/Vídeo).
   Botão fica meio a meio com o de compartilhar na sidebar.
═══════════════════════════════════════════════════════════════ */
$('btn-settings').onclick = () => {
  $('modal-settings').classList.remove('hidden')
  populateAudioDeviceSelects()
}
$('btn-close-settings').onclick = () => {
  $('modal-settings').classList.add('hidden')
  stopMicTest() // não deixa o loopback do teste de mic tocando escondido
}
$('modal-settings').onclick = (e) => {
  if (e.target === $('modal-settings')) {
    $('modal-settings').classList.add('hidden')
    stopMicTest()
  }
}

document.querySelectorAll('.settings-tab').forEach((tab) => {
  tab.onclick = () => {
    const selectedTab = tab.dataset.settingsTab
    document.querySelectorAll('.settings-tab').forEach((item) => {
      const isActive = item === tab
      item.classList.toggle('active', isActive)
      item.setAttribute('aria-selected', String(isActive))
    })
    document.querySelectorAll('.settings-panel').forEach((panel) => {
      const isActive = panel.id === `settings-${selectedTab}`
      panel.classList.toggle('active', isActive)
      panel.hidden = !isActive
    })
  }
})

// Autovisualização — opcional, canto inferior direito, sempre mudo.
// Preferência salva em localStorage e usada como padrão dali pra frente.
const chkSelfPreview = $('chk-self-preview')
chkSelfPreview.checked = state.showSelfPreview

chkSelfPreview.onchange = () => {
  state.showSelfPreview = chkSelfPreview.checked
  localStorage.setItem(SELF_PREVIEW_KEY, String(state.showSelfPreview))
  updateSelfPreview()
}

// Qualidade padrão ao assistir — aplicada de saída a cada nova live que
// você começa a assistir; a pessoa ainda pode trocar na hora, por live, no
// seletor do próprio card (ver stream-cards.js/upsertStreamCard).
const selDefaultWatchQuality = $('default-watch-quality')
selDefaultWatchQuality.value = state.defaultWatchQuality

selDefaultWatchQuality.onchange = () => {
  state.defaultWatchQuality = selDefaultWatchQuality.value
  localStorage.setItem(DEFAULT_WATCH_QUALITY_KEY, state.defaultWatchQuality)
}

export function updateSelfPreview() {
  const wrap = $('self-preview')
  const video = $('self-preview-video')
  const show = state.sharing && state.showSelfPreview && state.localStream

  wrap.classList.toggle('hidden', !show)

  if (!show) {
    video.srcObject = null
    return
  }

  // Sempre mudo — é só uma prévia local, nunca deve tocar som (o pedido
  // era explícito: "que não transmita som"). Não é enviada a ninguém, é a
  // mesma state.localStream que já vai pros outros participantes.
  video.muted = true
  if (video.srcObject !== state.localStream) {
    video.srcObject = state.localStream
    video.play().catch(() => {})
  }
}
