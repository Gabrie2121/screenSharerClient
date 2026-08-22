import { $ } from '../core/dom.js'
import { appLog } from '../core/logger.js'
import { toast } from '../core/toast.js'
import { state, SPEAKER_DEVICE_KEY } from '../core/state.js'
import { switchMicDevice } from './mic.js'
import { applyOutputDevice, applyVoiceContextOutputDevice, getVoiceAudioContext } from './audio-context.js'

/* ═══════════════════════════════════════════════════════════════
   DISPOSITIVOS DE ÁUDIO (Configurações → Áudio)
═══════════════════════════════════════════════════════════════ */
export async function populateAudioDeviceSelects() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const mics = devices.filter(d => d.kind === 'audioinput')
    const outputs = devices.filter(d => d.kind === 'audiooutput')

    const micSelect = $('select-mic')
    micSelect.innerHTML = '<option value="">Padrão do sistema</option>'
      + mics.map(d => `<option value="${d.deviceId}">${d.label || 'Microfone'}</option>`).join('')
    micSelect.value = state.micDeviceId || ''

    // setSinkId (escolher saída) só existe em navegadores baseados em
    // Chromium — esconde o seletor quando não suportado em vez de mostrar
    // uma opção que não faz nada.
    const outRow = $('select-speaker').closest('.settings-row')
    if (typeof HTMLMediaElement.prototype.setSinkId === 'function' && outputs.length) {
      outRow.classList.remove('hidden')
      const outSelect = $('select-speaker')
      outSelect.innerHTML = '<option value="">Padrão do sistema</option>'
        + outputs.map(d => `<option value="${d.deviceId}">${d.label || 'Saída de áudio'}</option>`).join('')
      outSelect.value = state.speakerDeviceId || ''
    } else {
      outRow.classList.add('hidden')
    }
  } catch (err) {
    appLog('WARN', `Falha ao listar dispositivos de áudio: ${err.message}`)
  }
}

// Atualiza a lista quando um dispositivo é plugado/removido enquanto o
// modal está aberto.
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (!$('modal-settings').classList.contains('hidden')) populateAudioDeviceSelects()
})

$('select-mic').addEventListener('change', async () => {
  await switchMicDevice($('select-mic').value)
})

$('select-speaker').addEventListener('change', async () => {
  state.speakerDeviceId = $('select-speaker').value
  localStorage.setItem(SPEAKER_DEVICE_KEY, state.speakerDeviceId)
  // Aplica no áudio de cada participante já conectado, no áudio de teste e
  // no AudioContext (áudio amplificado — ver applyVoiceContextOutputDevice).
  await Promise.all(Object.values(state.voiceAudioEls).map(applyOutputDevice))
  await applyOutputDevice($('mic-test-audio'))
  await applyVoiceContextOutputDevice()
})

/* ═══════════════════════════════════════════════════════════════
   TESTAR MICROFONE E SAÍDA (loopback local, com medidor de nível)
═══════════════════════════════════════════════════════════════ */
let micTestStream = null
let micTestAnalyser = null
let micTestRAF = null

$('btn-test-mic').onclick = () => {
  if (micTestStream) stopMicTest()
  else startMicTest()
}

async function startMicTest() {
  try {
    const constraints = { audio: state.micDeviceId ? { deviceId: { exact: state.micDeviceId } } : true }
    micTestStream = await navigator.mediaDevices.getUserMedia(constraints)

    const audioEl = $('mic-test-audio')
    audioEl.srcObject = micTestStream
    audioEl.muted = false
    // HTMLMediaElement.volume só aceita 0–1 — o volume geral fica travado
    // em 0-100% (ver state.masterVolume), mas o Math.min é uma rede de
    // segurança pra não derrubar o teste com "IndexSizeError: value must
    // be in [0, 1]" caso sobre algum valor antigo >100 salvo no navegador.
    audioEl.volume = Math.min(1, state.masterVolume / 100)
    await applyOutputDevice(audioEl)
    await audioEl.play().catch(() => {})

    const ctx = getVoiceAudioContext()
    const source = ctx.createMediaStreamSource(micTestStream)
    micTestAnalyser = ctx.createAnalyser()
    micTestAnalyser.fftSize = 256
    source.connect(micTestAnalyser)

    $('btn-test-mic').textContent = 'Parar teste'
    $('mic-test-meter').classList.remove('hidden')
    runMicTestMeter()
  } catch (err) {
    appLog('WARN', `Falha ao testar microfone: ${err.message}`)
    toast('Não foi possível acessar o microfone para o teste.')
  }
}

function runMicTestMeter() {
  if (!micTestAnalyser) return
  const data = new Uint8Array(micTestAnalyser.fftSize)
  micTestAnalyser.getByteTimeDomainData(data)
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128
    sum += v * v
  }
  const rms = Math.sqrt(sum / data.length)
  $('mic-test-meter-fill').style.width = `${Math.min(100, Math.round(rms * 220))}%`
  micTestRAF = requestAnimationFrame(runMicTestMeter)
}

export function stopMicTest() {
  cancelAnimationFrame(micTestRAF)
  micTestRAF = null
  micTestAnalyser = null
  micTestStream?.getTracks().forEach(t => t.stop())
  micTestStream = null

  const audioEl = $('mic-test-audio')
  audioEl.pause()
  audioEl.srcObject = null

  $('btn-test-mic').textContent = 'Testar microfone e saída'
  $('mic-test-meter').classList.add('hidden')
  $('mic-test-meter-fill').style.width = '0%'
}
