import { RnnoiseWorkletNode, loadRnnoise } from '../../../../node_modules/@sapphi-red/web-noise-suppressor/dist/index.js'
import { $ } from '../core/dom.js'
import { appLog } from '../core/logger.js'
import { toast } from '../core/toast.js'
import { state, NOISE_SUPPRESSION_KEY, NOISE_INTENSITY_KEY } from '../core/state.js'

/* ═══════════════════════════════════════════════════════════════
   CADEIA DE ÁUDIO DO MICROFONE (RNNoise)

   Este módulo é dono de TODO o caminho do microfone local antes de ele
   sair pela rede. A saída é uma MediaStream de track ESTÁVEL: a mesma
   track vale pra sessão inteira, não importa quantas vezes a pessoa troque
   de microfone ou ligue/desligue a supressão.

       entrada (mic cru)
            ├─→ dryDelay ─→ dryGain ─┐
            └─→ rnnoise ─→ wetGain ──┴─→ makeup ─→ limiter ─→ destino → track

   POR QUE ASSIM (o bug que isso conserta): a versão anterior derrubava e
   remontava o AudioContext inteiro a cada troca de dispositivo E a cada
   liga/desliga da supressão — e derrubava ANTES de montar o substituto.
   Como `state.localMicStream` era a stream do MediaStreamDestinationNode
   daquele contexto, fechar o contexto matava a track que já estava sendo
   enviada aos outros participantes. Bastava qualquer falha no meio do
   caminho (ou o Chromium recusar mais um AudioContext, que tem limite por
   documento) pra ficar sem microfone até reiniciar o app, sem mensagem
   nenhuma — exatamente o "ativo de novo e ele desliga o microfone" do
   bugs,MD. Agora o contexto e a track de saída nascem uma vez só:
   - trocar de microfone  → troca só o nó de origem (replaceMicInput)
   - ligar/desligar RNNoise → só faz crossfade de ganho (setSuppressionEnabled)
   Nenhum dos dois recaptura áudio, recria contexto nem troca a track — e
   por isso nenhum dos dois consegue deixar a pessoa muda.
═══════════════════════════════════════════════════════════════ */

const WASM_URLS = {
  url: new URL('../../../../node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise.wasm', import.meta.url).href,
  simdUrl: new URL('../../../../node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise_simd.wasm', import.meta.url).href,
}
const WORKLET_URL = new URL('../../../../node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise/workletProcessor.js', import.meta.url).href

// RNNoise trabalha em quadros de 480 amostras a 48kHz (10ms), então o
// caminho filtrado sai atrasado esse tanto em relação ao cru. Sem alinhar,
// misturar os dois (qualquer intensidade < 100%) soma o mesmo áudio
// dessincronizado — ouve-se como eco metálico/flanger.
const RNNOISE_LATENCY_S = 0.01

// Compensa a perda de volume do RNNoise (ele corta energia junto com o
// ruído). Sem isso a voz sai bem mais baixa com a supressão ligada — a
// primeira queixa registrada em bugs,MD.
const MAKEUP_GAIN = 1.6

let ctx = null              // AudioContext do microfone — criado UMA vez
let sourceNode = null       // origem atual (muda ao trocar de dispositivo)
let rnnoiseNode = null
let dryDelay = null
let dryGain = null
let wetGain = null
let makeupGain = null
let limiter = null
let destination = null      // dono da track estável de saída
let rnnoiseAvailable = false
let buildPromise = null

export function isSuppressionActive() {
  return rnnoiseAvailable && state.noiseSuppression
}

/* ── Contexto + nós fixos (tudo que não depende do dispositivo) ── */
async function ensureGraph() {
  if (ctx) return true
  if (!buildPromise) {
    buildPromise = (async () => {
      // 48kHz é premissa do RNNoise (ver o próprio pacote) — pedir ao
      // contexto evita um reamostrador no meio do caminho.
      ctx = new AudioContext({ sampleRate: 48000 })

      dryDelay = ctx.createDelay(0.05)
      dryDelay.delayTime.value = RNNOISE_LATENCY_S
      dryGain = ctx.createGain()
      wetGain = ctx.createGain()
      makeupGain = ctx.createGain()
      makeupGain.gain.value = 1 // valor real definido por applyMix (acompanha a intensidade)

      // Limitador — o makeup acima levanta o sinal, e um grito perto do
      // mic estouraria sem isso. Ratio alto + threshold perto do teto é um
      // limitador, não um compressor de "esmagar" a dinâmica da voz.
      limiter = ctx.createDynamicsCompressor()
      limiter.threshold.value = -3
      limiter.knee.value = 0
      limiter.ratio.value = 20
      limiter.attack.value = 0.003
      limiter.release.value = 0.25

      destination = ctx.createMediaStreamDestination()

      dryDelay.connect(dryGain).connect(makeupGain)
      wetGain.connect(makeupGain)
      makeupGain.connect(limiter).connect(destination)

      // RNNoise é opcional: se o worklet/wasm não carregar, a cadeia
      // continua de pé pelo caminho seco e o microfone funciona igual —
      // só sem filtro (ver applyMix, que força seco quando indisponível).
      try {
        await ctx.audioWorklet.addModule(WORKLET_URL)
        rnnoiseNode = new RnnoiseWorkletNode(ctx, {
          maxChannels: 1,
          wasmBinary: await loadRnnoise(WASM_URLS),
        })
        rnnoiseNode.connect(wetGain)
        rnnoiseAvailable = true
        appLog('INFO', 'RNNoise carregado')
      } catch (err) {
        rnnoiseAvailable = false
        appLog('WARN', `RNNoise indisponível, seguindo com o microfone sem filtro: ${err.message}`)
      }
    })().catch((err) => {
      // Nem o contexto subiu — desfaz tudo pra uma próxima tentativa poder
      // começar do zero (e pra ensureMicOutputStream cair no plano B).
      buildPromise = null
      ctx = null
      throw err
    })
  }
  await buildPromise
  return !!ctx
}

/* ── Monta (ou reaproveita) a cadeia e devolve a stream de saída ──
   `inputStream` é a captura crua do getUserMedia. Devolve a MESMA
   MediaStream em todas as chamadas seguintes — quem já enviou essa track
   pra um peer nunca precisa trocá-la. */
export async function buildMicPipeline(inputStream) {
  const ok = await ensureGraph().catch(() => false)
  // Sem Web Audio, o melhor que dá é mandar o microfone cru — pior
  // qualidade, mas com voz. Ficar mudo nunca é uma opção aceitável aqui.
  if (!ok) return inputStream

  replaceMicInput(inputStream)
  applyMix()
  await resumeContext()
  return destination.stream
}

/* ── Troca só a origem: a track de saída (e portanto o que os peers já
   estão recebendo) continua exatamente a mesma. É isso que faz trocar de
   microfone no meio de uma conversa não exigir replaceTrack nem
   renegociação. ── */
export function replaceMicInput(inputStream) {
  if (!ctx || !inputStream) return
  if (sourceNode) {
    try { sourceNode.disconnect() } catch { /* já desconectado */ }
  }
  sourceNode = ctx.createMediaStreamSource(inputStream)
  sourceNode.connect(dryDelay)
  if (rnnoiseNode) sourceNode.connect(rnnoiseNode)
}

/* ── Um AudioContext suspenso não produz som nenhum: a track de saída
   existe, os peers a recebem, e sai silêncio. O Chromium suspende sozinho
   em várias situações (contexto criado sem gesto do usuário, máquina
   voltando do sleep), então além de retomar aqui, ficamos ouvindo o
   evento pra retomar de novo se acontecer no meio da conversa. ── */
async function resumeContext() {
  if (!ctx) return
  if (ctx.state === 'suspended') {
    try { await ctx.resume() } catch (err) { appLog('WARN', `Não foi possível retomar o áudio do microfone: ${err.message}`) }
  }
  if (!ctx.onstatechange) {
    ctx.onstatechange = () => {
      if (ctx?.state === 'suspended') ctx.resume().catch(() => {})
    }
  }
}

/* ── Mistura seco/filtrado — crossfade de potência constante (sen/cos).
   Com uma rampa linear os dois caminhos somariam ~-3dB no meio do curso e
   a voz "afundaria" no meio do slider. ── */
function applyMix() {
  if (!ctx) return
  const on = isSuppressionActive()
  const intensity = on ? Math.max(0, Math.min(100, state.noiseIntensity)) / 100 : 0
  const angle = intensity * Math.PI / 2
  const t = ctx.currentTime
  dryGain.gain.setTargetAtTime(Math.cos(angle), t, 0.015)
  wetGain.gain.setTargetAtTime(Math.sin(angle), t, 0.015)
  // O reforço acompanha a intensidade: ele existe pra repor o que o
  // RNNoise tirou, então com a supressão desligada não há o que repor —
  // levantar o microfone cru ali seria mexer num volume que ninguém pediu.
  makeupGain.gain.setTargetAtTime(1 + (MAKEUP_GAIN - 1) * intensity, t, 0.015)
}

export function updateNoiseIntensity() {
  applyMix()
}

/* ── Liga/desliga a supressão sem tocar na captura nem na track ── */
export function setSuppressionEnabled(enabled) {
  state.noiseSuppression = enabled
  localStorage.setItem(NOISE_SUPPRESSION_KEY, String(enabled))
  applyMix()

  // O Chromium tem a própria supressão de ruído na captura. Rodando as
  // duas em série a voz sai abafada e com trechos comidos — é a "supressão
  // que às vezes falha". Então: RNNoise ligado → a do navegador desligada,
  // e vice-versa. É best-effort: se applyConstraints falhar, o crossfade
  // acima já resolve o essencial.
  applyCaptureConstraints().catch(() => {})

  if (enabled && !rnnoiseAvailable) {
    toast('A supressão de ruído não pôde ser carregada — o microfone segue sem filtro.')
  }
}

/* ── Constraints da captura crua. Ganho automático e cancelamento de eco
   ficam SEMPRE com o navegador (o AGC é o que evita a voz baixa demais, e
   o cancelamento de eco é indispensável pra quem usa caixa de som). Só a
   supressão de ruído nativa é alternada, pra não empilhar com o RNNoise. ── */
export function micCaptureConstraints(deviceId) {
  return {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      autoGainControl: true,
      noiseSuppression: !isSuppressionActive(),
      channelCount: 1,
    },
    video: false,
  }
}

async function applyCaptureConstraints() {
  const track = state.localMicInputStream?.getAudioTracks?.()[0]
  if (!track) return
  await track.applyConstraints(micCaptureConstraints(state.micDeviceId).audio)
}

/* ── Retrato do estado da cadeia. Serve de diagnóstico quando alguém
   reclama que "o microfone não sai": diz se o contexto está rodando, se o
   RNNoise carregou e com que ganho cada caminho está no ar. ── */
export function micPipelineState() {
  return {
    contexto: ctx?.state || 'inexistente',
    sampleRate: ctx?.sampleRate || null,
    rnnoise: rnnoiseAvailable,
    supressao: state.noiseSuppression,
    intensidade: state.noiseIntensity,
    ganhoSeco: dryGain?.gain.value ?? null,
    ganhoFiltrado: wetGain?.gain.value ?? null,
    reforco: makeupGain?.gain.value ?? null,
    temOrigem: !!sourceNode,
  }
}

/* ── Só ao sair da sala de verdade (ver room-actions.js). Durante a
   sessão a cadeia nunca é destruída — era justamente isso que matava o
   microfone. ── */
export function destroyMicPipeline() {
  try { sourceNode?.disconnect() } catch { /* já desconectado */ }
  try { rnnoiseNode?.disconnect() } catch { /* já desconectado */ }
  rnnoiseNode?.destroy?.()
  if (ctx) {
    ctx.onstatechange = null
    ctx.close().catch(() => {})
  }
  ctx = null
  sourceNode = null
  rnnoiseNode = null
  dryDelay = null
  dryGain = null
  wetGain = null
  makeupGain = null
  limiter = null
  destination = null
  rnnoiseAvailable = false
  buildPromise = null
}

/* ═══════════════════════════════════════════════════════════════
   Configurações → Áudio: toggle + intensidade
═══════════════════════════════════════════════════════════════ */
const chkNoiseSuppression = $('chk-noise-suppression')
chkNoiseSuppression.checked = state.noiseSuppression
chkNoiseSuppression.onchange = () => setSuppressionEnabled(chkNoiseSuppression.checked)

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
