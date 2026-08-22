import { state } from './state.js'

/* ═══════════════════════════════════════════════════════════════
   AVISOS SONOROS
   Registro central de sons por NOME. Antes existia um único `shareSound`
   solto dentro de toast.js, tocado só quando OUTRA pessoa começava a
   compartilhar — não tocava quando era você, não tinha som de parada, nem
   liga/desliga, nem volume, e o arquivo estava chumbado no código.

   Cada entrada é um placeholder: se o arquivo não existir em disco, o
   `error` do <audio> marca a entrada como indisponível e as chamadas
   seguintes viram no-op silencioso. É de propósito — dá pra ir trocando os
   arquivos de src/assets/sounds/ um a um sem quebrar nada enquanto os
   definitivos não chegam.

   `cut` existe porque os arquivos costumam durar mais do que um aviso
   deveria: toca o começo e corta. (O holy.mp3, o único som "de verdade"
   hoje, tem vários segundos — só o começo interessa.)
═══════════════════════════════════════════════════════════════ */
const SOUNDS = {
  // Caminhos relativos a ESTE arquivo (src/renderer/js/core/sounds.js).
  'share-start': { src: '../../../assets/holy.mp3',              cut: 1000 },
  'share-stop':  { src: '../../../assets/sounds/share-stop.mp3', cut: 1000 },
  'user-join':   { src: '../../../assets/sounds/user-join.mp3',  cut: 1200 },
  'user-leave':  { src: '../../../assets/sounds/user-leave.mp3', cut: 1200 },
  'camera-on':   { src: '../../../assets/sounds/camera-on.mp3',  cut: 1000 },
}

// { nome: { audio, cut, cutTimer, unavailable } } — montado sob demanda,
// pra não baixar/decodificar cinco arquivos no boot só por existirem.
const loaded = {}

function getSound(name) {
  const def = SOUNDS[name]
  if (!def) {
    console.warn(`[SOM] Som desconhecido: ${name}`)
    return null
  }

  if (!loaded[name]) {
    const audio = new Audio(new URL(def.src, import.meta.url).href)
    const entry = { audio, cut: def.cut, cutTimer: null, unavailable: false }
    // Placeholder que ainda não existe em disco: marca e nunca mais tenta.
    audio.addEventListener('error', () => {
      entry.unavailable = true
      console.info(`[SOM] Placeholder ausente para "${name}" — seguindo em silêncio.`)
    })
    loaded[name] = entry
  }

  return loaded[name]
}

export function playSound(name) {
  if (!state.soundsEnabled) return

  const entry = getSound(name)
  if (!entry || entry.unavailable) return

  try {
    entry.audio.volume = Math.max(0, Math.min(1, state.soundsVolume / 100))
    entry.audio.currentTime = 0
    entry.audio.play().catch((err) => {
      // NotSupportedError = arquivo inexistente/ilegível (o mesmo caso do
      // listener de 'error' acima, só que por outro caminho).
      if (err?.name === 'NotSupportedError') entry.unavailable = true
      else console.warn(`[SOM] Falha ao tocar "${name}":`, err)
    })

    clearTimeout(entry.cutTimer)
    entry.cutTimer = setTimeout(() => {
      entry.audio.pause()
      entry.audio.currentTime = 0
    }, entry.cut)
  } catch (err) {
    console.warn(`[SOM] Falha ao tocar "${name}":`, err)
  }
}

// Prévia usada pelo slider de volume nas configurações — sem ela a pessoa
// mexe no volume às cegas e só descobre o resultado na próxima vez que
// alguém compartilhar.
export function previewSound() {
  playSound('share-start')
}
