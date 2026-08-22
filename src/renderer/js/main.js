/* ═══════════════════════════════════════════════════════════════
   ShareSync — Renderer (entry point)
   Responsabilidades:
   - Conecta ao backend via WebSocket
   - Gerencia sinalização WebRTC (offer/answer/ICE)
   - Exibe streams de quem o usuário escolher assistir
   - Permite compartilhar a própria tela

   Cada módulo abaixo se registra sozinho (event listeners, estado inicial
   a partir do localStorage) só de ser importado — a ordem aqui é a mesma
   em que as seções apareciam no antigo app.js monolítico. Ver core/state.js
   pro estado compartilhado e o README de cada pasta (voice/, webrtc/) pros
   detalhes de cada fluxo.
═══════════════════════════════════════════════════════════════ */

// Base — estado, DOM, log, toasts, ICE (sem efeito colateral próprio,
// só disponibilizam helpers pros módulos abaixo).
import './core/state.js'
import './core/dom.js'
import './core/logger.js'
import './core/toast.js'
import './core/ice-config.js'

// Janela + tela de login
import './titlebar.js'
import './login.js'

// Conexão com o servidor e sinalização
import './websocket.js'
import './ping.js'

// Sala: participantes, ações da sala, cards de stream, layout do palco
import './participants.js'
import './room-actions.js'
import './stream-cards.js'
import './stage-layout.js'
import './snapshot.js'

// Compartilhamento de tela (WebRTC)
import './webrtc/screen-share-peers.js'
import './webrtc/capture.js'

// Chat de voz
import './voice/audio-context.js'
import './voice/noise-suppression.js'
import './voice/mic.js'
import './voice/peers.js'
import './voice/volume.js'
import './voice/speaking-detection.js'
import './voice/device-settings.js'

// Modal de configurações (autovisualização, qualidade padrão, tabs)
import './settings-modal.js'
