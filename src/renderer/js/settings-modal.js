import { $ } from './core/dom.js'
import {
  state, SELF_PREVIEW_KEY, DEFAULT_WATCH_QUALITY_KEY, AUTO_PIP_KEY,
  SOUNDS_ENABLED_KEY, SOUNDS_VOLUME_KEY,
} from './core/state.js'
import { previewSound } from './core/sounds.js'
import { populateCameraSelect } from './webrtc/camera.js'
import { setPipSource } from './auto-pip.js'
import { populateAudioDeviceSelects, stopMicTest } from './voice/device-settings.js'
import { updateSelfPreview } from './self-preview.js'

/* ═══════════════════════════════════════════════════════════════
   CONFIGURAÇÕES — modal com opções por seção (Áudio/Vídeo).
   Botão fica meio a meio com o de compartilhar na sidebar.
═══════════════════════════════════════════════════════════════ */
$('btn-settings').onclick = () => {
  $('modal-settings').classList.remove('hidden')
  populateAudioDeviceSelects()
  // Os labels das câmeras só vêm preenchidos depois de a permissão ter
  // sido concedida uma vez, então vale repopular a cada abertura em vez de
  // só no boot.
  populateCameraSelect()
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

/* ═══════════════════════════════════════════════════════════════
   AVISOS SONOROS — liga/desliga e volume (ver js/core/sounds.js)
═══════════════════════════════════════════════════════════════ */
const chkSounds = $('chk-sounds-enabled')
chkSounds.checked = state.soundsEnabled

chkSounds.onchange = () => {
  state.soundsEnabled = chkSounds.checked
  localStorage.setItem(SOUNDS_ENABLED_KEY, String(state.soundsEnabled))
  // Confirma na hora que voltou a tocar — desligar não toca nada, claro.
  if (state.soundsEnabled) previewSound()
}

const soundsSlider = $('sounds-volume-slider')
const soundsValue = $('sounds-volume-value')
soundsSlider.value = state.soundsVolume
soundsValue.textContent = `${state.soundsVolume}%`

soundsSlider.oninput = () => {
  state.soundsVolume = Number(soundsSlider.value)
  soundsValue.textContent = `${state.soundsVolume}%`
  localStorage.setItem(SOUNDS_VOLUME_KEY, String(state.soundsVolume))
}
// A prévia só toca ao SOLTAR o slider — a cada input seria um estouro de
// sons se sobrepondo enquanto se arrasta.
soundsSlider.onchange = () => previewSound()

// PiP automático ao minimizar — ligado por padrão (ver js/auto-pip.js).
const chkAutoPip = $('chk-auto-pip')
chkAutoPip.checked = state.autoPip

chkAutoPip.onchange = () => {
  state.autoPip = chkAutoPip.checked
  localStorage.setItem(AUTO_PIP_KEY, String(state.autoPip))
}

// O que o mini player mostra. Também é trocável ao vivo, com o app
// minimizado, pelos botões de faixa da janela do PiP (ver auto-pip.js).
const selPipSource = $('pip-source')
selPipSource.value = state.pipSource
selPipSource.onchange = () => setPipSource(selPipSource.value)

// Qualidade padrão ao assistir — aplicada de saída a cada nova live que
// você começa a assistir; a pessoa ainda pode trocar na hora, por live, no
// seletor do próprio card (ver stream-cards.js/upsertStreamCard).
const selDefaultWatchQuality = $('default-watch-quality')
selDefaultWatchQuality.value = state.defaultWatchQuality

selDefaultWatchQuality.onchange = () => {
  state.defaultWatchQuality = selDefaultWatchQuality.value
  localStorage.setItem(DEFAULT_WATCH_QUALITY_KEY, state.defaultWatchQuality)
}
