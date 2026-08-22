import { RnnoiseWorkletNode, loadRnnoise } from '../../../../node_modules/@sapphi-red/web-noise-suppressor/dist/index.js'
import { $ } from '../core/dom.js'
import { appLog } from '../core/logger.js'
import { state, NOISE_SUPPRESSION_KEY, NOISE_INTENSITY_KEY } from '../core/state.js'
import { switchMicDevice } from './mic.js'

/* ═══════════════════════════════════════════════════════════════
   SUPRESSÃO DE RUÍDO (RNNoise) — processa a captura local do microfone
   antes de sair pela rede. Usada por voice/mic.js (ensureLocalMicStream/
   switchMicDevice).
═══════════════════════════════════════════════════════════════ */
let noiseContext = null
let noiseSource = null
let noiseNode = null
let noiseDestination = null
let noiseDryDelay = null
let noiseDryGain = null
let noiseWetGain = null
let noiseSetupPromise = null

export async function createNoiseSuppressedStream(inputStream) {
  if (!state.noiseSuppression || !noiseContext?.audioWorklet) return inputStream

  try {
    noiseSource = noiseContext.createMediaStreamSource(inputStream)
    noiseNode = new RnnoiseWorkletNode(noiseContext, {
      maxChannels: 1,
      wasmBinary: await loadRnnoise({
        url: new URL('../../../../node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise.wasm', import.meta.url).href,
        simdUrl: new URL('../../../../node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise_simd.wasm', import.meta.url).href,
      }),
    })
    noiseDryGain = noiseContext.createGain()
    noiseWetGain = noiseContext.createGain()
    noiseDestination = noiseContext.createMediaStreamDestination()
    // RNNoise processa em quadros fixos de 480 amostras a 48kHz (10ms) — o
    // caminho "molhado" (filtrado) sai atrasado esse tanto em relação ao
    // "seco" (original). Sem compensar, misturar os dois na intensidade
    // padrão (ver updateNoiseIntensity, que nunca zera o seco) somava o
    // mesmo áudio dessincronizado — ouvido como eco/flanger. Esse
    // DelayNode alinha o seco ao mesmo atraso antes de somar.
    noiseDryDelay = noiseContext.createDelay(0.05)
    noiseDryDelay.delayTime.value = 0.01
    noiseSource.connect(noiseDryDelay)
    noiseDryDelay.connect(noiseDryGain)
    noiseDryGain.connect(noiseDestination)
    noiseSource.connect(noiseNode)
    noiseNode.connect(noiseWetGain)
    noiseWetGain.connect(noiseDestination)
    updateNoiseIntensity()
    appLog('INFO', 'RNNoise ativado para o microfone')
    return noiseDestination.stream
  } catch (err) {
    appLog('WARN', `RNNoise indisponível, usando áudio original: ${err.message}`)
    destroyNoiseSuppression()
    return inputStream
  }
}

export async function prepareNoiseSuppression() {
  if (!state.noiseSuppression) return
  if (!noiseSetupPromise) {
    noiseSetupPromise = (async () => {
      noiseContext = new AudioContext({ sampleRate: 48000 })
      await noiseContext.audioWorklet.addModule(new URL('../../../../node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise/workletProcessor.js', import.meta.url).href)
    })().catch((err) => {
      noiseSetupPromise = null
      noiseContext?.close()
      noiseContext = null
      throw err
    })
  }
  await noiseSetupPromise
}

export function destroyNoiseSuppression() {
  noiseSource?.disconnect()
  noiseNode?.disconnect()
  noiseNode?.destroy()
  noiseDryDelay?.disconnect()
  noiseContext?.close()
  noiseSource = null
  noiseNode = null
  noiseDestination = null
  noiseDryDelay = null
  noiseDryGain = null
  noiseWetGain = null
  noiseContext = null
  noiseSetupPromise = null
}

function updateNoiseIntensity() {
  if (!noiseContext || !noiseDryGain || !noiseWetGain) return
  const intensity = Math.max(0, Math.min(100, state.noiseIntensity)) / 100
  noiseDryGain.gain.setTargetAtTime(1.2 * (1 - intensity), noiseContext.currentTime, 0.015)
  noiseWetGain.gain.setTargetAtTime(1.2 + intensity * 0.35, noiseContext.currentTime, 0.015)
}

/* ── Configurações → Áudio: toggle + intensidade da supressão ── */
const chkNoiseSuppression = $('chk-noise-suppression')
chkNoiseSuppression.checked = state.noiseSuppression
chkNoiseSuppression.onchange = async () => {
  state.noiseSuppression = chkNoiseSuppression.checked
  localStorage.setItem(NOISE_SUPPRESSION_KEY, String(state.noiseSuppression))
  if (state.localMicStream) await switchMicDevice(state.micDeviceId)
}

const noiseSuppressionSlider = $('noise-suppression-slider')
const noiseSuppressionValue = $('noise-suppression-value')
noiseSuppressionSlider.value = state.noiseIntensity
noiseSuppressionValue.value = `${state.noiseIntensity}%`
noiseSuppressionSlider.addEventListener('input', () => {
  state.noiseIntensity = Number(noiseSuppressionSlider.value)
  noiseSuppressionValue.value = `${state.noiseIntensity}%`
  localStorage.setItem(NOISE_INTENSITY_KEY, String(state.noiseIntensity))
  updateNoiseIntensity()
})
