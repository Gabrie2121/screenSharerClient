# Sons de aviso — placeholders

Cada arquivo aqui é um **placeholder**. O registro em
`src/renderer/js/core/sounds.js` já referencia todos os nomes abaixo; se o
arquivo não existir, o som simplesmente não toca (a entrada é marcada como
indisponível na primeira tentativa e nunca mais é procurada). Nada quebra.

Para ativar um som, basta soltar o `.mp3` aqui com o nome exato:

| Arquivo           | Quando toca                                  |
|-------------------|----------------------------------------------|
| `share-stop.mp3`  | alguém (ou você) para de compartilhar a tela |
| `user-join.mp3`   | alguém entra na sala                         |
| `user-leave.mp3`  | alguém sai da sala                           |
| `camera-on.mp3`   | alguém liga a câmera                         |

O som de **começar a compartilhar** (`share-start`) já existe e aponta para
`src/assets/holy.mp3` — para trocá-lo, mude o caminho no registro ou
substitua o arquivo.

Todos são cortados no começo (ver `cut` no registro): não precisam ser
curtos, só ter um início bom.
