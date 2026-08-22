const { app, Tray, Menu } = require('electron')
const path = require('path')
const { getMainWindow, setQuitting } = require('./window.js')

let tray = null

function createTray() {
  tray = new Tray(path.join(__dirname, '..', 'assets', 'icon.ico'))
  tray.setToolTip('ShareSync')

  // Mesmo caminho usado pelo 'second-instance' em src/main.js: a janela pode
  // estar escondida (X → bandeja) OU minimizada, e show() sozinho não
  // desminimiza — sem o restore() o clique na bandeja parecia não fazer nada.
  const showWindow = () => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir ShareSync', click: showWindow },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        setQuitting(true)
        app.quit()
      },
    },
  ]))
  tray.on('click', showWindow)
  tray.on('double-click', showWindow)
}

module.exports = { createTray }
