import { $ } from '../core/dom.js'
import { state, PARTICIPANT_VOLUMES_KEY, MASTER_VOLUME_KEY } from '../core/state.js'
import { getVoiceAudioContext } from './audio-context.js'
import { remoteVoiceSources } from './speaking-detection.js'

/* ═══════════════════════════════════════════════════════════════
   AMPLIFICADOR DE VOZ — GainNode por participante, só quando precisa
   HTMLMediaElement.volume só aceita 0–1 (0–100%): jogar 1.5 ali dá exceção,
   e a rota "GainNode → MediaStreamDestination → novo srcObject no <audio>"
   (as duas tentativas anteriores) mostrou ser instável nesse app — em vez
   de só falhar acima de 100%, chegou a silenciar TODA a saída de voz. Por
   isso a amplificação agora nem passa pelo <audio>: uma cadeia
   GainNode→DynamicsCompressorNode (o compressor evita estourar perto de
   200%) liga direto em AudioContext.destination — o jeito mais padrão e
   testado de dar ganho real com Web Audio, sem depender de reempacotar o
   som numa stream nova pra tocar de novo num elemento. O <audio> cru (ver
   ontrack em voice/peers.js) nunca muda de stream; só é mutado enquanto a
   cadeia amplificada está ativa, pra não ouvir os dois ao mesmo tempo.
   Usa a MESMA fonte compartilhada do analisador (ver getRemoteVoiceSource
   em speaking-detection.js) — nunca cria uma segunda fonte pra mesma stream.
═══════════════════════════════════════════════════════════════ */
// voiceGainNodes: uid -> { source, gain, compressor, connected }
const voiceGainNodes = {}

function setupVoiceAmplifier(uid) {
  const entry = remoteVoiceSources[uid]
  if (!entry) return null // fonte ainda não existe — setupRemoteVoiceAnalyser roda antes disso no ontrack
  try {
    const ctx = getVoiceAudioContext()
    const gain = ctx.createGain()
    const compressor = ctx.createDynamicsCompressor()
    entry.source.connect(gain)
    gain.connect(compressor)
    const chain = { source: entry.source, gain, compressor, connected: false }
    voiceGainNodes[uid] = chain
    return chain
  } catch (err) {
    console.warn(`[VOICE AMP] Falha ao montar cadeia de ganho para ${uid}, ficando limitado a 100%:`, err)
    return null
  }
}

export function removeVoiceAmplifier(uid) {
  const chain = voiceGainNodes[uid]
  if (!chain) return
  // Só desconecta a ligação fonte→ganho — a fonte é compartilhada com o
  // analisador de "quem está falando" (ver getRemoteVoiceSource), então um
  // disconnect() sem alvo na fonte cortaria a análise de voz junto.
  try { chain.source.disconnect(chain.gain) } catch { /* já desconectado */ }
  try { chain.gain.disconnect() } catch { /* já desconectado */ }
  try { chain.compressor.disconnect() } catch { /* já desconectado (compressor→destination) */ }
  delete voiceGainNodes[uid]
}

/* ═══════════════════════════════════════════════════════════════
   VOLUME POR PARTICIPANTE (local — não afeta o que os outros ouvem)
   Vai de 0% a 200%: 100% é o volume original recebido, e dali pra cima
   amplifica de verdade (não é só "desmutar mais alto") via GainNode acima.
═══════════════════════════════════════════════════════════════ */
export function getParticipantVolume(uid) {
  return state.participantVolumes[uid] ?? 100
}

// Persistência do volume por NOME — sobrevive a reconexões, novas salas e
// reaberturas do app (diferente de state.participantVolumes, que é indexado
// pelo id de socket da sessão atual e é descartado ao sair da sala).
function loadVolumesByName() {
  try {
    return JSON.parse(localStorage.getItem(PARTICIPANT_VOLUMES_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveVolumeByName(username, vol) {
  if (!username) return
  const map = loadVolumesByName()
  map[username] = vol
  localStorage.setItem(PARTICIPANT_VOLUMES_KEY, JSON.stringify(map))
}

// Chamado sempre que um participante aparece na sala (room-info/user-joined)
// — recupera o volume salvo da última vez que ouvimos essa pessoa (por
// nome) e já inicializa participantVolumes/participantLastVolume com ele,
// pra applyVoiceVolume não usar o padrão 100% à toa.
export function seedParticipantVolume(uid, username) {
  const saved = loadVolumesByName()[username]
  if (saved == null) return
  state.participantVolumes[uid] = saved
  state.participantLastVolume[uid] = saved > 0 ? saved : 100
}

export function applyVoiceVolume(uid) {
  const audioEl = state.voiceAudioEls[uid]
  const vol = getParticipantVolume(uid)
  const effective = (state.masterVolume / 100) * (vol / 100)
  const ctx = getVoiceAudioContext()

  if (effective > 1) {
    // Precisa de ganho de verdade — o <audio> sozinho não passa de 100%.
    let chain = voiceGainNodes[uid]
    if (!chain) chain = setupVoiceAmplifier(uid)

    if (chain) {
      if (!chain.connected) {
        chain.compressor.connect(ctx.destination)
        chain.connected = true
      }
      chain.gain.gain.setTargetAtTime(effective, ctx.currentTime, 0.01)
      // O <audio> cru continua tocando a stream original por baixo — muta
      // ele aqui pra não somar com a cópia amplificada que agora sai
      // direto pelo AudioContext.destination.
      if (audioEl) audioEl.muted = true
    } else if (audioEl) {
      // Web Audio indisponível — melhor esforço, sem passar de 100%.
      audioEl.muted = false
      audioEl.volume = 1
    }
  } else {
    // Até 100%: só o <audio> cru toca, direto, sem depender do Web Audio —
    // igual sempre funcionou.
    const chain = voiceGainNodes[uid]
    if (chain?.connected) {
      try { chain.compressor.disconnect(ctx.destination) } catch { /* já desconectado */ }
      chain.connected = false
    }
    if (audioEl) {
      audioEl.volume = effective
      audioEl.muted = effective === 0
    }
  }

  updateParticipantVolIndicator(uid)
}

export function applyAllVoiceVolumes() {
  Object.keys(state.voiceAudioEls).forEach(applyVoiceVolume)
}

function updateParticipantVolIndicator(uid) {
  const el = document.querySelector(`.participant-item[data-uid="${uid}"] .participant-vol-indicator`)
  if (!el) return
  const vol = getParticipantVolume(uid)
  // Acima de 100% é amplificação de verdade (ganho > 1×, ver
  // setupVoiceAmplifier) — o ícone de megafone deixa isso visível de longe,
  // sem precisar abrir o popover pra ver o número.
  el.textContent = vol === 0 ? '🔇' : (vol > 100 ? '📢' : '🔊')
  el.title = vol === 0 ? 'Mutado — clique para ajustar' : `Volume: ${vol}% — clique para ajustar`
}

/* ═══════════════════════════════════════════════════════════════
   POPOVER DE VOLUME (mesmo slider .vol-icon/.vol-slider dos cards de
   stream) — painel fixo (não preso à lista, que tem scroll próprio),
   posicionado ao lado do participante clicado.
═══════════════════════════════════════════════════════════════ */
let volumePopoverUid = null

export function toggleParticipantVolumePopover(uid, li) {
  const popover = $('participant-volume-popover')
  if (volumePopoverUid === uid && !popover.classList.contains('hidden')) {
    closeParticipantVolumePopover()
  } else {
    openParticipantVolumePopover(uid, li)
  }
}

function openParticipantVolumePopover(uid, li) {
  const popover = $('participant-volume-popover')
  const rect = li.getBoundingClientRect()
  popover.style.left = `${rect.right + 8}px`
  popover.style.top = `${rect.top}px`
  popover.classList.remove('hidden')
  volumePopoverUid = uid

  $('pv-username').textContent = state.users[uid]?.username || 'Participante'
  const vol = getParticipantVolume(uid)
  $('pv-slider').value = vol
  $('pv-value').textContent = `${vol}%`
  updatePvMuteIcon(vol)
}

export function closeParticipantVolumePopover() {
  $('participant-volume-popover').classList.add('hidden')
  volumePopoverUid = null
}

// Usado ao remover um participante da sala — só fecha o popover se ele
// era o participante em questão (não mexe se o popover aberto é de outro).
export function closeParticipantVolumePopoverIfOpenFor(uid) {
  if (volumePopoverUid === uid) closeParticipantVolumePopover()
}

function updatePvMuteIcon(vol) {
  const icon = $('pv-mute-btn')
  icon.textContent = vol === 0 ? '🔇' : (vol > 100 ? '📢' : '🔊')
  icon.classList.toggle('muted', vol === 0)
}

$('pv-slider').addEventListener('click', (e) => e.stopPropagation())
$('pv-slider').addEventListener('input', () => {
  if (!volumePopoverUid) return
  const v = Number($('pv-slider').value)
  if (v > 0) state.participantLastVolume[volumePopoverUid] = v
  state.participantVolumes[volumePopoverUid] = v
  saveVolumeByName(state.users[volumePopoverUid]?.username, v)
  applyVoiceVolume(volumePopoverUid)
  $('pv-value').textContent = `${v}%`
  updatePvMuteIcon(v)
})

$('pv-mute-btn').addEventListener('click', (e) => {
  e.stopPropagation()
  if (!volumePopoverUid) return
  const current = getParticipantVolume(volumePopoverUid)
  if (current > 0) {
    state.participantLastVolume[volumePopoverUid] = current
    state.participantVolumes[volumePopoverUid] = 0
  } else {
    state.participantVolumes[volumePopoverUid] = state.participantLastVolume[volumePopoverUid] || 100
  }
  const newVol = state.participantVolumes[volumePopoverUid]
  saveVolumeByName(state.users[volumePopoverUid]?.username, newVol)
  applyVoiceVolume(volumePopoverUid)
  $('pv-slider').value = newVol
  $('pv-value').textContent = `${newVol}%`
  updatePvMuteIcon(newVol)
})

$('participant-volume-popover').addEventListener('click', (e) => e.stopPropagation())

// Clicar fora do popover (e fora de qualquer participante — que já tem seu
// próprio toggle) fecha o painel.
document.addEventListener('click', (e) => {
  const popover = $('participant-volume-popover')
  if (popover.classList.contains('hidden')) return
  if (e.target.closest('.participant-item')) return
  closeParticipantVolumePopover()
})

/* ═══════════════════════════════════════════════════════════════
   VOLUME GERAL (Configurações → Áudio)
   Vai só de 0% a 100% — quem amplifica além disso é o volume individual de
   cada participante (ver participantVolumes/applyVoiceVolume). Este aqui só
   abaixa tudo de uma vez, sem perder o ajuste fino de cada um.
═══════════════════════════════════════════════════════════════ */
const masterVolumeSlider = $('master-volume-slider')
const masterVolumeValue = $('master-volume-value')
masterVolumeSlider.value = state.masterVolume
masterVolumeValue.textContent = `${state.masterVolume}%`
masterVolumeSlider.addEventListener('input', () => {
  state.masterVolume = Number(masterVolumeSlider.value)
  masterVolumeValue.textContent = `${state.masterVolume}%`
  localStorage.setItem(MASTER_VOLUME_KEY, String(state.masterVolume))
  applyAllVoiceVolumes()
})
