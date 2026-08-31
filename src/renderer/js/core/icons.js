/* ═══════════════════════════════════════════════════════════════
   ÍCONES — SVG inline, fonte única

   Antes cada ícone da interface era um emoji (🎤 📷 🖥️ ⚙ ⛶ 🔊…) escrito
   direto no HTML ou em textContent. Emoji é decidido pela fonte do
   sistema: vem colorido, com peso e altura próprios de cada glifo, e
   desalinha do resto — por isso os botões pareciam de tamanhos diferentes
   mesmo com a mesma caixa. Estes aqui são traçados que herdam
   `currentColor` e o tamanho da caixa, então acompanham o estado do botão
   (hover, ativo, mutado) como qualquer outro elemento.

   Uso:
   - no HTML:  <span class="icon" data-icon="mic"></span>
               (preenchido no boot por renderIcons — ver js/main.js)
   - no JS:    innerHTML com iconSvg('mic'), ou setIcon(el, 'mic-off')

   Traçados no estilo do Feather (24x24, stroke 2, pontas arredondadas).
═══════════════════════════════════════════════════════════════ */

// Ícones desenhados com preenchimento em vez de traço (formas sólidas).
const FILLED = new Set(['play', 'stop', 'dot'])

const ICONS = {
  mic: '<path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>',
  'mic-off': '<line x1="3" y1="3" x2="21" y2="21"/><path d="M9 9.3V11a3 3 0 0 0 4.5 2.6"/><path d="M15 10.5V5a3 3 0 0 0-5.8-1.1"/><path d="M17 15.2A7 7 0 0 1 5 11v-1"/><path d="M19 10v1a7 7 0 0 1-.2 1.6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>',
  camera: '<polygon points="22 8 16 12 22 16 22 8"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  'camera-off': '<line x1="3" y1="3" x2="21" y2="21"/><path d="M15 15v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1"/><path d="M9.5 6H13a2 2 0 0 1 2 2v2.5l7-3.5v9"/>',
  screen: '<rect x="2" y="4" width="20" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><polyline points="9 10.5 12 7.5 15 10.5"/><line x1="12" y1="7.5" x2="12" y2="14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
  fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/>',
  'fullscreen-exit': '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/>',
  pip: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 15 L16 8"/><path d="M11 8 H16 V13"/>',
  volume: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  'volume-low': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
  'volume-off': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/>',
  hangup: '<path d="M10.7 13.3a16 16 0 0 0 3.4 2.6l1.3-1.3a2 2 0 0 1 2.1-.4 12.8 12.8 0 0 0 2.8.7 2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.4 19.4 0 0 1-3.3-2.7"/><path d="M5.4 13.6A19.8 19.8 0 0 1 2.3 5 2 2 0 0 1 4.1 3h3a2 2 0 0 1 2 1.7 12.8 12.8 0 0 0 .7 2.8 2 2 0 0 1-.4 2.1L8.1 10"/><line x1="22" y1="2" x2="2" y2="22"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  play: '<path d="M6 4.5v15a1 1 0 0 0 1.5.87l12-7.5a1 1 0 0 0 0-1.74l-12-7.5A1 1 0 0 0 6 4.5z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  dot: '<circle cx="12" cy="12" r="5"/>',
  logo: '<path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z"/><path d="M12 8.5 16 11v4l-4 2.5L8 15v-4z" opacity=".55"/>',
  signal: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-3.6-.7L3 21l1.9-5A8.2 8.2 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/>',
  send: '<path d="M21.5 12 3 4.5l3 7.5-3 7.5z"/><line x1="6" y1="12" x2="21.5" y2="12"/>',
  paperclip: '<path d="M21.4 11.05 12.2 20.2a5.5 5.5 0 0 1-7.8-7.8l9.2-9.15a3.7 3.7 0 0 1 5.2 5.2l-9.2 9.15a1.8 1.8 0 0 1-2.6-2.6l8.5-8.45"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  trash: '<polyline points="3 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>',
  'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
}

// Ícone de volume por faixa: mudo, normal, ou amplificado acima de 100%
// (ver applyVoiceVolume em voice/volume.js — acima de 100% é ganho de
// verdade, não só "mais alto"). Mora aqui, e não em participants.js, porque
// os dois lugares que mostram esse ícone (a lista de participantes e o
// popover de volume) se importam mutuamente — o nome do ícone é a única
// coisa que os dois precisam dividir.
export function volumeIconName(vol) {
  if (vol === 0) return 'volume-off'
  return vol > 100 ? 'volume' : 'volume-low'
}

export function iconSvg(name, extraClass = '') {
  const body = ICONS[name]
  if (!body) {
    console.warn(`[ICON] Ícone desconhecido: ${name}`)
    return ''
  }
  const filled = FILLED.has(name)
  return `<svg class="icon ${extraClass}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"`
    + ` fill="${filled ? 'currentColor' : 'none'}" stroke="${filled ? 'none' : 'currentColor'}"`
    + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + `${body}</svg>`
}

// Troca o ícone de um elemento já existente (botões que mudam de estado,
// como mutar/desmutar o microfone).
export function setIcon(el, name) {
  if (el) el.innerHTML = iconSvg(name)
}

// Preenche todo [data-icon] de uma subárvore. Chamado uma vez no boot e de
// novo por quem gera markup em runtime (cards de stream, participantes).
export function renderIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = iconSvg(el.dataset.icon)
  })
}
