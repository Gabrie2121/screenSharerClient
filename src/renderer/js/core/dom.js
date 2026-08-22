/* ═══════════════════════════════════════════════════════════════
   HELPERS DE DOM
═══════════════════════════════════════════════════════════════ */
export const $ = (id) => document.getElementById(id)

export function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'))
  $(`screen-${name}`).classList.add('active')
}
