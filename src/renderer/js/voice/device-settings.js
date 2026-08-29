import { $ } from '../core/dom.js'
import { appLog } from '../core/logger.js'
import { toast } from '../core/toast.js'
import { state, SPEAKER_DEVICE_KEY } from '../core/state.js'
import { switchMicDevice, ensureLocalMicStream } from './mic.js'
import { applyOutputDevice, applyVoiceContextOutputDevice, getVoiceAudioContext } from './audio-context.js'
import { getLocalVoiceAnalyser } from './speaking-detection.js'

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
let micTestSource = null
let micTestOwnsStream = false
let micTestRAF = null

$('btn-test-mic').onclick = () => {
  if (micTestStream) stopMicTest()
  else startMicTest()
}

async function startMicTest() {
  try {
    // Testa a SAÍDA da cadeia de áudio (ver voice/noise-suppression.js) —
    // é exatamente o que os outros participantes ouvem, com supressão e
    // ganho já aplicados. Testar a captura crua, como era antes, dava um
    // retorno bonito e enganoso: a pessoa se ouvia bem e mesmo assim
    // chegava filtrado demais (ou nem chegava) do outro lado.
    const pipelineStream = await ensureLocalMicStream()
    if (pipelineStream && state.micMuted) {
      toast('Seu microfone está mutado — desmute para ouvir o teste.')
    }
    // Sem cadeia (permissão negada, Web Audio indisponível) o teste ainda
    // vale como "meu microfone chega em algum lugar?": cai na captura crua.
    micTestStream = pipelineStream
      || await navigator.mediaDevices.getUserMedia({ audio: state.micDeviceId ? { deviceId: { exact: state.micDeviceId } } : true })
    // Só paramos a captura no stop se ela foi criada AQUI — parar a stream
    // da cadeia deixaria a pessoa muda na sala inteira.
    micTestOwnsStream = micTestStream !== pipelineStream

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

    // Duas MediaStreamAudioSourceNode sobre a MESMA stream no mesmo
    // contexto é instável no Chromium (a segunda fica muda em vez de dar
    // erro — ver getRemoteVoiceSource em speaking-detection.js). Como a
    // stream da cadeia já tem uma fonte viva, a do analisador local, o
    // medidor reaproveita aquele analisador em vez de abrir outro.
    micTestAnalyser = getLocalVoiceAnalyser()
    if (!micTestAnalyser) {
      const ctx = getVoiceAudioContext()
      // Guardado pra ser desconectado no stopMicTest — sem isso cada teste
      // deixava mais uma fonte pendurada no contexto de voz.
      micTestSource = ctx.createMediaStreamSource(micTestStream)
      micTestAnalyser = ctx.createAnalyser()
      micTestAnalyser.fftSize = 256
      micTestSource.connect(micTestAnalyser)
    }

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
  if (micTestSource) {
    try { micTestSource.disconnect() } catch { /* já desconectado */ }
    micTestSource = null
  }
  if (micTestOwnsStream) micTestStream?.getTracks().forEach(t => t.stop())
  micTestOwnsStream = false
  micTestStream = null

  const audioEl = $('mic-test-audio')
  audioEl.pause()
  audioEl.srcObject = null

  $('btn-test-mic').textContent = 'Testar microfone e saída'
  $('mic-test-meter').classList.add('hidden')
  $('mic-test-meter-fill').style.width = '0%'
}
