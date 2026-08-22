import { $ } from './core/dom.js'
import { appLog } from './core/logger.js'
import { showError, hideError } from './core/toast.js'
import { state, LAST_NAME_KEY, LAST_SERVER_KEY, LAST_ROOM_KEY } from './core/state.js'
import { connectWebSocket, prepareForNewConnection } from './websocket.js'

/* ═══════════════════════════════════════════════════════════════
   LOGIN
═══════════════════════════════════════════════════════════════ */
// Preenche nome/servidor/sala com os últimos usados (salvos em enterRoom)
// pra não precisar redigitar toda vez que o app abre — só sobrescreve o
// valor padrão do HTML se já houver algo salvo.
{
  const savedName = localStorage.getItem(LAST_NAME_KEY)
  if (savedName) $('input-name').value = savedName
  const savedServer = localStorage.getItem(LAST_SERVER_KEY)
  if (savedServer) $('input-server').value = savedServer
  const savedRoomId = localStorage.getItem(LAST_ROOM_KEY)
  if (savedRoomId) $('input-room-id').value = savedRoomId
}

// Troca o conteúdo do botão por um spinner + "Conectando…" enquanto tenta
// entrar na sala (some sozinho quando conecta ou dá erro — ver enterRoom).
function setButtonLoading(btn, loading) {
  if (loading) {
    if (btn.dataset.originalHtml === undefined) btn.dataset.originalHtml = btn.innerHTML
    btn.innerHTML = '<span class="spinner spinner-sm"></span> Conectando…'
  } else if (btn.dataset.originalHtml !== undefined) {
    btn.innerHTML = btn.dataset.originalHtml
  }
  btn.disabled = loading
}

export function setLoginButtonsDisabled(disabled) {
  setButtonLoading($('btn-create-room'), disabled)
  setButtonLoading($('btn-join-room'), disabled)
}

$('btn-create-room').onclick = async () => {
  const name = $('input-name').value.trim()
  const server = $('input-server').value.trim()
  if (!name) return showError('Digite seu nome para continuar.')
  hideError()

  // Cria sala via REST
  setLoginButtonsDisabled(true)
  const httpUrl = server.replace(/^ws/, 'http')
  try {
    const res = await fetch(`${httpUrl}/api/rooms/`, { method: 'POST' })
    const data = await res.json()
    enterRoom(name, server, data.room_id)
  } catch {
    showError('Não foi possível conectar ao servidor. Verifique o endereço.')
    setLoginButtonsDisabled(false)
  }
}

$('btn-join-room').onclick = () => {
  const name   = $('input-name').value.trim()
  const server = $('input-server').value.trim()
  const roomId = $('input-room-id').value.trim()
  if (!name)   return showError('Digite seu nome.')
  if (!roomId) return showError('Digite o código da sala.')
  hideError()
  setLoginButtonsDisabled(true)
  enterRoom(name, server, roomId)
}

/* ═══════════════════════════════════════════════════════════════
   ENTRAR NA SALA
═══════════════════════════════════════════════════════════════ */
function enterRoom(name, server, roomId) {
  state.myName   = name
  state.serverUrl = server
  state.roomId   = roomId
  prepareForNewConnection()

  // Guarda pra preencher os campos sozinho na próxima vez que o app abrir
  // (ver preenchimento logo acima, no carregamento do módulo).
  localStorage.setItem(LAST_NAME_KEY, name)
  localStorage.setItem(LAST_SERVER_KEY, server)
  localStorage.setItem(LAST_ROOM_KEY, roomId)

  appLog('INFO', `Entrando na sala ${roomId} como "${name}" (servidor: ${server})`)
  connectWebSocket()
}
